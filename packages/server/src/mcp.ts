/**
 * MCP servers, configured per profile.
 *
 * An agent is only as useful as the tools it can reach, and MCP is how it
 * reaches them. Attaching servers to a *profile* rather than globally is the
 * point: a work project wants its issue tracker and its database, a personal
 * one does not, and neither should inherit the other's credentials.
 *
 * ## Secrets are referenced, not stored
 *
 * An MCP config carries tokens — an `Authorization` header, an API key in
 * `env`. Harness records every command in an append-only log, in plaintext
 * SQLite, that exists precisely so it can be replayed and inspected. Writing a
 * live credential into it would put the secret in the one file designed never
 * to forget.
 *
 * So a value may be `${NAME}`, resolved from the server process's own
 * environment when the agent is spawned. The log holds the reference; the
 * secret stays wherever you already keep it. A literal value still works — this
 * is not a lock — but the reference is what the CLI suggests and what the docs
 * show.
 *
 * What this does *not* protect: a transcript records what the agent says. Ask
 * one to print a token and the token is in the log, exactly as it would be in
 * any chat history. Verified while testing this — the configuration held only
 * `${DEMO_WORD}`, and the single row containing the value was the assistant's
 * own reply after being asked for it. The guarantee is about what harness
 * writes, not about what an agent can be talked into saying.
 */

/** One MCP server as harness stores it. */
export interface McpServer {
  name: string
  transport: 'stdio' | 'sse' | 'http'
  /** stdio only. */
  command?: string
  args?: string[]
  /** stdio only. Values may be `${VAR}` references. */
  env?: Record<string, string>
  /** sse and http only. */
  url?: string
  /** sse and http only. Values may be `${VAR}` references. */
  headers?: Record<string, string>
  enabled: boolean
}

/**
 * Resolve `${VAR}` against an environment.
 *
 * An unset variable resolves to empty rather than throwing or leaving the
 * literal `${VAR}` in place. Leaving it would send the string `${GITHUB_TOKEN}`
 * as a bearer token, and the server would reject it with something unhelpful
 * about authentication rather than about configuration — `missing` in the
 * report below is what says the real thing.
 */
export function interpolate(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => env[name] ?? '')
}

/** Every `${VAR}` a server refers to that the environment does not have. */
export function missingReferences(server: McpServer, env: Record<string, string | undefined>): string[] {
  const missing = new Set<string>()
  const scan = (value: string): void => {
    for (const match of value.matchAll(/\$\{([A-Z0-9_]+)\}/gi)) {
      if (env[match[1]] === undefined) missing.add(match[1])
    }
  }

  for (const value of Object.values(server.env ?? {})) scan(value)
  for (const value of Object.values(server.headers ?? {})) scan(value)
  if (server.url) scan(server.url)
  for (const arg of server.args ?? []) scan(arg)

  return [...missing]
}

/** What a driver receives: the same server with every reference resolved. */
export type ResolvedMcpServer =
  | { name: string, type: 'stdio', command: string, args: string[], env: Record<string, string> }
  | { name: string, type: 'sse' | 'http', url: string, headers: Record<string, string> }

function resolveRecord(
  record: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record ?? {})) out[key] = interpolate(value, env)
  return out
}

/**
 * Prepare a profile's servers for a driver.
 *
 * Disabled servers are dropped rather than passed along disabled: the point of
 * the switch is that the agent never sees the tools, and a provider that
 * ignored an `enabled: false` flag would silently offer them anyway.
 *
 * A server missing its own required field is dropped too. A stdio entry with no
 * command cannot start, and handing it to the provider turns a configuration
 * mistake into a provider error several layers from the cause.
 */
export function resolveForDriver(
  servers: McpServer[],
  env: Record<string, string | undefined> = process.env,
): ResolvedMcpServer[] {
  const out: ResolvedMcpServer[] = []

  for (const server of servers) {
    if (!server.enabled) continue

    if (server.transport === 'stdio') {
      if (!server.command) continue
      out.push({
        name: server.name,
        type: 'stdio',
        command: interpolate(server.command, env),
        args: (server.args ?? []).map(arg => interpolate(arg, env)),
        env: resolveRecord(server.env, env),
      })
      continue
    }

    if (!server.url) continue
    out.push({
      name: server.name,
      type: server.transport,
      url: interpolate(server.url, env),
      headers: resolveRecord(server.headers, env),
    })
  }

  return out
}
