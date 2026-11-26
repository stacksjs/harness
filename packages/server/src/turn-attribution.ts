/**
 * Determines which paths belong to a turn when Git moved HEAD between its snapshots.
 * Adapted from T3 Code's listAuthoredPaths at 431da7f4e55b82b386e68a9f32c543fac2efedf5.
 * Copyright (c) 2026 T3 Tools Inc. MIT. See ../../drivers/T3CODE-LICENSE.md.
 */

type ReadGit = (cwd: string, args: string[], limit?: number, stdin?: string) => Promise<{ ok: boolean, out: string }>

const maxHistory = 2_000
const maxOutput = 4 * 1024 * 1024
const objectId = /^[\da-f]{40}(?:[\da-f]{24})?$/u
const moveSubject = /^(?:$|(?:checkout|reset|branch|clone|fetch)\b|[^:]*\((?:start|finish|abort|reset)\): |(?:merge|pull|rebase|cherry-pick)\b[^()]*: fast-forward$)/iu

export async function listTurnAuthoredPaths(git: ReadGit, cwd: string, before: string, after: string): Promise<Set<string> | null> {
  if (!objectId.test(before) || !objectId.test(after) || before === after) return null
  const deadline = Date.now() + 5_000
  const read = async (args: string[], stdin?: string) => {
    if (Date.now() >= deadline) throw new Error('Git attribution timed out')
    const result = await git(cwd, ['-c', 'log.showSignature=false', '-c', 'diff.relative=false', ...args], maxOutput, stdin)
    if (!result.ok || result.out.includes('\ufffd')) throw new Error('Cannot attribute this Git comparison')
    return result.out
  }
  const lines = async (args: string[], stdin?: string) => (await read(args, stdin)).trimEnd().split('\n').filter(Boolean)
  const paths = async (args: string[], stdin?: string) =>
    (await read([...args, '--name-only', '-z', '--no-renames', '--no-ext-diff'], stdin)).split('\0').filter(Boolean)
  const commitPaths = async (revisions: string[], stdin?: string) => {
    const args = ['log', '--format=', ...revisions]
    try { return await paths([...args, '--diff-merges=remerge'], stdin) }
    catch {
      // Older Git lacks remerge diffs. Keep a merge path changed on more than one side.
      const combined = await paths([...args, '--cc'], stdin)
      const merges = await lines(['rev-list', '--merges', '--parents', ...revisions], stdin)
      for (const merge of merges) {
        const parents = merge.split(' ').slice(1)
        const [base] = await lines(['merge-base', '--octopus', ...parents])
        if (!base) continue
        const counts = new Map<string, number>()
        for (const parent of parents) {
          for (const path of new Set(await paths(['diff', base, parent]))) counts.set(path, (counts.get(path) ?? 0) + 1)
        }
        for (const [path, count] of counts) if (count > 1) combined.push(path)
      }
      return combined
    }
  }

  try {
    const [first, last] = await lines(['log', '--no-walk=unsorted', '--format=%ct %P', before, after])
    const [since, startHead] = first?.split(' ') ?? []
    const [until, endHead] = last?.split(' ') ?? []
    if (!since || !until || !startHead || !endHead || !/^\d+$/u.test(since) || !/^\d+$/u.test(until)
      || !objectId.test(startHead) || !objectId.test(endHead) || startHead === endHead) return null

    const historyArgs = [`--max-age=${since}`, `--max-count=${maxHistory + 1}`]
    const [recent, startEdits, endEdits, removed] = await Promise.all([
      lines(['rev-list', ...historyArgs, `${startHead}..${endHead}`]),
      paths(['diff', startHead, before]),
      paths(['diff', endHead, after]),
      commitPaths([`${endHead}..${startHead}`]),
    ])
    if (recent.length > maxHistory) return null

    const reflogs = async (extra: string[], refs?: string[]) => {
      const records = await lines(['log', '--walk-reflogs', `--max-age=${since}`, '--date=unix',
        '--format=%H%x00%gD%x00%gs', ...extra, ...(refs?.length ? ['--ignore-missing', '--stdin'] : [])],
      refs?.length ? refs.join('\n') + '\n' : undefined)
      return records.flatMap((record) => {
        const [commit, selector, subject = ''] = record.split('\0')
        const at = selector?.match(/@\{(\d+)\}$/u)?.[1]
        return commit && objectId.test(commit) && at && Number(at) <= Number(until) ? [{ commit, subject }] : []
      })
    }
    const containing = async (commits: string[], namespace: 'refs/remotes' | 'refs/heads') => {
      const refs = new Set<string>()
      for (let offset = 0; offset < commits.length; offset += 64) {
        const batch = commits.slice(offset, offset + 64)
        for (const ref of await lines(['for-each-ref', '--format=%(refname)', ...batch.flatMap(commit => ['--contains', commit]), namespace])) refs.add(ref)
      }
      return [...refs]
    }

    let own = recent
    if (recent.length) {
      const remoteRefs = await containing(recent, 'refs/remotes')
      if (remoteRefs.length) {
        const fetched = new Set((await reflogs([], remoteRefs))
          .filter(entry => entry.subject !== 'update by push').map(entry => entry.commit))
        if (fetched.size) {
          const delivered = new Set(await lines(['rev-list', ...historyArgs, '--stdin'],
            [...fetched, `^${startHead}`].join('\n') + '\n'))
          if (delivered.size > maxHistory) return null
          const localRefs = await containing(recent.filter(commit => delivered.has(commit)), 'refs/heads')
          const created = new Set((await reflogs(['--exclude=refs/*', '--all'], localRefs))
            .filter(entry => !moveSubject.test(entry.subject)).map(entry => entry.commit))
          own = recent.filter(commit => !delivered.has(commit) || created.has(commit))
        }
      }
    }
    const committed = own.length ? await commitPaths(['--no-walk=unsorted', '--stdin'], own.join('\n') + '\n') : []
    return new Set([...startEdits, ...endEdits, ...removed, ...committed])
  }
  catch {
    // Unreadable history must never be used to hide changes.
    return null
  }
}
