import { afterEach, expect, test } from 'bun:test'
import { access } from 'node:fs/promises'
import { codexEnvironment } from '../src/account-environment'
import { managedChatGptArgs, openManagedChatGptBroker } from '../src/chatgpt/token-broker'

let active: Awaited<ReturnType<typeof openManagedChatGptBroker>> | undefined
afterEach(async () => {
  await active?.close()
  active = undefined
})

test('the private helper gets a fresh token without placing it in the Codex launch configuration', async () => {
  let count = 0
  const broker = active = await openManagedChatGptBroker(async () => `fixture-token-${++count}`)
  const socket = broker.args.at(-2)!
  const overrides = managedChatGptArgs(broker.program, broker.args)
  expect(overrides.join(' ')).toContain('model_provider="openai_token_sharing"')
  expect(overrides.join(' ')).not.toContain('fixture-token')
  const unauthorised = Bun.spawn([broker.program, ...broker.args.slice(0, -1), 'wrong-capability'], {
    stdout: 'pipe', stderr: 'pipe',
  })
  expect(await unauthorised.exited).toBe(1)
  expect(await new Response(unauthorised.stdout).text()).toBe('')
  expect(count).toBe(0)

  for (const expected of ['fixture-token-1\n', 'fixture-token-2\n']) {
    const helper = Bun.spawn([broker.program, ...broker.args], { stdout: 'pipe', stderr: 'pipe' })
    expect(await helper.exited).toBe(0)
    expect(await new Response(helper.stdout).text()).toBe(expected)
  }

  await broker.close()
  active = undefined
  expect(await access(socket).then(() => true, () => false)).toBe(false)
}, 15_000)

test('only the managed mode uses the dedicated home and drops ambient provider overrides', () => {
  const host = {
    CODEX_HOME: '/host/codex',
    ACCESS_TOKEN: 'fixture-token',
    OPENAI_API_KEY: 'fixture-api-key',
    OPENAI_BASE_URL: 'https://example.test',
    PATH: '/usr/bin',
  }
  expect(codexEnvironment({ workspacePath: '/project' }, host)).toBe(host)
  expect(codexEnvironment({
    workspacePath: '/project',
    home: '/private/managed-codex',
    chatGptPlan: { connected: async () => true, accessToken: async () => 'fixture-plan-token' },
  }, host)).toEqual({ CODEX_HOME: '/private/managed-codex', PATH: '/usr/bin' })
})
