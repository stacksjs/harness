import { emptyState } from '@harness/engine'
import { expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { WorkflowRunner } from '../src/workflows/runner'
import { fixtureForgejoCli } from './fixtures/forgejo-cli'
import { fixtureGitHubCli } from './fixtures/github-cli'
import { fixtureGitLabCli } from './fixtures/gitlab-cli'

const epoch = Date.parse('2026-11-28T12:00:00Z')
const stamp = (offset: number) => new Date(epoch + offset).toISOString()

function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), 'harness-workflow-tracker-'))
  const state = emptyState()
  for (const id of [1, 2]) state.profiles.set(id, { id, name: 'Profile ' + id, tint: '', icon: '', position: id, workspaceIds: [], mcpServers: [] })
  const database = join(directory, 'state.sqlite')
  const file = join(directory, 'workflows.ts')
  let now = epoch
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  let runner: WorkflowRunner | undefined
  const env = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITLAB_TOKEN: process.env.GITLAB_TOKEN, GITLAB_ACCESS_TOKEN: process.env.GITLAB_ACCESS_TOKEN, OAUTH_TOKEN: process.env.OAUTH_TOKEN,
  }
  return {
    directory, file, state,
    project(id: number, path: string, remote: string) {
      const project = join(directory, path)
      mkdirSync(project)
      for (const args of [['init', '-qb', 'main'], ['remote', 'add', 'origin', remote]])
        expect(Bun.spawnSync(['git', ...args], { cwd: project }).success).toBe(true)
      state.workspaces.set(id, { id, path: realpathSync(project), profileId: 1, trusted: true })
      return project
    },
    cli(bin: string) {
      for (const key of Object.keys(env)) if (key !== 'PATH') delete process.env[key]
      process.env.PATH = bin + delimiter + env.PATH
    },
    advance() { now += 60_000 },
    async open() {
      runner?.stop()
      runner = await WorkflowRunner.open(file, database, () => state)
      return runner
    },
    close() {
      runner?.stop()
      clock.mockRestore()
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

async function waitFor(runner: WorkflowRunner, statuses: string[], total?: number) {
  runner.wake()
  const deadline = performance.now() + 8000
  while (performance.now() < deadline) {
    const list = runner.list(1)
    const current = list.workflows.flatMap(workflow => workflow.trackerTriggers.map(trigger => trigger.status))
    if (current.join(',') === statuses.join(',') && (total === undefined || list.runs.length === total
      && list.runs.every(run => run.status === 'completed'))) return list
    await Bun.sleep(20)
  }
  const snapshot = runner.list(1)
  throw new Error(JSON.stringify({ workflows: snapshot.workflows, count: snapshot.runs.length, problems: snapshot.problems }))
}

it.skipIf(process.platform === 'win32')('recovers tracker cursors through a failed page, restart, same-time items, and account changes', async () => {
  const box = sandbox()
  const repository = 'fixture/inbox'
  const project = box.project(10, 'inbox', 'https://github.com/' + repository)
  const cli = fixtureGitHubCli(box.directory, { [repository]: { bare: join(project, '.git') } })
  box.cli(cli.bin)
  const issue = (number: number, created: number, name = 'triage') => ({
    number, html_url: 'https://github.com/' + repository + '/issues/' + number, title: 'Issue ' + number,
    created_at: stamp(created), updated_at: stamp(created + 5000), state: 'closed', labels: [{ name }],
  })
  const pull = (number: number, created: number) => ({
    number, html_url: 'https://github.com/' + repository + '/pull/' + number, title: 'Pull request ' + number,
    created_at: stamp(created), state: 'closed', merged_at: stamp(created + 5000), base: { repo: { full_name: repository } },
  })
  const fixture = JSON.parse(readFileSync(cli.state, 'utf8'))
  fixture.issueCreate = { pageSize: 1, viewerId: 17 }
  fixture.issues = { [repository]: [issue(1, -1000)] }
  fixture.pulls = [pull(2, -2000)]
  const save = () => writeFileSync(cli.state, JSON.stringify(fixture))
  save()
  writeFileSync(box.file, `export default { name: 'inbox', version: 1,
    trackerTriggers: [
      { id: 'incoming-issues', profile: 1, project: 'inbox', kind: 'issue', labels: ['Triage'] },
      { id: 'incoming-pulls', profile: 1, project: 10, kind: 'pull-request', repository: 'fixture/inbox' },
    ],
    run(item) { return { number: item.number, state: item.state, label: item.labels[0] } },
  }`)
  try {
    let runner = await box.open()
    expect(await waitFor(runner, ['ready', 'ready'], 0)).toMatchObject({ runs: [] })
    fixture.issues[repository].push(issue(3, 5000), issue(4, 5000), issue(5, 10_000, 'ignore'))
    fixture.pulls.push(pull(6, 6000))
    fixture.issueCreate.hideList = true
    save()
    box.advance()
    expect((await waitFor(runner, ['unavailable', 'ready'], 1)).runs[0]?.result).toEqual({ number: 6, state: 'merged' })
    delete fixture.issueCreate.hideList

    runner = await box.open()
    const replay = await waitFor(runner, ['ready', 'ready'], 3)
    expect(replay.runs.filter(run => run.tracker?.kind === 'issue').map(run => run.result)).toEqual([
      { number: 4, state: 'closed', label: 'triage' }, { number: 3, state: 'closed', label: 'triage' },
    ])
    expect(runner.list(2)).toMatchObject({ runs: [], workflows: [{ trackerTriggers: [] }] })

    fixture.issueCreate.viewerId = 91
    fixture.issues[repository].push(issue(7, 65_000))
    save()
    box.advance()
    await waitFor(runner, ['account-changed', 'account-changed'], 3)
    fixture.issueCreate.viewerId = 17
    fixture.issues[repository].push(issue(8, 5000), issue(10, 4500))
    save()
    box.advance()
    const restored = await waitFor(runner, ['ready', 'ready'], 6)
    expect(restored.runs.map(run => run.tracker?.displayKey).sort()).toEqual(['#10', '#3', '#4', '#6', '#7', '#8'])
    runner = await box.open()
    expect((await waitFor(runner, ['ready', 'ready'], 6)).runs.map(run => run.runId)).toEqual(restored.runs.map(run => run.runId))

    const workspace = box.state.workspaces.get(10)!
    box.state.workspaces.set(10, { ...workspace, trusted: false })
    fixture.issues[repository].push(issue(9, 125_000))
    save()
    box.advance()
    await waitFor(runner, ['unavailable', 'unavailable'], 6)
    box.state.workspaces.set(10, workspace)
    box.advance()
    expect((await waitFor(runner, ['ready', 'ready'], 7)).runs[0]?.tracker?.displayKey).toBe('#9')
  }
  finally { box.close() }
}, 30_000)

it.skipIf(process.platform === 'win32')('reads issue and review triggers from a scoped GitLab account and a mounted Forgejo login', async () => {
  const box = sandbox()
  const gitLabHost = 'gitlab.fixture.invalid'
  const forgejoBase = 'https://forgejo.fixture.invalid/mount'
  const gitLabRepo = 'team/tools/notes'
  const forgejoRepo = 'fixture/inbox'
  box.project(10, 'gitlab', 'https://' + gitLabHost + '/' + gitLabRepo + '.git')
  box.project(11, 'forgejo', forgejoBase + '/' + forgejoRepo + '.git')
  const cli = fixtureGitHubCli(box.directory, {})
  fixtureGitLabCli(cli.bin)
  fixtureForgejoCli(cli.bin)
  box.cli(cli.bin)
  const fixture = {
    gitlab: { host: gitLabHost, repository: gitLabRepo, viewer: 17, trackerFeeds: { issues: [] as object[], pulls: [] as object[] } },
    forgejo: { base: forgejoBase, repository: forgejoRepo, viewer: 'fixture-user', selected: 'fixture', viewerId: 19,
      logins: [{ name: 'fixture', url: forgejoBase, user: 'fixture-user', default: 'true' }],
      issues: [] as object[], trackerPulls: [] as object[],
    },
  }
  const save = () => writeFileSync(cli.state, JSON.stringify(fixture))
  save()
  writeFileSync(box.file, `export default { name: 'review', version: 1, run: item => ({ link: item.url }),
    trackerTriggers: [
      { id: 'gitlab-issue', profile: 1, project: 10, kind: 'issue', query: 'confirm' },
      { id: 'gitlab-pull', profile: 1, project: 10, kind: 'pull-request' },
      { id: 'forgejo-issue', profile: 1, project: 11, kind: 'issue' },
      { id: 'forgejo-pull', profile: 1, project: 11, kind: 'pull-request', query: 'confirm' },
    ],
  }`)
  try {
    const runner = await box.open()
    const ready = ['ready', 'ready', 'ready', 'ready']
    await waitFor(runner, ready, 0)
    const common = { title: 'confirm work', state: 'closed', created_at: stamp(1000), updated_at: stamp(2000) }
    const gitlab = 'https://' + gitLabHost + '/' + gitLabRepo
    const forgejo = forgejoBase + '/' + forgejoRepo
    fixture.gitlab.trackerFeeds.issues.push({ ...common, iid: 1, web_url: gitlab + '/-/issues/1' })
    fixture.gitlab.trackerFeeds.pulls.push({ ...common, iid: 2, web_url: gitlab + '/-/merge_requests/2', state: 'merged' })
    fixture.forgejo.issues.push({ ...common, number: 3, html_url: forgejo + '/issues/3' })
    fixture.forgejo.trackerPulls.push({ ...common, number: 4, html_url: forgejo + '/pulls/4' })
    fixture.forgejo.trackerPulls.push({ ...common, title: 'exclude', number: 5, html_url: forgejo + '/pulls/5' })
    save()
    box.advance()
    const { runs } = await waitFor(runner, ready, 4)
    expect(runs.map(run => run.result).sort((a, b) => (a as {link:string}).link.localeCompare((b as {link:string}).link))).toEqual([
      { link: forgejo + '/issues/3' }, { link: forgejo + '/pulls/4' }, { link: gitlab + '/-/issues/1' }, { link: gitlab + '/-/merge_requests/2' },
    ])
    expect(runs.find(run => run.tracker?.id === 'gitlab-pull')?.tracker?.displayKey).toBe('!2')
  }
  finally { box.close() }
}, 30_000)
