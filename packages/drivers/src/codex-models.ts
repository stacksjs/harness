import type { ProviderModel } from './types'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// Adapted from the model/list mapping in apps/server/src/provider/CodexProvider.ts
// at T3 Code 431da7f4e55b82b386e68a9f32c543fac2efedf5. See T3CODE-LICENSE.md.
export function parseCodexModelPage(value: unknown): { models: ProviderModel[], cursor?: string } {
  const page = record(value)
  if (!Array.isArray(page.data)) throw new Error('Codex returned an invalid model list.')
  const models: ProviderModel[] = []
  for (const rawModel of page.data) {
    const model = record(rawModel)
    const id = text(model.model)
    if (!id || model.hidden === true) continue

    const rawEfforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []
    const reasoningEfforts = [...new Set(rawEfforts.map(effort => text(record(effort).reasoningEffort)).filter(effort => effort !== undefined))]
    const defaultReasoningEffort = text(model.defaultReasoningEffort)
    const serviceTiers = Array.isArray(model.serviceTiers) ? model.serviceTiers : []
    const speedTiers = new Map<string, string>()
    for (const rawTier of serviceTiers) {
      const tier = record(rawTier)
      const tierId = text(tier.id)
      if (tierId) speedTiers.set(tierId, text(tier.name) ?? tierId)
    }
    if (!speedTiers.size && Array.isArray(model.additionalSpeedTiers)) {
      for (const rawTier of model.additionalSpeedTiers) {
        const tierId = text(rawTier)
        if (tierId) speedTiers.set(tierId, tierId === 'fast' ? 'Fast' : tierId)
      }
    }
    const defaultSpeedTier = text(model.defaultServiceTier)
    models.push({
      id,
      name: text(model.displayName) ?? id,
      isDefault: model.isDefault === true,
      reasoningEfforts,
      ...(defaultReasoningEffort && reasoningEfforts.includes(defaultReasoningEffort) ? { defaultReasoningEffort } : {}),
      speedTiers: [...speedTiers].map(([id, name]) => ({ id, name })),
      ...(defaultSpeedTier && speedTiers.has(defaultSpeedTier) ? { defaultSpeedTier } : {}),
    })
  }
  const cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
  return { models, cursor }
}
