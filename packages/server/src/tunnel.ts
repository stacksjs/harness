/**
 * Reaching harness from outside the network it is running on.
 *
 * Pairing (see `access.ts`) solves the phone on your sofa. It does not solve
 * the phone on a train, because a LAN address is not routable from anywhere
 * else. A tunnel is what closes that gap: a relay with a public address holds
 * the connection open and forwards to this process.
 *
 * ## A tunnel without authentication is a published shell
 *
 * This is the one rule the module exists to enforce. Harness starts agents, and
 * agents run tools; a public URL in front of an unauthenticated server is
 * remote code execution with a link. Worse, the check that would have caught it
 * cannot: a tunnel forwards from localhost, so every request it relays looks
 * like it came from this machine.
 *
 * So `open` refuses unless authentication is already on. Not a warning — a
 * refusal. The failure mode it prevents is silent and total.
 *
 * ## The relay sees ciphertext, not prompts
 *
 * The relay is a third party in the path. Over `https`/`wss` it forwards TLS it
 * cannot read, which is what makes this acceptable at all — but the *fact* of a
 * connection, its timing and its size are still visible to whoever runs it, and
 * a relay reached over plain http would see everything. Refused below, rather
 * than left to a reader to notice.
 */

export interface TunnelHandle {
  url: string
  close: () => Promise<void>
}

export interface TunnelOptions {
  port: number
  /** Relay to use. Defaults to the hosted one. */
  server?: string
  subdomain?: string
  /** Proof that authentication is on. Refuses without it. */
  authenticated: boolean
}

/**
 * Open a tunnel to this server.
 *
 * Imported lazily so a harness that never tunnels never loads it — and, more
 * usefully, so a broken or missing relay dependency cannot stop the server from
 * booting for everyone who does not use one.
 */
export async function open(options: TunnelOptions): Promise<TunnelHandle> {
  if (!options.authenticated) {
    throw new Error(
      'refusing to open a tunnel on a server without authentication: a public URL in front of '
      + 'harness is a public shell. Start with `--remote` and pair your devices first.',
    )
  }

  // Plain http to a *third party* means the relay reads everything in the
  // clear. A relay on this machine is not a third party and the bytes never
  // reach a network, so the rule that protects the one would only obstruct the
  // other — which is how a security check earns a reputation for being in the
  // way and gets switched off.
  const local = options.server ? /^(?:https?|wss?):\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::|\/|$)/.test(options.server) : false
  if (options.server && !local && /^(?:http|ws):\/\//.test(options.server)) {
    throw new Error(
      `refusing to relay through ${options.server}: it is plain http, so the relay would see every `
      + 'prompt and every file the agent reads. Use https:// or wss://.',
    )
  }

  const { startLocalTunnel } = await import('localtunnels')

  // `onConnect` fires before the call resolves, so the handle it hands out has
  // to be able to reach a client that does not exist yet. Holding the promise
  // rather than the client is what makes `close` honest instead of a no-op.
  let client: Promise<{ disconnect: () => Promise<void> }> | null = null

  const url = await new Promise<string>((resolve, reject) => {
    let settled = false
    const settle = (run: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      run()
    }
    const timer = setTimeout(
      () => settle(() => reject(new Error('the tunnel did not come up within 30s'))),
      30_000,
    )

    client = startLocalTunnel({
      port: options.port,
      ...(options.server ? { server: options.server } : {}),
      ...(options.subdomain ? { subdomain: options.subdomain } : {}),
      verbose: false,
      // Editing /etc/hosts is a reasonable thing for a tunnel CLI to offer and
      // an unreasonable thing for a server to do to a machine on its own.
      manageHosts: false,
      onConnect: ({ url: assigned }) => settle(() => resolve(assigned)),
      onError: error => settle(() => reject(error)),
    })

    client.catch((error: unknown) => settle(() => {
      reject(error instanceof Error ? error : new Error(String(error)))
    }))
  })

  return {
    url,
    close: async () => {
      // A tunnel left open outlives the server it points at, and the relay goes
      // on advertising a URL that answers nothing.
      await client?.then(c => c.disconnect()).catch(() => {})
    },
  }
}
