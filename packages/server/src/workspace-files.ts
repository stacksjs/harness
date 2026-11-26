import type { FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'

const PREVIEW_BYTES = 256 * 1024
const PREVIEW_LINES = 5000
const DIRECTORY_PAGE = 200
const DIRECTORY_LIMIT = 25_000
const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }

export interface WorkspaceFileEntry {
  path: string
  name: string
  kind: 'directory' | 'file'
}

export interface WorkspaceFilePreview {
  path: string
  size: number
  kind: 'text' | 'html' | 'pdf' | 'image' | 'binary'
  text?: string
  truncated?: boolean
}

export async function resolveWorkspaceEntry(root: string, path: string): Promise<string | null> {
  if (path.includes('\0') || isAbsolute(path) || path.split(/[\\/]/u).some(part => /^(?:\.{1,2}|\.git|\.hg|\.svn)$/iu.test(part))) return null
  try {
    const target = await realpath(join(root, path))
    const within = relative(root, target)
    if ((path && !within) || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)
      || within.split(sep).some(part => /^\.(?:git|hg|svn)$/iu.test(part))) return null
    return target
  }
  catch { return null }
}

function unavailable(status = 404): Response {
  return Response.json({ error: 'The workspace file or folder is unavailable.' }, { status, headers })
}

async function listFolder(root: string, path: string, params: URLSearchParams): Promise<Response> {
  const folder = await resolveWorkspaceEntry(root, path)
  const handle = folder ? await opendir(folder).catch(() => null) : null
  if (!handle) return unavailable()
  const entries: WorkspaceFileEntry[] = []
  let inspected = 0
  for await (const entry of handle) {
    if (++inspected > DIRECTORY_LIMIT) break
    if (/^\.(?:git|hg|svn)$/iu.test(entry.name) || (!entry.isDirectory() && !entry.isFile())) continue
    entries.push({ path: path ? `${path}/${entry.name}` : entry.name, name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'directory' ? -1 : 1))
  const offset = Math.max(0, Math.min(DIRECTORY_LIMIT, Number.parseInt(params.get('offset') ?? '0', 10) || 0))
  const next = offset + DIRECTORY_PAGE
  return Response.json({ entries: entries.slice(offset, next), next: next < entries.length ? next : null, truncated: inspected > DIRECTORY_LIMIT }, { headers })
}

function fileMedia(data: Buffer): string | null {
  if (data.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'application/pdf'
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return 'image/jpeg'
  if (/^GIF8[79]a/u.test(data.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

async function readFilePreview(file: FileHandle, path: string, size: number): Promise<{ media: string | null, preview: WorkspaceFilePreview }> {
  const data = Buffer.alloc(Math.min(size, PREVIEW_BYTES + 1))
  const { bytesRead } = await file.read(data, 0, data.length, 0)
  const media = fileMedia(data.subarray(0, bytesRead))
  if (media) return { media, preview: { path, size, kind: media === 'application/pdf' ? 'pdf' : 'image' } }
  const bytes = data.subarray(0, Math.min(bytesRead, PREVIEW_BYTES))
  try {
    if (bytes.includes(0)) throw new Error('Binary data')
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: size > PREVIEW_BYTES })
    const lines = decoded.split(/\r?\n/u)
    const truncated = size > PREVIEW_BYTES || lines.length > PREVIEW_LINES
    const html = ['.html', '.htm'].includes(extname(path).toLowerCase())
    return { media: null, preview: { path, size, kind: html ? 'html' : 'text', text: lines.slice(0, PREVIEW_LINES).join('\n'), truncated } }
  }
  catch {
    return { media: null, preview: { path, size, kind: 'binary' } }
  }
}

function htmlResponse(text: string): Response {
  const source = new Response(text, { headers: {
    ...headers, 'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    'referrer-policy': 'no-referrer',
  } })
  return new HTMLRewriter()
    .on('script, iframe, object, embed, meta, base, link', { element: (element) => { element.remove() } })
    .on('a, area', { element: (element) => { element.removeAttribute('href'); element.removeAttribute('ping') } })
    .transform(source)
}

function mediaRange(range: string, size: number): { start: number, end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range)
  if (!match || (!match[1] && !match[2])) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
  return start < size && end >= start ? { start, end } : null
}

export async function respondWorkspaceFile(workspace: string, url: URL, request: Request): Promise<Response> {
  const path = url.searchParams.get('path') ?? ''
  const root = await realpath(workspace).catch(() => null)
  if (!root || path.length > 4096) return unavailable()
  if (url.pathname === '/workspace-files/tree') return listFolder(root, path, url.searchParams)
  const target = path ? await resolveWorkspaceEntry(root, path) : null
  if (!target) return unavailable()
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null)
  if (!file) return unavailable()
  let streaming = false
  try {
    const info = await file.stat()
    // Confirm the open handle still corresponds to the scoped path after any rename.
    const current = await resolveWorkspaceEntry(root, path)
    const checked = current ? await stat(current).catch(() => null) : null
    if (!info.isFile() || !checked || checked.dev !== info.dev || checked.ino !== info.ino) return unavailable()
    const download = url.pathname === '/workspace-files/download'
    const { media, preview } = download ? { media: null, preview: null } : await readFilePreview(file, path, info.size)
    if (url.pathname === '/workspace-files/preview') return Response.json(preview, { headers })
    if (preview?.kind === 'html' && !preview.truncated) return htmlResponse(preview.text ?? '')
    if (!download && !media) return unavailable(415)
    const name = basename(path)
    const fallbackFilename = name.replace(/[^\x20-\x7E]|["\\]/gu, '_')
    const filename = encodeURIComponent(name).replace(/['()*]/gu, char => '%' + char.charCodeAt(0).toString(16))
    const responseHeaders: Record<string, string> = {
      ...headers, 'content-type': media ?? 'application/octet-stream', 'accept-ranges': 'bytes',
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${fallbackFilename}"; filename*=UTF-8''${filename}`,
      'content-security-policy': "frame-ancestors 'self'",
    }
    const requested = request.headers.get('range')
    const range = requested ? mediaRange(requested, info.size) : null
    if (requested && !range) return new Response(null, { status: 416, headers: { ...responseHeaders, 'content-range': `bytes */${info.size}` } })
    if (range) responseHeaders['content-range'] = `bytes ${range.start}-${range.end}/${info.size}`
    responseHeaders['content-length'] = String(range ? range.end - range.start + 1 : info.size)
    const stream = Readable.toWeb(file.createReadStream(range ?? undefined)) as unknown as ReadableStream<Uint8Array<ArrayBuffer>>
    streaming = true
    return new Response(stream, { status: range ? 206 : 200, headers: responseHeaders })
  }
  finally { if (!streaming) await file.close() }
}
