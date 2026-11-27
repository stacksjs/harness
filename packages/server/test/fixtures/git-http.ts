import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export function fixtureGitRepository(root: string) {
  const working = join(root, 'seed')
  const remote = join(root, 'repositories')
  const bare = join(remote, 'notebook.git')
  mkdirSync(working, { recursive: true })
  mkdirSync(remote, { recursive: true })
  const git = (args: string[], cwd = working) => execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
  git(['init', '-qb', 'main'])
  writeFileSync(join(working, 'README.md'), 'Clone fixture notebook\n')
  git(['add', '--', 'README.md'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Initial commit'])
  git(['clone', '-q', '--bare', '--', working, bare])
  git(['update-server-info'], bare)
  return { remote, bare }
}

export function serveFixtureGit(root: string, beforeRead?: () => Promise<void>) {
  return Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      await beforeRead?.()
      const url = new URL(request.url)
      const path = resolve(root, '.' + decodeURIComponent(url.pathname))
      if (!path.startsWith(root + sep)) return new Response(null, { status: 404 })
      const file = Bun.file(path)
      if (!await file.exists()) return new Response(null, { status: 404 })
      return new Response(file, { headers: { 'content-type': 'application/octet-stream' } })
    },
  })
}
