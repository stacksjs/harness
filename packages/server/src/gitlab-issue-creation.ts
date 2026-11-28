import type { IssueCreationAdapter } from './issue-create'
import type { GitLabIssueRepository } from './issue-repositories'
import { gitLabGraphQL, gitLabIssueCredential, gitLabIssueRest } from './gitlab-issues'
import { issueTextLimits } from './issue-text'
import { RepositoryPullRequestError } from './repository-pull-request'

type CreationPermission = {
  data?: {
    currentUser?: { id?: string }
    project?: {
      id?: string, fullPath?: string, archived?: boolean, issuesEnabled?: boolean,
      multipleAssignees?: { available?: boolean }, userPermissions?: { createIssue?: boolean, adminIssue?: boolean },
    },
  },
  errors?: { extensions?: { code?: string, fieldName?: string, typeName?: string, value?: string } }[],
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function id(value: unknown, prefix: string) {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return null
  const suffix = value.slice(prefix.length)
  const number = Number(suffix)
  return /^[1-9]\d*$/u.test(suffix) && positiveId(number) ? number : null
}

function unreadableTemplates() {
  return new RepositoryPullRequestError('GitLab returned unreadable issue templates.')
}

export async function bindGitLabIssueCreation(repository: GitLabIssueRepository, signal: AbortSignal, pageSize: number): Promise<IssueCreationAdapter> {
  const credential = await gitLabIssueCredential(repository, signal)
  const request = (path: string, body?: object) => gitLabIssueRest(repository, path, signal, credential, body)
  const root = 'projects/' + encodeURIComponent(repository.name)
  const endpoint = root + '/issues'
  const templatePath = root + '/templates/issues'
  const readPermission = (withTier: boolean) => gitLabGraphQL(repository, `query HarnessGitLabIssueCreation($path: ID!) {
    currentUser { id }
    project(fullPath: $path) {
      id fullPath archived issuesEnabled
      userPermissions { createIssue adminIssue }
      ${withTier ? 'multipleAssignees: licensedFeatureAvailability(feature: MULTIPLE_ISSUE_ASSIGNEES) { available }' : ''}
    }
  }`, { path: repository.name }, signal, credential) as Promise<CreationPermission | null>
  return {
    async readAuthority() {
      let reply = await readPermission(true)
      // Older hosts can still authorize issue creation without the optional tier field.
      if (reply?.errors?.length && reply.errors.every(({ extensions }) =>
        (extensions?.code === 'undefinedField' && extensions.fieldName === 'licensedFeatureAvailability' && extensions.typeName === 'Project')
        || (extensions?.code === 'argumentLiteralsIncompatible' && extensions.typeName === 'LicensedFeature'),
      )) reply = await readPermission(false)
      const project = reply?.data?.project
      const repoId = id(project?.id, 'gid://gitlab/Project/')
      const viewer = id(reply?.data?.currentUser?.id, 'gid://gitlab/User/')
      if (reply?.errors?.length || !repoId || !viewer || typeof project?.fullPath !== 'string'
        || project.fullPath.toLowerCase() !== repository.name.toLowerCase()) return null
      return { repoId, viewer, archived: project.archived, issuesEnabled: project.issuesEnabled === true,
        canCreate: project.userPermissions?.createIssue === true, canTriage: project.userPermissions?.adminIssue === true,
        multipleAssignees: project.multipleAssignees?.available }
    },
    async templates() {
      const { body } = await request(templatePath)
      if (!Array.isArray(body)) throw unreadableTemplates()
      const entries = new Map<string, string>()
      for (const entry of body) {
        const key = typeof entry?.key === 'string' ? entry.key.trim() : ''
        if (!key || key.length > 255 || /[\/\\\p{Cc}]/u.test(key) || key === '.' || key === '..') continue
        const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 255) : ''
        entries.set(key, name || key)
        if (entries.size === 20) break
      }
      const templates = []
      const rows = [...entries]
      for (let index = 0; index < rows.length; index += 4) {
        templates.push(...await Promise.all(rows.slice(index, index + 4).map(async ([key, name]) => {
          const { body } = await request(templatePath + '/' + encodeURIComponent(key))
          const template = body as { content?: unknown } | null
          if (!template || (template.content != null && typeof template.content !== 'string')) throw unreadableTemplates()
          return { key, name, body: (template.content ?? '').slice(0, issueTextLimits.body), about: '', title: '',
            labels: [], assignees: [] }
        })))
      }
      return { templates, blankIssuesEnabled: true }
    },
    async prepare(payload, authority) {
      if (payload.labels.some(label => label.includes(','))) return { status: 'refused' }
      if (authority.multipleAssignees === false && payload.assignees.length > 1) return { status: 'refused' }
      const assigneeIds = new Set<number>()
      for (const assignee of payload.assignees) {
        let assigneeId = /^[1-9]\d*$/u.test(assignee) ? Number(assignee) : undefined
        if (assigneeId === undefined) {
          const { body } = await request('users?' + new URLSearchParams({ username: assignee }))
          const user = Array.isArray(body) ? body.find(user => typeof user?.username === 'string'
            && user.username.toLowerCase() === assignee.toLowerCase()) : null
          assigneeId = user?.id
        }
        if (!positiveId(assigneeId)) return { status: 'unknown-assignee' }
        assigneeIds.add(assigneeId)
      }
      const assignees = authority.multipleAssignees === false
        ? assigneeIds.size ? { assignee_id: assigneeIds.values().next().value } : {}
        : { assignee_ids: [...assigneeIds] }
      return { body: { title: payload.title, description: payload.body, labels: payload.labels.join(','), ...assignees } }
    },
    submit: async payload => (await request(endpoint, payload)).body,
    list: page => request(endpoint + '?' + new URLSearchParams({
      scope: 'all', order_by: 'created_at', sort: 'desc', per_page: String(pageSize), page: String(page),
    })),
  }
}
