import type { DriverKind } from '@harness/contract'
import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import type { HarnessClient } from '@harness/client'
import { derivedId } from '@harness/engine'
import { ExitCode } from '@stacksjs/types'
import { connect } from '../Support/client'

/**
 * Drive one agent turn from the terminal.
 *
 * A thin client of the running server, not a second runtime: the session it
 * creates is visible in the desktop app and on a phone, because there is only
 * ever one execution boundary. That is the deliberate divergence from pi, whose
 * TUI owns an in-process agent and therefore cannot do this.
 */

function commandId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export default function (cli: CLI) {
  cli
    .command('harness:run <prompt>', 'Run one agent turn against a workspace')
    .option('--url [url]', 'Server websocket URL', { default: 'ws://127.0.0.1:3789/ws' })
    .option('--profile [name]', 'Profile to create the workspace under', { default: 'CLI' })
    .option('--path [path]', 'Workspace path', { default: process.cwd() })
    .option('--yes', 'Approve tool calls automatically', { default: false })
    .option('--driver [kind]', 'Agent to run the turn (claude, codex, ...)', { default: 'claude' })
    .option('--model [model]', "Model override; omit to use the provider's default")
    .option('--isolate', 'Run in a git worktree of its own, on its own branch', { default: false })
    .action(async (prompt: string, options: { url: string, profile: string, path: string, yes: boolean, driver: string, model?: string, isolate?: boolean }) => {
      let client: HarnessClient
      try {
        client = await connect(options.url)
      }
      catch {
        console.error(`Could not reach the harness server at ${options.url}.`)
        console.error('Start it with `./buddy harness:serve`.')
        process.exit(ExitCode.FatalError)
      }

      // Reuse a profile/workspace when one already matches, so repeated runs in
      // the same directory continue in one place rather than accumulating
      // near-duplicate workspaces.
      const existingWorkspace = [...client.state.workspaces.values()].find(w => w.path === options.path)

      let workspaceId: number
      if (existingWorkspace) {
        workspaceId = existingWorkspace.id
      }
      else {
        const profileCmd = commandId('profile')
        await client.dispatch(profileCmd, { type: 'profile.create', name: options.profile })
        const workspaceCmd = commandId('workspace')
        await client.dispatch(workspaceCmd, {
          type: 'workspace.add',
          profileId: derivedId(profileCmd),
          path: options.path,
        })
        workspaceId = derivedId(workspaceCmd)
      }

      if (!client.state.workspaces.get(workspaceId)?.trusted) {
        // Trust is a decision, not a default. Running the command is that
        // decision for this directory.
        await client.dispatch(commandId('trust'), { type: 'workspace.trust', workspaceId, trusted: true })
      }

      const sessionCmd = commandId('session')
      await client.dispatch(sessionCmd, {
        type: 'session.create',
        workspaceId,
        driverKind: options.driver as DriverKind,
        ...(options.model ? { model: options.model } : {}),
        ...(options.isolate ? { isolate: true } : {}),
      })
      const sessionId = derivedId(sessionCmd)
      client.subscribe(sessionId)

      let done = false
      let failure: string | null = null
      client.onEvent((event) => {
        const payload = event.payload
        switch (payload.type) {
          case 'assistant.delta':
            process.stdout.write(payload.text)
            break
          case 'tool.call.began':
            process.stdout.write(`\n  · ${payload.toolName}\n`)
            break
          case 'approval.requested':
            process.stdout.write(`\n  ? ${payload.toolName} wants to run. Approving...\n`)
            void client.dispatch(commandId('approve'), {
              type: 'session.approval.respond',
              sessionId,
              approvalId: payload.approvalId,
              decision: options.yes ? 'allowed' : 'denied',
              scope: 'once',
            }).catch(() => {})
            break
          case 'turn.completed':
            process.stdout.write(`\n\n  ${payload.tokensIn} in / ${payload.tokensOut} out · $${(payload.cost / 1_000_000).toFixed(4)}\n`)
            done = true
            break
          case 'turn.interrupted':
            process.stdout.write('\n  interrupted\n')
            done = true
            break
          // A failed turn used to end this command silently with status 0 —
          // indistinguishable from an agent that had nothing to say. The
          // provider's own message is the useful part ("run `codex login`",
          // "you've hit your usage limit"), so print it and fail the exit code
          // so a script notices.
          case 'session.failed':
            process.stderr.write(`\n  ${payload.message}\n`)
            failure = payload.message
            done = true
            break
        }
      })

      await client.dispatch(commandId('turn'), { type: 'session.turn.start', sessionId, text: prompt })

      // The turn runs on the server; this waits for its terminal event.
      const deadline = Date.now() + 15 * 60_000
      while (!done && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 50))

      client.close()

      // A turn that never reached a terminal event is not a success either —
      // the deadline expiring means the server or the agent stopped talking.
      if (!done && !failure)
        process.stderr.write('\n  the turn produced no terminal event before the deadline\n')

      process.exit(failure || !done ? ExitCode.FatalError : ExitCode.Success)
    })
}
