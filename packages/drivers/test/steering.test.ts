import { expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexDriver } from '../src/codex'

const fixture = `
import { createInterface } from 'node:readline'
const readline = createInterface({ input: process.stdin })
readline.on('line', line => {
  const request = JSON.parse(line)
  if (!request.id) return
  const reply = value => console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...value }))
  if (request.method === 'initialize') reply({ result: {} })
  else if (request.method === 'thread/start') reply({ result: { thread: { id: 'native-thread' } } })
  else if (request.method === 'turn/start') {
    const { effort, serviceTier } = request.params
    if (effort !== 'high' || serviceTier !== 'fast')
      return reply({ error: { message: 'The selected Codex turn options were lost' } })
    reply({ result: { turn: { id: 'native-turn' } } })
  }
  else if (request.method === 'turn/steer') {
    const { threadId, expectedTurnId, input } = request.params
    if (threadId !== 'native-thread' || expectedTurnId !== 'native-turn' || input.length !== 1 || input[0].type !== 'text')
      return reply({ error: { message: 'Wrong active turn or input' } })
    if (input[0].text === 'Accept this') return reply({ result: { turnId: 'native-turn' } })
    if (input[0].text === 'Reply with a different turn') return reply({ result: { turnId: 'different-turn' } })
    if (input[0].text === 'Lose acknowledgement') process.exit(0)
    reply({ error: { message: 'Steering rejected' } })
  }
})
`

it('steers the exact native turn and distinguishes refusal from loss of acknowledgement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-codex-steering-'))
  try {
    const binaryPath = join(root, 'codex-fixture')
    writeFileSync(binaryPath, `#!${process.execPath}\n${fixture}`)
    chmodSync(binaryPath, 0o755)
    const instance = await CodexDriver.create({
      binaryPath, workspacePath: root, autoApprove: true, model: 'fixture-model',
      codexTurnOptions: { effort: 'high', serviceTier: 'fast' },
    })
    try {
      expect(await instance.steer?.('Too early')).toBe('rejected')
      const events = instance.startTurn({ text: 'Open active turn' })[Symbol.asyncIterator]()
      expect((await events.next()).value).toEqual({ type: 'session-bound', providerSessionId: 'native-thread' })
      expect((await events.next()).value).toEqual({ type: 'steering-ready' })
      expect(await instance.steer?.('Accept this')).toBe('delivered')
      expect(await instance.steer?.('Reject this')).toBe('rejected')
      expect(await instance.steer?.('Reply with a different turn')).toBe('uncertain')
      expect(await instance.steer?.('Lose acknowledgement')).toBe('uncertain')
    }
    finally {
      await instance.stop()
    }
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 5000)
