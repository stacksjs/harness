import type { ProviderContextUsage } from './events'

const minimumTokens = 200_000
const unknownCacheMs = 70 * 60_000

export function claudeCompactionReturnAt(usage: ProviderContextUsage | undefined, reportedAt: number): number | undefined {
  if (!usage || !Number.isSafeInteger(usage.usedTokens) || usage.usedTokens < minimumTokens) return undefined
  const expiry = usage.promptCacheExpiresAt
  return typeof expiry === 'number' && Number.isSafeInteger(expiry) && expiry > 0
    ? expiry
    : reportedAt + unknownCacheMs
}
