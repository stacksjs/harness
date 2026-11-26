import type { ComposerAttachment, ComposerUploads } from '@harness/contract'
import type { ComposerDraftFile } from './browser-composer-files'

export const PROMPT_STASH_KEY = 'harness.prompt-stash.v1'
const MAX_STASH_ENTRIES = 20
type UploadSource = Pick<ComposerUploads, 'scope' | 'draft'>
type StashedFile = ComposerDraftFile & { id: string }

export interface PromptStashEntry {
  id: string
  text: string
  files: StashedFile[]
}

function endpoint(id: string, source?: UploadSource, files?: StashedFile[]): string {
  const query = new URLSearchParams(source)
  for (const file of files ?? []) query.append('file', file.id)
  return `/composer-attachments/stash/${id}?${query}`
}

async function send(url: string, method: string): Promise<Response> {
  const response = await fetch(url, { method })
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(error?.error || 'The host could not transfer the stashed files.')
  }
  return response
}

function releaseFiles(id: string): void {
  void fetch(endpoint(id), { method: 'DELETE' }).catch(() => {})
}

export function newComposerDraftId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function createPromptStash(storage: Storage) {
  function entries(): PromptStashEntry[] {
    const raw = storage.getItem(PROMPT_STASH_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(entry =>
      entry && /^[a-f\d]{32}$/u.test(entry.id) && typeof entry.text === 'string' && Array.isArray(entry.files),
    ) : []
  }

  function write(next: PromptStashEntry[]): PromptStashEntry[] {
    storage.setItem(PROMPT_STASH_KEY, JSON.stringify(next))
    return next
  }

  return {
    entries,
    async save(text: string, files: ComposerDraftFile[], source?: UploadSource): Promise<PromptStashEntry[]> {
      if (entries().length >= MAX_STASH_ENTRIES) throw new Error('The stash holds 20 prompts. Restore or remove one first.')
      if (files.some(file => file.status !== 'ready' || !file.id) || (files.length && !source))
        throw new Error('Wait for uploads to finish, or remove failed files before stashing.')
      const entry = { id: newComposerDraftId(), text, files: files as StashedFile[] }
      if (entry.files.length) await send(endpoint(entry.id, source, entry.files), 'POST')
      try {
        const saved = entries()
        if (saved.length >= MAX_STASH_ENTRIES) throw new Error('The stash holds 20 prompts. Restore or remove one first.')
        return write([entry, ...saved])
      }
      catch (error) {
        if (entry.files.length) releaseFiles(entry.id)
        throw error
      }
    },
    async restoreFiles(entry: PromptStashEntry, target: UploadSource): Promise<ComposerDraftFile[]> {
      if (!entry.files.length) return []
      const response = await send(endpoint(entry.id, target), 'PUT')
      const files = await response.json() as Array<Pick<ComposerAttachment, 'id' | 'name' | 'size' | 'image'>>
      const byId = new Map(files.map(file => [file.id, file]))
      return entry.files.map((original) => {
        const file = byId.get(original.id)
        return file
          ? { ...original, ...file, status: 'ready' }
          : { ...original, id: undefined, status: 'failed', error: 'Upload expired.' }
      })
    },
    remove(entry: PromptStashEntry): PromptStashEntry[] {
      const next = write(entries().filter(item => item.id !== entry.id))
      if (entry.files.length) releaseFiles(entry.id)
      return next
    },
  }
}
