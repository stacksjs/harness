import type { InputAnswer, QuestionAttachment } from '@harness/contract'
import { MAX_QUESTION_ATTACHMENTS, MAX_QUESTION_FILE_BYTES, MAX_QUESTION_IMAGE_BYTES, MAX_QUESTION_TOTAL_IMAGE_BYTES } from '@harness/contract'
import { link, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u

type StoredAttachment = QuestionAttachment & { owner: string }

export class AttachmentError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

function readableName(name: string): string {
  const sanitized = name.trim().replace(/[<>:"\/\\|?*\u0000-\u001f\u007f]/gu, '_')
  let safe = ''
  let bytes = 0
  for (const character of sanitized) {
    bytes += Buffer.byteLength(character)
    if (bytes > 240) break
    safe += character
  }
  safe = safe.replace(/[. ]+$/u, '')
  if (!safe || /^metadata\.json$/iu.test(safe)) return 'attachment'
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(safe)) return '_' + safe
  return safe
}

function requestFolder(root: string, sessionId: number, requestId: string): string {
  return join(root, String(sessionId), new Bun.CryptoHasher('sha256').update(requestId).digest('hex'))
}

async function names(folder: string): Promise<string[]> {
  try { return await readdir(folder) }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
}

export class QuestionAttachments {
  private readonly mutations = new Map<string, Promise<unknown>>()

  constructor(private readonly root: string, private readonly subject = 'A question response') {}

  async serialize<T>(sessionId: number, requestId: string, action: () => Promise<T>): Promise<T> {
    const folder = requestFolder(this.root, sessionId, requestId)
    const task = (this.mutations.get(folder) ?? Promise.resolve()).then(action)
    const tail = task.catch(() => {})
    this.mutations.set(folder, tail)
    try { return await task }
    finally {
      if (this.mutations.get(folder) === tail) this.mutations.delete(folder)
    }
  }

  async upload(request: Request, sessionId: number, requestId: string, questionId: string, owner: string, name: string): Promise<QuestionAttachment> {
    const directory = requestFolder(this.root, sessionId, requestId)
    const type = request.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase() ?? ''
    const image = imageTypes.has(type)
    const limit = image ? MAX_QUESTION_IMAGE_BYTES : MAX_QUESTION_FILE_BYTES
    const advertised = request.headers.get('content-length')
    if (advertised !== null && Number(advertised) > limit) throw new AttachmentError('This file exceeds the attachment size limit.', 413)
    if (!request.body) throw new AttachmentError('Select a file to attach.')

    const id = crypto.randomUUID()
    const slot = join(directory, id)
    const filename = readableName(name)
    await this.serialize(sessionId, requestId, async () => {
      if ((await names(directory)).length >= MAX_QUESTION_ATTACHMENTS)
        throw new AttachmentError(`${this.subject} can contain up to 100 files.`, 409)
      // Reserve the slot before accepting another upload. In-flight uploads
      // count once, just like completed files.
      await mkdir(slot, { recursive: true, mode: 0o700 })
    })
    let saved = false
    try {
      const file = await open(join(slot, filename), 'wx', 0o600)
      const reader = request.body.getReader()
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > limit) throw new AttachmentError('This file exceeds the attachment size limit.', 413)
          await file.writeFile(chunk.value)
        }
        await file.sync()
      }
      finally {
        await reader.cancel().catch(() => {})
        await file.close()
      }
      const attachment = { id, questionId, name: filename, size, image }
      await writeFile(join(slot, 'metadata.json'), JSON.stringify({ ...attachment, owner }), { flag: 'wx', mode: 0o600 })
      saved = true
      return attachment
    }
    finally {
      if (!saved) await rm(slot, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async find(sessionId: number, requestId: string, id: string): Promise<StoredAttachment | undefined> {
    if (!uuidPattern.test(id)) return
    const path = join(requestFolder(this.root, sessionId, requestId), id, 'metadata.json')
    const attachment = await Bun.file(path).json().catch(() => undefined) as StoredAttachment | undefined
    if (attachment?.id === id && await Bun.file(this.path(sessionId, requestId, attachment)).exists()) return attachment
  }

  path(sessionId: number, requestId: string, attachment: QuestionAttachment): string {
    return join(requestFolder(this.root, sessionId, requestId), attachment.id, readableName(attachment.name))
  }

  async resolve(sessionId: number, requestId: string, answers: InputAnswer[], owner: string): Promise<QuestionAttachment[]> {
    const attachments: QuestionAttachment[] = []
    let imageBytes = 0
    for (const { questionId, attachmentIds } of answers) {
      for (const id of attachmentIds ?? []) {
        const stored = await this.find(sessionId, requestId, id)
        if (!stored || stored.questionId !== questionId || stored.owner !== owner)
          throw new AttachmentError('This attachment is unavailable for the question.')
        const { name, size, image } = stored
        if (image) imageBytes += size
        if (imageBytes > MAX_QUESTION_TOTAL_IMAGE_BYTES)
          throw new AttachmentError('The attached images exceed 80 MiB together.', 413)
        attachments.push({ id, questionId, name, size, image })
      }
    }
    return attachments
  }

  async draftFile(sessionId: number, requestId: string, id: string, owner: string): Promise<QuestionAttachment | undefined> {
    const stored = await this.find(sessionId, requestId, id)
    if (stored?.owner === owner) {
      const { questionId, name, size, image } = stored
      return { id, questionId, name, size, image }
    }
  }

  /** Import private host files into a draft. Existing matching IDs make a retry safe. */
  async linkDrafts(sessionId: number, requestId: string, owner: string, sources: Array<{ file: QuestionAttachment, path: string }>): Promise<QuestionAttachment[]> {
    return this.serialize(sessionId, requestId, async () => {
      const directory = requestFolder(this.root, sessionId, requestId)
      const created: string[] = []
      const files: QuestionAttachment[] = []
      let count = (await names(directory)).length
      try {
        for (const { file, path } of sources) {
          if (!uuidPattern.test(file.id)) throw new AttachmentError('An attachment reference is invalid.')
          const existing = await this.find(sessionId, requestId, file.id)
          if (existing) {
            if (existing.owner !== owner || existing.name !== file.name || existing.size !== file.size || existing.image !== file.image)
              throw new AttachmentError('A draft attachment conflicts with the stashed file.', 409)
          }
          else {
            if (count >= MAX_QUESTION_ATTACHMENTS) throw new AttachmentError(`${this.subject} can contain up to 100 files.`, 409)
            const slot = join(directory, file.id)
            await mkdir(directory, { recursive: true, mode: 0o700 })
            await mkdir(slot, { mode: 0o700 })
            created.push(slot)
            await link(path, this.path(sessionId, requestId, file))
            await writeFile(join(slot, 'metadata.json'), JSON.stringify({ ...file, owner }), { flag: 'wx', mode: 0o600 })
            count++
          }
          files.push(file)
        }
        return files
      }
      catch (cause) {
        await Promise.all(created.map(slot => rm(slot, { recursive: true, force: true }).catch(() => {})))
        throw cause
      }
    })
  }

  async removeDraft(sessionId: number, requestId: string, id: string, owner: string): Promise<void> {
    const attachment = await this.find(sessionId, requestId, id)
    if (attachment?.owner === owner)
      await rm(join(requestFolder(this.root, sessionId, requestId), id), { recursive: true, force: true })
  }

  async drafts(sessionId: number, requestId: string, owner: string): Promise<QuestionAttachment[]> {
    const entries = await names(requestFolder(this.root, sessionId, requestId))
    const files = await Promise.all(entries.map(id => this.find(sessionId, requestId, id)))
    return files.flatMap(file => {
      if (!file || file.owner !== owner) return []
      const { id, questionId, name, size, image } = file
      return [{ id, questionId, name, size, image }]
    })
  }

  async sessionIds(): Promise<number[]> {
    return (await names(this.root)).filter(name => /^[1-9]\d*$/u.test(name)).map(Number)
  }

  async prune(sessionId: number, keep: () => ReadonlyMap<string, ReadonlySet<string> | null>): Promise<void> {
    const session = join(this.root, String(sessionId))
    const contents = await names(session)
    const byFolder = new Map([...keep()].map(([requestId, ids]) => [requestFolder(this.root, sessionId, requestId), ids]))
    for (const name of contents) {
      const folder = join(session, name)
      const ids = byFolder.get(folder)
      if (ids === null) continue
      if (!ids?.size) {
        await rm(folder, { recursive: true, force: true })
        continue
      }
      for (const id of await names(folder)) {
        if (!ids.has(id)) await rm(join(folder, id), { recursive: true, force: true })
      }
    }
  }
}
