import { expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexDriver } from '../src/codex'

it.skipIf(process.platform === 'win32')('generates ephemeral commit text using the selected Codex account', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'harness-commit-generator-'))
  try {
    const binary = join(fixture, 'codex')
    const account = join(fixture, 'account')
    const observed = join(fixture, 'observed.json')
    await writeFile(binary, `#!${process.execPath}
const args = Bun.argv.slice(2)
const schema = await Bun.file(args[args.indexOf('--output-schema') + 1]).json()
await Bun.write(${JSON.stringify(observed)}, JSON.stringify({
  args, schema, home: process.env.CODEX_HOME, cwd: process.cwd(), prompt: await Bun.stdin.text(),
}))
await Bun.write(args[args.indexOf('--output-last-message') + 1], JSON.stringify({
  subject: 'Describe the selected edit', body: '', branch: 'feature/selected-edit',
}))
`, { mode: 0o700 })
    const result = await CodexDriver.generateCommitMessage!({ workspacePath: fixture, home: account, binaryPath: binary, model: 'fixture-model' }, {
      patch: '+Selected code', includeBranch: true, signal: AbortSignal.timeout(5000),
    })
    expect(result).toEqual({ subject: 'Describe the selected edit', body: '', branch: 'feature/selected-edit' })
    const launch = JSON.parse(await readFile(observed, 'utf8'))
    expect(launch).toMatchObject({
      args: expect.arrayContaining(['--ignore-user-config', '--ephemeral', 'read-only', 'never', 'fixture-model']),
      home: account,
      schema: { required: ['subject', 'body', 'branch'], additionalProperties: false },
    })
    expect(launch.prompt).toContain('+Selected code')
    expect(launch.cwd).not.toBe(fixture)
    expect(await Bun.file(join(launch.cwd, 'message.json')).exists()).toBe(false)

    const plan = { connected: async () => true, accessToken: async () => 'fixture-private-plan-token' }
    await CodexDriver.generateCommitMessage!({ workspacePath: fixture, home: account, binaryPath: binary, chatGptPlan: plan }, {
      patch: '+Selected plan edit', includeBranch: false, signal: AbortSignal.timeout(5000),
    })
    const managed = await readFile(observed, 'utf8')
    expect(JSON.parse(managed)).toMatchObject({
      args: expect.arrayContaining(['model_provider="openai_token_sharing"']),
      home: account, schema: { required: ['subject', 'body'] }, prompt: expect.stringContaining('+Selected plan edit'),
    })
    expect(managed).not.toContain('fixture-private-plan-token')
  }
  finally { await rm(fixture, { recursive: true, force: true }) }
})
