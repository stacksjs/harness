import type { GitHubIssueReference } from '@harness/contract'
import { parseLinkedPrompt, promptLinkKeys } from './prompt-links'

export function readPromptLink(element: Element, activeThread: boolean) {
  const view = element.ownerDocument.defaultView
  if (!view) return null
  const address = new URL(view.location.href)
  const newThread = address.pathname === '/new' || address.pathname === '/new/'
    || (address.pathname === '/' && address.searchParams.has('workspace') && address.searchParams.has('pr'))
  if (!newThread && (!activeThread || !address.searchParams.has('prompt'))) return null
  return { ...parseLinkedPrompt(address.searchParams, newThread), newThread, rawText: address.searchParams.get('prompt') }
}

export function clearPromptLink(element: Element): void {
  const view = element.ownerDocument.defaultView
  if (!view) return
  const address = new URL(view.location.href)
  for (const key of promptLinkKeys) address.searchParams.delete(key)
  view.history.replaceState(view.history.state, '', address.pathname + address.search + address.hash)
}

export function linkedTurn(transcript: HTMLElement): 'opened' | 'missing' | null {
  const hash = transcript.ownerDocument.location?.hash
  transcript.querySelector('[data-linked-turn]')?.removeAttribute('data-linked-turn')
  const id = /^#turn-([1-9]\d*)$/u.exec(hash ?? '')?.[1]
  if (!id) return null
  const turn = transcript.querySelector<HTMLElement>('[data-turn="' + id + '"]')
  if (!turn) return 'missing'
  turn.dataset.linkedTurn = ''
  turn.tabIndex = -1
  const top = turn.getBoundingClientRect().top - transcript.getBoundingClientRect().top + transcript.scrollTop
  transcript.scrollTop = Math.max(0, top - 8)
  turn.focus({ preventScroll: true })
  return 'opened'
}

export function storeLinkedDraft(target: Element, destination: { profile: string, workspace?: number, id: string }, draft: {
  text: string
  notice?: string
  issue?: GitHubIssueReference
  provider?: string
  model?: string
}): string {
  const storage = target.ownerDocument.defaultView?.localStorage
  if (!storage) throw new Error('Browser storage is unavailable.')
  const { profile, workspace, id } = destination
  const scope = workspace ? 'project:' + workspace : 'projectless'
  storage.setItem('harness.composer.v1:' + profile + ':' + scope + ':draft:' + id, JSON.stringify({
    text: draft.text,
    start: draft.text.length,
    end: draft.text.length,
    createdAt: Date.now(),
    ...(draft.notice ? { linkNotice: draft.notice } : {}),
    ...(workspace && draft.issue ? { issue: draft.issue } : {}),
    ...(draft.provider ? { provider: draft.provider, model: draft.model } : {}),
  }))
  const params = workspace ? new URLSearchParams({ workspace: String(workspace) }) : new URLSearchParams({ profile, project: 'none' })
  params.set('draft', id)
  return '/?' + params
}

interface LinkedModelAccount {
  kind: string
  status: string
  id?: number
  models?: Array<{ id: string, name: string }>
}

export function matchingLinkedModel(provider: string | undefined, model: string | undefined, accounts: LinkedModelAccount[]) {
  if (!provider) return null
  for (const account of accounts) {
    if (account.kind !== provider || account.status !== 'ready') continue
    const selection = model ? account.models?.find(option => option.id.toLowerCase() === model.toLowerCase()
      || option.name.toLowerCase() === model.toLowerCase()) : undefined
    if (model && !selection) continue
    return { provider: account.id === undefined ? account.kind : account.kind + ':' + account.id, model: selection?.id }
  }
  return null
}
