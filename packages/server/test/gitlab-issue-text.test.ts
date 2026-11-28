import type { GitLabIssueRepository } from '../src/issue-repositories'
import { expect, spyOn, test } from 'bun:test'
import { gitLabIssueRest, readGitLabIssueText, writeGitLabIssueText } from '../src/gitlab-issues'

test('GitLab issue text uses the pinned OAuth account and rejects redirects', async () => {
  const repository: GitLabIssueRepository = {
    tracker: 'gitlab', host: 'gitlab.example.test', name: 'test/project', key: 'gitlab:gitlab.example.test/test/project',
    path: '/fixture/project', workspace: { id: 5, profileId: 3, path: '/fixture/project', trusted: true },
  }
  const credential = { type: 'oauth2' as const, token: 'fixture-oauth-token', endpoint: new URL('https://gitlab.example.test/gitlab/api/graphql') }
  const id = 'gid://gitlab/WorkItem/11'
  const fetchMock = spyOn(globalThis, 'fetch')
  try {
    fetchMock.mockResolvedValueOnce(Response.json({ data: {
      currentUser: { id: 'gid://gitlab/User/6' },
      project: { id: 'gid://gitlab/Project/1', fullPath: repository.name, archived: false, issue: {
        id, iid: '7', webUrl: 'https://gitlab.example.test/test/project/-/work_items/7', title: 'Original', description: null,
        userPermissions: { updateIssue: true },
      } },
    } }))
    fetchMock.mockResolvedValueOnce(Response.json({ data: { updateIssue: { issue: { id, title: 'Updated' } } } }))
    fetchMock.mockRejectedValueOnce(new TypeError('Unexpected redirect'))
    const signal = AbortSignal.timeout(5_000)
    expect(await readGitLabIssueText(repository, 7, signal, credential)).toMatchObject({ issueId: id, canEditText: true, text: { title: 'Original', body: '' } })
    expect(await writeGitLabIssueText(repository, 7, id, 'title', 'Updated', signal, credential)).toBe('updated')
    expect(await writeGitLabIssueText(repository, 7, id, 'title', 'Retry', signal, credential)).toBe('pending')
    expect(fetchMock.mock.calls).toHaveLength(3)
    for (const [url, options] of fetchMock.mock.calls) {
      expect(String(url)).toBe(credential.endpoint.href)
      expect(options?.redirect).toBe('error')
      const headers = new Headers(options?.headers)
      expect(headers.get('Authorization')).toBe('Bearer fixture-oauth-token')
      expect(headers.get('PRIVATE-TOKEN')).toBeNull()
    }
  }
  finally { fetchMock.mockRestore() }
})

test('GitLab issue creation REST keeps a mounted OAuth host and honors status and pagination', async () => {
  const repository: GitLabIssueRepository = {
    tracker: 'gitlab', host: 'gitlab.example.test', name: 'team/subgroup', key: 'gitlab:gitlab.example.test/team/subgroup',
    path: '/fixture/project', workspace: { id: 5, profileId: 3, path: '/fixture/project', trusted: true },
  }
  const credential = { type: 'oauth2' as const, token: 'fixture-oauth-token', endpoint: new URL('https://gitlab.example.test/gitlab/api/graphql') }
  const fetchMock = spyOn(globalThis, 'fetch')
  try {
    fetchMock.mockResolvedValueOnce(Response.json({ iid: 4 }, { status: 201 }))
    fetchMock.mockResolvedValueOnce(Response.json([{ iid: 4 }], { headers: { 'X-Next-Page': '3' } }))
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 200 }))
    fetchMock.mockRejectedValueOnce(new TypeError('Unexpected redirect'))
    const signal = AbortSignal.timeout(5_000)
    const endpoint = 'projects/team%2Fsubgroup/issues'
    const issue = { title: 'Fixture issue', description: 'Reproduce a draft' }
    expect(await gitLabIssueRest(repository, endpoint, signal, credential, issue)).toMatchObject({ body: { iid: 4 } })
    expect(await gitLabIssueRest(repository, endpoint + '?scope=all&page=2', signal, credential)).toEqual({ body: [{ iid: 4 }], more: true })
    await expect(gitLabIssueRest(repository, endpoint, signal, credential, issue)).rejects.toMatchObject({ status: 200 })
    await expect(gitLabIssueRest(repository, endpoint, signal, credential)).rejects.toThrow('Unexpected redirect')
    expect(fetchMock.mock.calls).toHaveLength(4)
    const base = 'https://gitlab.example.test/gitlab/api/v4/' + endpoint
    for (const [index, [url, options]] of fetchMock.mock.calls.entries()) {
      expect(String(url)).toBe(base + (index === 1 ? '?scope=all&page=2' : ''))
      expect(options?.redirect).toBe('error')
      const headers = new Headers(options?.headers)
      expect(headers.get('Authorization')).toBe('Bearer fixture-oauth-token')
      expect(headers.get('PRIVATE-TOKEN')).toBeNull()
    }
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(issue) })
  }
  finally { fetchMock.mockRestore() }
})
