export const issueReactionEmoji = [
  ['THUMBS_UP', '👍', 'Thumbs up'], ['THUMBS_DOWN', '👎', 'Thumbs down'], ['LAUGH', '😄', 'Laugh'],
  ['HOORAY', '🎉', 'Hooray'], ['CONFUSED', '😕', 'Confused'], ['HEART', '❤️', 'Heart'],
  ['ROCKET', '🚀', 'Rocket'], ['EYES', '👀', 'Eyes'],
] as const
export const issueReactionId = /^[A-Za-z0-9_+\/=:.-]{1,256}$/u

export type IssueReactionContent = (typeof issueReactionEmoji)[number][0]
export type ReactionSubject = { id?: string, viewerCanReact?: boolean,
  reactionGroups?: { content?: string, viewerHasReacted?: boolean, reactors?: { totalCount?: number } }[],
}
export type IssueReactionBar = NonNullable<ReturnType<typeof reactionBar>>
export type IssueReactionForm = { subject: string, scope: string, intent: string, content: IssueReactionContent, desired: boolean }

export function reactionBar(subject: ReactionSubject, scope: string, allowed: boolean, comment = 0) {
  if (!subject.id || !issueReactionId.test(subject.id) || !Array.isArray(subject.reactionGroups)) return null
  return { subject: subject.id, comment, scope, intent: crypto.randomUUID(), allowed: allowed && subject.viewerCanReact === true,
    items: issueReactionEmoji.map(([content, glyph, label]) => {
      const group = subject.reactionGroups!.find(item => item?.content === content)
      const active = group?.viewerHasReacted === true
      const count = Number.isSafeInteger(group?.reactors?.totalCount) ? Math.max(0, group!.reactors!.totalCount!) : 0
      return { content, glyph, count, active, desired: active ? 'remove' : 'add', label,
        actionLabel: (active ? 'Remove ' : 'Add ') + label + ' reaction' }
    }) }
}
