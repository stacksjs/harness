import { HarnessClient } from '@harness/client'
import { readLocalToken } from '@harness/server'

/**
 * A client of the running server, authenticated if it has to be.
 *
 * Every CLI command reaches the server the same way, so reading the local
 * token belongs here rather than in each command: the first one to forget it
 * works perfectly until someone turns on remote access, and then fails with
 * "could not reach the server" — which is true and completely misleading.
 *
 * The token is absent when the server is running without `--remote`, and
 * passing none is exactly right in that case.
 */
export async function connect(url: string): Promise<HarnessClient> {
  const token = await readLocalToken()
  const client = new HarnessClient({ url, ...(token ? { token } : {}) })
  await client.connect()
  return client
}
