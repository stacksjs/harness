import type { ComposerAttachment, ComposerUploads } from '@harness/contract'
import type { HarnessState, SessionState } from '@harness/engine'
import { MAX_COMPOSER_ATTACHMENTS } from '@harness/contract'
import { join } from 'node:path'
import { ComposerAttachmentStashes, composerStashRoute } from './composer-attachment-stashes'
import { AttachmentError, QuestionAttachments } from './question-attachments'

const draftPattern = /^[a-f\d]{32}$/u
const attachmentRoute = /^\/composer-attachments(?:\/([a-f\d-]{36}))?$/u

function uploadScope(scope: unknown): { kind: string, id: number } | undefined {
  if (typeof scope !== 'string') return
  const match = /^(session|project|scratch):(0|[1-9]\d{0,14})$/u.exec(scope)
  if (match) return { kind: match[1]!, id: Number(match[2]) }
}

function sourceBucket({ scope, draft }: Pick<ComposerUploads, 'scope' | 'draft'>): string {
  return `${scope}/${draft}`
}

function scopeAvailable(state: HarnessState, scope: ReturnType<typeof uploadScope>, session?: SessionState): boolean {
  if (!scope) return false
  const { kind, id } = scope
  if (kind === 'session') {
    const target = state.sessions.get(id)
    return Boolean(target && (!session || target.id === session.id) && target.state !== 'stopped'
      && !target.navigation?.archivedAt && state.workspaces.get(target.workspaceId)?.trusted)
  }
  const workspace = session && state.workspaces.get(session.workspaceId)
  if (session?.turns.length || (session && !workspace?.trusted)) return false
  if (kind === 'project') return Boolean(state.workspaces.get(id)?.trusted && (!workspace || workspace.id === id))
  return (id === 0 || state.profiles.has(id)) && (!workspace || (workspace.scratch === true && (id === 0 || workspace.profileId === id)))
}

