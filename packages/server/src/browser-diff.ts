interface DiffLine {
  kind: 'context' | 'addition' | 'deletion'
  text: string
  before: number | null
  after: number | null
  newlineNote?: string
}

interface DiffHunk {
  header: string
  lines: DiffLine[]
}

interface DiffRow {
  id: number
  header?: string
  cells: (DiffLine | null)[]
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const gitEscapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

function patchPath(header: string): string | undefined {
  const token = header.slice(4).replace(/\t$/u, '')
  if (token === '/dev/null') return undefined
  if (!token.startsWith('"')) return token.slice(2)
  const bytes: number[] = []
  for (const part of token.slice(1, -1).matchAll(/\\([0-7]{3}|.)|([^\\]+)/gu)) {
    const escaped = part[1]
    if (escaped) bytes.push(gitEscapes[escaped] ?? Number.parseInt(escaped, 8))
    else for (const byte of encoder.encode(part[2])) bytes.push(byte)
  }
  return decoder.decode(new Uint8Array(bytes)).slice(2)
}

export function parseWorkspacePatch(patch: string): ReadonlyMap<string, DiffHunk[]> {
  const files = new Map<string, DiffHunk[]>()
  let original: string | undefined
  let current: string | undefined
  let before = 0
  let after = 0
  let hunk: DiffHunk | undefined

  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      original = undefined
      current = undefined
      hunk = undefined
    }
    else if (text.startsWith('@@ ')) {
      const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text)
      const path = current ?? original
      if (!range || path === undefined) continue
      before = Number(range[1])
      after = Number(range[2])
      hunk = { header: text, lines: [] }
      const hunks = files.get(path)
      if (hunks) hunks.push(hunk)
      else files.set(path, [hunk])
    }
    else if (!hunk) {
      if (text.startsWith('--- ')) original = patchPath(text)
      else if (text.startsWith('+++ ')) current = patchPath(text)
    }
    else {
      switch (text[0]) {
        case ' ': hunk.lines.push({ kind: 'context', before: before++, after: after++, text: text.slice(1) }); break
        case '-': hunk.lines.push({ kind: 'deletion', before: before++, after: null, text: text.slice(1) }); break
        case '+': hunk.lines.push({ kind: 'addition', before: null, after: after++, text: text.slice(1) }); break
        case '\\': {
          const previous = hunk.lines.at(-1)
          if (previous) previous.newlineNote = text.slice(2)
          break
        }
      }
    }
  }

  return files
}

export function workspaceDiffRows(hunks: DiffHunk[], split: boolean, limit: number): { rows: DiffRow[], more: boolean } {
  const rows: DiffRow[] = []
  for (const hunk of hunks) {
    if (rows.length === limit) return { rows, more: true }
    rows.push({ id: rows.length, header: hunk.header, cells: [] })
    let index = 0
    while (index < hunk.lines.length) {
      if (rows.length === limit) return { rows, more: true }
      const line = hunk.lines[index++]!
      if (split && (line.kind === 'deletion' || line.kind === 'addition')) {
        const deletions = line.kind === 'deletion' ? [line] : []
        const additions = line.kind === 'addition' ? [line] : []
        while (index < hunk.lines.length) {
          const next = hunk.lines[index]!
          if (next.kind === 'deletion') deletions.push(next)
          else if (next.kind === 'addition') additions.push(next)
          else break
          index++
        }
        const count = Math.max(deletions.length, additions.length)
        for (let offset = 0; offset < count; offset++) {
          if (rows.length === limit) return { rows, more: true }
          rows.push({ id: rows.length, cells: [deletions[offset] ?? null, additions[offset] ?? null] })
        }
      }
      else rows.push({ id: rows.length, cells: split ? [line, line] : [line] })
    }
  }

  return { rows, more: false }
}
