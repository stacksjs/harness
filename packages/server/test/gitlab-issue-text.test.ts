import type { GitLabIssueRepository } from '../src/issue-repositories'
import { expect, spyOn, test } from 'bun:test'
import { readGitLabIssueText, writeGitLabIssueText } from '../src/gitlab-issues'

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
