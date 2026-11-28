import { gitLabProject } from '@harness/contract'
import { RepositoryPullRequestError } from './repository-pull-request'

const repositoryPattern = /^[a-z\d._-]+\/[a-z\d._-]+$/iu
const mountPattern = /^(?:\/[a-z\d._-]+)*$/iu

type TeaLogin = { login: string, base: URL, sshHost: string, preferred: boolean }
export type TeaIssueTarget = { host: string, name: string, apiName: string, login: string, base: string }

function urlFor(value: string) {
  try { return new URL(value) }
  catch { return null }
}

export async function forgejoTeaLogins(signal: AbortSignal): Promise<TeaLogin[]> {
  const tea = Bun.which('tea', { PATH: process.env.PATH })
  if (!tea) return []
  try {
    const child = Bun.spawn([tea, 'login', 'list', '--output', 'json'], {
      stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', signal, timeout: 4_000,
    })
    const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited])
    if (exit !== 0 || stdout.length > 65_536) return []
    const rows = JSON.parse(stdout)
    if (!Array.isArray(rows)) return []
    return rows.flatMap(row => {
      if (typeof row?.name !== 'string' || !/^[^\p{Cc}]{1,120}$/u.test(row.name) || typeof row.url !== 'string' || row.valid === 'false') return []
      const base = urlFor(row.url)
      if (!base || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return []
      base.pathname = base.pathname.replace(/\/+$/u, '')
      if (!mountPattern.test(base.pathname === '/' ? '' : base.pathname) || !gitLabProject(base.host, 'sample/project')) return []
      return [{ login: row.name, base, sshHost: typeof row.ssh_host === 'string' ? row.ssh_host.toLowerCase() : '', preferred: row.default === 'true' }]
    })
  }
  catch { return [] }
}

export function forgejoTeaTarget(value: string, logins: TeaLogin[]): TeaIssueTarget | null {
  const scp = /^(?:[^@\s/]+@)?([^:/\s]+):([^/].+)$/u.exec(value)
  const remote = urlFor(scp ? 'ssh://' + scp[1] + '/' + scp[2] : value)
  if (!remote || !['https:', 'ssh:'].includes(remote.protocol) || remote.password || remote.search || remote.hash
    || (remote.protocol === 'https:' && remote.username)) return null
  const path = remote.pathname.replace(/^\//u, '').replace(/\/+$/u, '').replace(/\.git$/iu, '')
  const matches = logins.flatMap(({ login, base, sshHost, preferred }) => {
    if (remote.protocol === 'https:' ? remote.host !== base.host
      : remote.hostname !== base.hostname && remote.hostname !== sshHost && remote.host !== sshHost) return []
    const mount = base.pathname.replace(/^\//u, '')
    // SSH repository paths can omit the instance's HTTP mount.
    const relative = mount && path.startsWith(mount + '/') ? path.slice(mount.length + 1)
      : !mount || remote.protocol === 'ssh:' ? path : ''
    if (!repositoryPattern.test(relative) || relative.split('/').some(part => /^\.+$/u.test(part))) return []
    const name = mount ? mount + '/' + relative : relative
    const project = gitLabProject(base.host, name)
    return project ? [{ login, base: base.href.replace(/\/$/u, ''), host: project.host, name, apiName: relative, mount, preferred }] : []
  })
  if (!matches.length) return null
  const depth = Math.max(...matches.map(match => match.mount.length))
  const deepest = remote.protocol === 'ssh:' ? matches : matches.filter(match => match.mount.length === depth)
  const defaults = deepest.filter(match => match.preferred)
  const chosen = deepest.length === 1 ? deepest[0] : new Set(deepest.map(match => match.base)).size === 1 && defaults.length === 1 ? defaults[0] : null
  return chosen ? { host: chosen.host, name: chosen.name, apiName: chosen.apiName, login: chosen.login, base: chosen.base } : null
}

export async function forgejoTeaRequest(target: TeaIssueTarget & { path: string }, endpoint: string, signal: AbortSignal) {
  const tea = Bun.which('tea', { PATH: process.env.PATH })
  if (!tea) throw new RepositoryPullRequestError('Install the Gitea CLI on this host to read Forgejo issues.')
  const child = Bun.spawn([tea, 'api', '--include', '--login', target.login, '--repo', target.apiName,
    '--method', 'GET', target.base + '/api/v1/' + endpoint], {
    cwd: target.path, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', signal, timeout: 15_000,
  })
  const [stdout, diagnostics, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const status = Number(/^HTTP\/\S+ (\d{3})\b/mu.exec(diagnostics)?.[1])
  if (status === 401 || status === 403) throw new RepositoryPullRequestError('The selected Forgejo account cannot read this repository.', status)
  if (status === 404) throw new RepositoryPullRequestError('Forgejo could not find this resource.', status)
  if (status === 429) throw new RepositoryPullRequestError('Forgejo is rate limiting requests. Try again shortly.', status)
  if (exit !== 0 || status !== 200 || stdout.length > 16 * 1024 * 1024)
    throw new RepositoryPullRequestError('Forgejo could not load this resource. Check the configured CLI login.')
  let body: unknown
  try { body = JSON.parse(stdout) }
  catch { throw new RepositoryPullRequestError('Forgejo returned an unreadable response.') }
  const link = /^link:[^\r\n]*/imu.exec(diagnostics)?.[0]
  return { body, more: link ? /;\s*rel="?next"?\b/iu.test(link) : undefined }
}