async function imageContentType(file: Blob): Promise<string | undefined> {
  const header = Buffer.from(await file.slice(0, 12).arrayBuffer())
  if (header.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
  if (header.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg'
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  const gif = header.subarray(0, 6).toString('ascii')
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif'
}

export class ComposerAttachments {
  private readonly files: QuestionAttachments
  private readonly stashes: ComposerAttachmentStashes

  constructor(root: string, private readonly state: () => HarnessState, now = Date.now) {
    this.files = new QuestionAttachments(root, 'A draft')
    this.stashes = new ComposerAttachmentStashes(join(root, 'stashes'), this.files, now)
  }

  reapStashes(): Promise<void> { return this.stashes.reap() }

  resolve(uploads: ComposerUploads, sessionId: number, owner: string): Promise<ComposerAttachment[]> {
    const state = this.state()
    const session = state.sessions.get(sessionId)
    if (!uploads || typeof uploads.draft !== 'string' || !draftPattern.test(uploads.draft)
      || !session || !scopeAvailable(state, uploadScope(uploads.scope), session)
      || !Array.isArray(uploads.ids) || !uploads.ids.length || uploads.ids.length > MAX_COMPOSER_ATTACHMENTS
      || uploads.ids.some(id => typeof id !== 'string') || new Set(uploads.ids).size !== uploads.ids.length)
      throw new AttachmentError('These attachments are unavailable for this draft.')
    return this.files.resolve(0, sourceBucket(uploads), [{ questionId: 'composer', values: [], attachmentIds: uploads.ids }], owner)
      .then(files => files.map(({ id, name, size, image }) => ({ id, name, size, image, scope: uploads.scope, draft: uploads.draft })))
      .catch((cause) => {
        if (cause instanceof AttachmentError && cause.status === 400)
          throw new AttachmentError('An attachment is unavailable. Remove it and attach it again.')
        throw cause
      })
  }

  serialize<T>(uploads: ComposerUploads, callback: () => Promise<T>): Promise<T> {
    if (!uploads || typeof uploads.draft !== 'string' || !draftPattern.test(uploads.draft) || !uploadScope(uploads.scope))
      throw new AttachmentError('These attachments are unavailable for this draft.')
    return this.files.serialize(0, sourceBucket(uploads), callback)
  }

  path(file: ComposerAttachment): string {
    return this.files.path(0, sourceBucket(file), { questionId: 'composer', ...file })
  }

  async respond(request: Request, url: URL, owner: string): Promise<Response | undefined> {
    const route = attachmentRoute.exec(url.pathname)
    const stashId = composerStashRoute.exec(url.pathname)?.[1]
    const rewinding = url.pathname === '/composer-attachments/rewind'
    if (!route && !stashId && !rewinding) return
    const id = route?.[1]
    const headers = { 'Cache-Control': 'private, no-store' }
    const state = this.state()
    const session = state.sessions.get(Number(url.searchParams.get('session')))
    const scope = url.searchParams.get('scope') ?? ''
    const draft = url.searchParams.get('draft') ?? ''
    const bucket = sourceBucket({ scope, draft })
    if (!stashId && request.method === 'GET' && id) {
      const preview = url.searchParams.get('preview') === '1'
      const stored = preview && draftPattern.test(draft) && uploadScope(scope)
        ? await this.files.draftFile(0, bucket, id, owner) : undefined
      const attachment = stored ? { ...stored, scope, draft } : session?.turns.flatMap(turn => turn.attachments ?? []).find(file => file.id === id)
      if (!attachment) return new Response(null, { status: 404, headers })
      const file = Bun.file(this.path(attachment))
      if (preview && attachment.image && await file.exists()) {
        const type = await imageContentType(file)
        if (type) return new Response(file, { headers: {
          ...headers,
          'Content-Type': type,
          'Cross-Origin-Resource-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff',
        } })
      }
      if (preview) return new Response(null, { status: 404, headers })
      const name = encodeURIComponent(attachment.name).replace(/['()*]/gu, char => '%' + char.charCodeAt(0).toString(16))
      return await file.exists()
        ? new Response(file, { headers: {
          ...headers,
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
          'X-Content-Type-Options': 'nosniff',
        } })
        : new Response(null, { status: 404, headers })
    }
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== url.origin) return new Response(null, { status: 403, headers })
    try {
      if (stashId && request.method === 'DELETE') {
        await this.stashes.remove(stashId, owner)
        return new Response(null, { status: 204, headers })
      }
      if (!draftPattern.test(draft) || !uploadScope(scope)) return new Response(null, { status: 400, headers })
      if (rewinding) {
        if (request.method !== 'PUT') return new Response(null, { status: 405, headers })
        const selection = session?.rewoundPrompt
        const target = uploadScope(scope)
        if (!session || target?.kind !== 'session' || !scopeAvailable(state, target, session)
          || !selection || selection.operation !== url.searchParams.get('operation'))
          throw new AttachmentError('The rewound prompt is unavailable for this draft.', 409)
        const files = await this.files.linkDrafts(0, bucket, owner, selection.attachments.map(file => ({
          file: { id: file.id, name: file.name, size: file.size, image: file.image, questionId: 'composer' },
          path: this.path(file),
        })))
        return Response.json(files.map(({ id, name, size, image }) => ({ id, name, size, image })), { headers })
      }
      if (stashId) {
        if (!scopeAvailable(this.state(), uploadScope(scope)))
          throw new AttachmentError('This draft is unavailable for stashed attachments.', 409)
        if (request.method === 'POST') {
          const ids = url.searchParams.getAll('file')
          if (!ids.length || ids.length > MAX_COMPOSER_ATTACHMENTS || new Set(ids).size !== ids.length)
            throw new AttachmentError('Choose valid attachments to stash.')
          await this.stashes.save(stashId, bucket, ids, owner)
          return new Response(null, { status: 204, headers })
        }
        if (request.method === 'PUT') {
          const files = await this.stashes.restore(stashId, bucket, owner)
          return Response.json(files.map(({ id, name, size, image }) => ({ id, name, size, image })), { headers })
        }
        return new Response(null, { status: 405, headers })
      }
      if (request.method === 'POST' && !id) {
        if (!scopeAvailable(state, uploadScope(scope)))
          return Response.json({ error: 'This draft is unavailable for uploads.' }, { status: 409, headers })
        const { id, name, size, image } = await this.files.upload(request, 0, bucket, 'composer', owner, url.searchParams.get('name') ?? 'attachment')
        if (image) {
          const path = this.path({ scope, draft, id, name, size, image })
          if (!await imageContentType(Bun.file(path))) {
            await this.files.removeDraft(0, bucket, id, owner)
            throw new AttachmentError('This file could not be read as an image.')
          }
        }
        return Response.json({ id, name, size, image }, { status: 201, headers })
      }
      if (request.method === 'DELETE' && id) {
        return await this.files.serialize(0, bucket, async () => {
          const used = (file: ComposerAttachment) => file.id === id && file.draft === draft && file.scope === scope
          for (const session of this.state().sessions.values()) {
            if (session.rewoundPrompt?.attachments.some(used)
              || session.turns.some(turn => turn.attachments?.some(used))
              || session.followUps.entries.some(entry => entry.attachments?.some(used)))
              return new Response(null, { status: 409, headers })
          }
          await this.files.removeDraft(0, bucket, id, owner)
          return new Response(null, { status: 204, headers })
        })
      }
      return new Response(null, { status: 405, headers })
    }
    catch (cause) {
      return Response.json({ error: cause instanceof AttachmentError ? cause.message : 'Could not save the attachment.' }, {
        status: cause instanceof AttachmentError ? cause.status : 500,
        headers,
      })
    }
  }
}
