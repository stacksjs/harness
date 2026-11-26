import type { ComposerAttachment, ComposerUploads } from '@harness/contract'
import { MAX_COMPOSER_ATTACHMENTS } from '@harness/contract'

type UploadSource = Pick<ComposerUploads, 'scope' | 'draft'>

export interface ComposerDraftFile {
  key: string
  id?: string
  name: string
  size: number
  image?: boolean
  status: 'uploading' | 'ready' | 'failed'
  error?: string
}

interface ComposerFileOptions {
  files: () => ComposerDraftFile[]
  upload: () => UploadSource | undefined
  setFiles: (files: ComposerDraftFile[], source: UploadSource) => void
  setError: (message: string) => void
  inputBlocked: () => boolean
  newKey: () => string
  focusEditor: () => void
  sources: Map<string, File>
  scope: string
}

function attachmentUrl(upload: UploadSource, id = '', name = ''): string {
  const params = new URLSearchParams({ scope: upload.scope, draft: upload.draft })
  if (name) params.set('name', name)
  return `/composer-attachments${id ? '/' + id : ''}?${params}`
}

export function composerFileStatus(file: ComposerDraftFile): string {
  if (file.status === 'uploading') return 'Uploading…'
  if (file.status === 'failed') return file.error || 'Upload failed.'
  if (file.size < 1024) return file.size + ' B'
  if (file.size < 1024 * 1024) return Math.round(file.size / 1024) + ' KiB'
  return (file.size / (1024 * 1024)).toFixed(1) + ' MiB'
}

export function createComposerFileActions(options: ComposerFileOptions) {
  const { files, upload, setFiles, setError, inputBlocked, newKey, focusEditor, sources, scope } = options

  function removeUploaded(source: UploadSource, id: string): void {
    void fetch(attachmentUrl(source, id), { method: 'DELETE' }).catch(() => {})
  }

  async function sendFile(key: string): Promise<void> {
    const target = upload()
    const source = sources.get(key)
    if (!target || !source || inputBlocked()) return
    const update = (changes: Partial<ComposerDraftFile>): boolean => {
      if (upload()?.draft !== target.draft || !files().some(file => file.key === key)) return false
      setFiles(files().map(file => file.key === key ? { ...file, ...changes } : file), target)
      return true
    }
    update({ status: 'uploading', error: '' })
    try {
      const response = await fetch(attachmentUrl(target, '', source.name), {
        method: 'POST',
        body: source,
        headers: { 'Content-Type': source.type || 'application/octet-stream' },
      })
      const file = await response.json().catch(() => null) as (Pick<ComposerAttachment, 'id' | 'name' | 'size' | 'image'> & { error?: string }) | null
      if (!response.ok || !file?.id) throw new Error(file?.error || 'Upload failed. Try again.')
      if (!update({ ...file, status: 'ready' })) removeUploaded(target, file.id)
      sources.delete(key)
    }
    catch (cause) {
      update({ status: 'failed', error: cause instanceof Error ? cause.message : 'Upload failed. Try again.' })
    }
  }

  function add(incoming: File[]): void {
    if (!incoming.length || inputBlocked()) return
    if (files().length + incoming.length > MAX_COMPOSER_ATTACHMENTS) {
      setError(`A message can contain up to ${MAX_COMPOSER_ATTACHMENTS} attachments.`)
      return
    }
    const target = upload() ?? {
      draft: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
      scope,
    }
    const added = incoming.map((file): ComposerDraftFile => {
      const key = newKey()
      sources.set(key, file)
      return { key, name: file.name, size: file.size, status: 'uploading' }
    })
    setError('')
    setFiles([...files(), ...added], target)
    for (const file of added) void sendFile(file.key)
  }

  return {
    choose(event: Event) {
      const picker = event.currentTarget as HTMLInputElement
      add(Array.from(picker.files ?? []))
      picker.value = ''
    },
    drop(event: DragEvent) {
      const incoming = Array.from(event.dataTransfer?.files ?? [])
      if (!incoming.length) return
      event.preventDefault()
      add(incoming)
    },
    paste(event: ClipboardEvent) {
      if (inputBlocked()) return
      const clipboard = event.clipboardData
      const incoming = Array.from(clipboard?.files ?? [])
      if (!incoming.length) {
        const text = clipboard?.getData('text/plain') ?? ''
        if (new Blob([text]).size < 32 * 1024) return
        incoming.push(new File([text], 'pasted-text.txt', { type: 'text/plain' }))
      }
      event.preventDefault()
      add(incoming)
    },
    retry: sendFile,
    remove(key: string) {
      if (inputBlocked()) return
      const target = upload()
      const file = files().find(item => item.key === key)
      if (!target || !file) return
      sources.delete(key)
      setError('')
      setFiles(files().filter(item => item.key !== key), target)
      if (file.id) removeUploaded(target, file.id)
      focusEditor()
    },
    preview(id: string): string | null {
      const target = upload()
      return target ? attachmentUrl(target, id) + '&preview=1' : null
    },
  }
}
