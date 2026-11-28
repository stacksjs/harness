import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { readLocalToken } from '@harness/server'

type Options = { port?: number | string }
type StartOptions = Options & { input?: string, key?: string }

async function call(profile: string, path: string, options: Options, query: Record<string, string> = {}, body?: object) {
  try {
    const port = Number(options.port ?? 3789)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a host port between 1 and 65535.')
    if (!/^[1-9]\d*$/u.test(profile)) throw new Error('Use a profile ID from ./buddy profiles:list.')
    const url = new URL('http://127.0.0.1:' + port + '/workflows' + path)
    url.search = new URLSearchParams({ ...query, profile }).toString()
    const token = await readLocalToken()
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { ...(token && { authorization: 'Bearer ' + token }), ...(body && { 'content-type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }),
    })
    const result = await response.json().catch(() => ({ error: 'host-request-failed' }))
    console.log(JSON.stringify(result, null, 2))
    if (!response.ok) process.exitCode = 1
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not reach the Harness host.')
    process.exitCode = 1
  }
}

export default function (cli: CLI) {
  cli.command('harness:workflow:start <profile> <name>', 'Start a workflow on the local Harness host')
    .option('--key [key]', 'Stable start key')
    .option('--input [json]', 'Workflow input as JSON')
    .option('--port [port]', 'Local Harness port')
    .action(async (profile: string, name: string, options: StartOptions) => {
      if (!options.key) {
        console.error('Supply a stable key with --key.')
        process.exitCode = 1
        return
      }
      let payload: unknown
      try { payload = JSON.parse(options.input ?? 'null') }
      catch {
        console.error('Supply valid JSON with --input.')
        process.exitCode = 1
        return
      }
      await call(profile, '/start', options, {}, { workflow: name, key: options.key, payload })
    })
  cli.command('harness:workflow:list <profile>', 'List workflow definitions and recent runs')
    .option('--port [port]', 'Local Harness port')
    .action((profile: string, options: Options) => call(profile, '', options))
  cli.command('harness:workflow:show <profile> <run>', 'Show a workflow run and its steps')
    .option('--port [port]', 'Local Harness port')
    .action((profile: string, id: string, options: Options) => call(profile, '/run', options, { id }))
  for (const action of ['resume', 'cancel'] as const) {
    cli.command('harness:workflow:' + action + ' <profile> <run>', action === 'resume' ? 'Resume a paused workflow' : 'Cancel a workflow')
      .option('--port [port]', 'Local Harness port')
      .action((profile: string, id: string, options: Options) => call(profile, '/' + action, options, {}, { id }))
  }
}
