import type { QuestionAttachment } from '@harness/contract'
import { link, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AttachmentError, QuestionAttachments } from './question-attachments'

export const STASH_RETENTION_MS = 24 * 60 * 60 * 1000
const stashIdPattern = /^[a-f\d]{32}$/u
export const composerStashRoute = /^\/composer-attachments\/stash\/([a-f\d]{32})$/u

interface Lease {
  owner: string
  expiresAt: number
  files: QuestionAttachment[]
}

export class ComposerAttachmentStashes {
  constructor(private readonly root: string, private readonly drafts: QuestionAttachments, private readonly now = Date.now) {}

  private lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    return this.drafts.serialize(0, `stash/${id}`, action)
  }

  private async lease(id: string): Promise<Lease | undefined> {
    return await Bun.file(join(this.root, id, 'lease.json')).json().catch(() => undefined) as Lease | undefined
  }

  private async discard(id: string): Promise<void> {
    await rm(join(this.root, id), { recursive: true, force: true })
  }

  async save(id: string, source: string, ids: string[], owner: string): Promise<void> {
    return this.lock(id, async () => {
      const existing = await this.lease(id)
      if (existing) {
        if (existing.owner !== owner || existing.expiresAt <= this.now() || existing.files.map(file => file.id).join() !== ids.join())
          throw new AttachmentError('This prompt stash is unavailable.', 409)
        return
      }
      const files = await this.drafts.resolve(0, source, [{ questionId: 'composer', values: [], attachmentIds: ids }], owner)
      const directory = join(this.root, id)
      // A previous interrupted write has no lease and cannot be opened.
      await this.discard(id)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      try {
        for (const file of files) await link(this.drafts.path(0, source, file), join(directory, file.id))
        await writeFile(join(directory, 'lease.json'), JSON.stringify({
          owner, expiresAt: this.now() + STASH_RETENTION_MS, files,
        } satisfies Lease), { flag: 'wx', mode: 0o600 })
      }
      catch (cause) {
        await this.discard(id).catch(() => {})
        throw cause
      }
    })
  }

  async restore(id: string, target: string, owner: string): Promise<QuestionAttachment[]> {
    return this.lock(id, async () => {
      const lease = await this.lease(id)
      if (!lease || lease.owner !== owner) return []
      if (lease.expiresAt <= this.now()) {
        await this.discard(id)
        return []
      }
      const directory = join(this.root, id)
      const sources = await Promise.all(lease.files.map(async (file) => {
        const path = join(directory, file.id)
        return await Bun.file(path).exists() ? { file, path } : undefined
      }))
      return this.drafts.linkDrafts(0, target, owner, sources.filter(source => source !== undefined))
    })
  }

  async remove(id: string, owner: string): Promise<void> {
    await this.lock(id, async () => {
      if ((await this.lease(id))?.owner === owner) await this.discard(id)
    })
  }

  async reap(): Promise<void> {
    const names = await readdir(this.root).catch(() => [])
    for (const id of names.filter(name => stashIdPattern.test(name))) {
      await this.lock(id, async () => {
        const lease = await this.lease(id)
        const expired = lease
          ? lease.expiresAt <= this.now()
          : await stat(join(this.root, id)).then(info => info.mtimeMs + STASH_RETENTION_MS <= this.now(), () => false)
        if (expired) await this.discard(id)
      })
    }
  }
}
