import { expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComposerAttachmentStashes, STASH_RETENTION_MS } from '../src/composer-attachment-stashes'
import { QuestionAttachments } from '../src/question-attachments'

it('keeps owned stashed bytes across restart, restores idempotently, and reaps expired files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-stashed-uploads-'))
  const stashRoot = join(root, 'stashes')
  const original = 'session:1/first'
  const destination = 'session:2/second'
  const stashId = 'a'.repeat(32)
  let now = 1000
  try {
    const uploads = new QuestionAttachments(root)
    const request = new Request('http://127.0.0.1/upload', { method: 'POST', body: 'fixture bytes' })
    const file = await uploads.upload(request, 0, original, 'composer', 'owner', 'notes.txt')
    const stash = new ComposerAttachmentStashes(stashRoot, uploads, () => now)
    await expect(stash.save(stashId, original, [file.id], 'other')).rejects.toThrow('unavailable')
    await stash.save(stashId, original, [file.id], 'owner')
    await expect(stash.save(stashId, original, [file.id], 'other')).rejects.toThrow('unavailable')
    await stash.save(stashId, original, [file.id], 'owner')
    await uploads.removeDraft(0, original, file.id, 'owner')
    expect(await Bun.file(uploads.path(0, original, file)).exists()).toBe(false)

    const reopenedUploads = new QuestionAttachments(root)
    const reopened = new ComposerAttachmentStashes(stashRoot, reopenedUploads, () => now)
    expect(await reopened.restore(stashId, destination, 'other')).toEqual([])
    await reopened.remove(stashId, 'other')
    expect(await reopened.restore(stashId, destination, 'owner')).toEqual([file])
    expect(await reopened.restore(stashId, destination, 'owner')).toEqual([file])
    expect(await reopenedUploads.drafts(0, destination, 'owner')).toEqual([file])
    expect(await Bun.file(reopenedUploads.path(0, destination, file)).text()).toBe('fixture bytes')

    now += STASH_RETENTION_MS
    await reopened.reap()
    expect(await Bun.file(join(stashRoot, stashId, 'lease.json')).exists()).toBe(false)
    expect(await reopened.restore(stashId, 'session:3/third', 'owner')).toEqual([])
    expect(await Bun.file(reopenedUploads.path(0, destination, file)).text()).toBe('fixture bytes')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
