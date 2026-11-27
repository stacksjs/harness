import { linkedRepository } from './prompt-links'

export function cloneRemote(input: unknown): { remote: string, directory: string } {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Enter a Git repository URL.')
  const value = input.trim()
  if (!value || /[\s\x00-\x1F\x7F\\]/u.test(value)) throw new Error('Enter a Git repository URL.')
  const github = !value.includes('://') && linkedRepository(value)
  const scp = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)@([a-zA-Z0-9][a-zA-Z0-9.-]*):([a-zA-Z0-9._~/-]+)$/u.exec(value)
  let remote = github ? 'https://github.com/' + github + '.git' : value
  let pathname = scp?.[3]
  if (!pathname) {
    let url: URL
    try { url = new URL(remote) }
    catch { throw new Error('Enter an HTTPS or SSH Git URL, or a GitHub owner/repository.') }
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password || url.search || url.hash
      || (url.username && (url.protocol !== 'ssh:' || !/^[a-zA-Z0-9._-]+$/u.test(url.username))))
      throw new Error('Use a Git URL without embedded credentials or query parameters.')
    pathname = url.pathname
    remote = url.href
  }
  const directory = pathname.replace(/\/+$/u, '').split('/').at(-1)?.replace(/\.git$/iu, '')
  if (!directory || !/^[\p{L}\p{N}._-]+$/u.test(directory) || directory === '.' || directory === '..')
    throw new Error('The URL needs a repository name.')
  return { remote, directory }
}
