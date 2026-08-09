import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { worktree } from '@harness/server'
import { boot } from '../Support/engine'

/**
 * See and tidy the checkouts `--isolate` leaves behind.
 *
 * A worktree is a full checkout on disk and the log does not own it, so on a
 * large repository they add up quickly and invisibly. Deleting a profile now
 * releases its worktrees on its own — but that only covers the sessions harness
 * knows about, and it is not the only way one gets orphaned: a crash mid-turn
 * leaves a directory with nothing pointing at it.
 *
 * So: make the state visible first. Automatic cleanup you cannot inspect is how
 * a tool ends up deleting something it should not have and nobody notices for a
 * week.
 */

/** Every repository harness has a workspace in. */
async function repositories(): Promise<string[]> {
  const engine = await boot()
  return [...new Set([...engine.current.workspaces.values()].map(w => w.path))]
}

export default function (cli: CLI) {
  cli
    .command('harness:worktrees', 'List the worktrees harness has created')
    .action(async () => {
      let found = 0

      for (const repository of await repositories()) {
        const entries = (await worktree.list(repository)).filter(entry => entry.sessionId !== null)
        if (entries.length === 0) continue

        console.log(repository)
        for (const entry of entries) {
          const state = entry.dirty ? 'uncommitted changes' : 'clean'
          console.log(`  session ${String(entry.sessionId).padEnd(12)} ${(entry.branch ?? '—').padEnd(26)} ${state}`)
          found += 1
        }
      }

      if (found === 0) {
        console.log('No harness worktrees. Sessions started with `--isolate` create them.')
        return
      }
      console.log('')
      console.log('  Release one:  ./buddy harness:worktrees:remove <sessionId>')
      console.log('  Its branch is kept either way — the branch is the work, the directory is scratch.')
    })

  cli
    .command('harness:worktrees:prune', 'Forget worktrees whose directories are already gone')
    .action(async () => {
      for (const repository of await repositories()) await worktree.prune(repository)
      // Nothing to report: `git worktree prune` is silent about what it cleared,
      // and inventing a count by diffing the list around it would be a
      // guess dressed as a fact.
      console.log('pruned every workspace repository')
    })

  cli
    .command('harness:worktrees:remove <sessionId>', "Release a session's worktree, keeping its branch")
    .action(async (sessionId: string) => {
      const id = Number(sessionId)

      for (const repository of await repositories()) {
        const entry = (await worktree.list(repository)).find(w => w.sessionId === id)
        if (!entry) continue

        const result = await worktree.release(repository, entry.path)
        if (!result.removed) {
          console.error(`Could not remove ${entry.path}: ${result.reason ?? 'git refused'}`)
          process.exit(1)
        }

        // Committed rather than discarded, and said out loud: work an agent
        // left behind is exactly what nobody wants deleted quietly.
        if (result.committed)
          console.log(`  committed what was left on ${entry.branch} as ${result.committed.slice(0, 8)}`)
        console.log(`released ${entry.path}`)
        console.log(`  branch ${entry.branch} is still there`)
        return
      }

      console.error(`No worktree for session ${id}. Run \`./buddy harness:worktrees\` to list them.`)
      process.exit(1)
    })
}
