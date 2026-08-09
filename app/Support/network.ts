import { networkInterfaces } from 'node:os'

/**
 * The address a phone on the same network would actually use.
 *
 * `0.0.0.0` is what the server binds, but printing it helps nobody: it is not
 * an address anything can connect to. The first non-internal IPv4 is the one a
 * device on the same wifi can reach.
 */
export function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}
