import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

interface ManagedChatGptBroker {
  program: string
  args: string[]
  close: () => Promise<void>
}

/** A private local token channel. Codex tools do not inherit a plan token in their environment. */
export async function openManagedChatGptBroker(accessToken: () => Promise<string>): Promise<ManagedChatGptBroker> {
  const directory = await mkdtemp(join(tmpdir(), 'harness-plan-'))
  const socket = join(directory, 'token.sock')
  const capability = randomBytes(32).toString('base64url')
  const expected = Buffer.from(`Bearer ${capability}`)

  try {
    const server = Bun.serve({
      unix: socket,
      async fetch(request) {
        const presented = Buffer.from(request.headers.get('authorization') ?? '')
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/token'
          || presented.length !== expected.length || !timingSafeEqual(presented, expected))
          return new Response(null, { status: 403 })
        try {
          const token = await accessToken()
          if (!token) return new Response(null, { status: 503 })
          return new Response(token, { headers: { 'cache-control': 'no-store' } })
        }
        catch {
          return new Response(null, { status: 503 })
        }
      },
    })
    return {
      program: process.execPath,
      args: ['--no-env-file', `--config=${devNull}`, join(import.meta.dir, 'token-helper.ts'), socket, capability],
      async close() {
        await server.stop(true)
        await rm(directory, { recursive: true, force: true })
      },
    }
  }
  catch {
    await rm(directory, { recursive: true, force: true })
    throw new Error('Could not start the private ChatGPT token channel.')
  }
}

// Adapted from CodexManagedRuntime.ts at the pinned T3 Code revision. Keep
// the provider ID stable because Codex stores it in resumable threads.
export function managedChatGptArgs(program: string, args: readonly string[]): string[] {
  return [
    'model_provider="openai_token_sharing"',
    `model_providers.openai_token_sharing={name="ChatGPT plan",base_url="https://api.openai.com/v1",model_catalog_url="https://api.openai.com/v1/models",wire_api="responses",requires_openai_auth=false,supports_websockets=false,auth={command=${JSON.stringify(program)},args=${JSON.stringify(args)},timeout_ms=15000,refresh_interval_ms=0}}`,
    'features.api_key_model_discovery=true',
  ].flatMap(value => ['-c', value])
}
