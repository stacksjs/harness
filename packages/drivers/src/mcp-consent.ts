import type { ApprovalChoice, ApprovalScope, ConnectorApproval } from '@harness/contract'

// Adapted from T3 Code apps/server/src/provider/CodexMcpElicitation.ts at
// 431da7f4e55b82b386e68a9f32c543fac2efedf5. See T3CODE-LICENSE.md.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type ConsentScope = Extract<ApprovalScope, 'once' | 'session' | 'always'>

export type McpConsentResponse =
  | { action: 'accept', content: Record<string, JsonValue>, _meta?: { persist: 'session' | 'always' } }
  | { action: 'decline' | 'cancel' }

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function persistence(value: unknown): 'session' | 'always' | undefined {
  if (typeof value !== 'string') return
  const normalized = value.toLowerCase()
  if (normalized.includes('session')) return 'session'
  if (/always|permanent|forever|persistent/u.test(normalized)) return 'always'
}

function fieldOptions(field: Record<string, unknown>): { value: string, label?: string }[] {
  if (Array.isArray(field.oneOf)) {
    return field.oneOf.flatMap((item) => {
      const option = record(item)
      return typeof option?.const === 'string'
        ? [{ value: option.const, label: typeof option.title === 'string' ? option.title : undefined }]
        : []
    })
  }
  const labels = Array.isArray(field.enumNames) ? field.enumNames : []
  return strings(field.enum).map((value, index) => ({ value, label: typeof labels[index] === 'string' ? labels[index] : undefined }))
}

function persistFlag(key: string, field: Record<string, unknown>): boolean {
  return field.type === 'boolean' && (key.toLowerCase() === 'persist'
    || Boolean(persistence(key) ?? persistence(field.title) ?? persistence(field.description)))
}

function visibleText(input: unknown, length: number): string | undefined {
  if (typeof input !== 'string') return
  return input.replace(/[\x00-\x1f\x7f]+/gu, ' ').replace(/https?:\/\/[^\s]+/giu, '[link omitted]').trim().slice(0, length) || undefined
}

interface McpConsent {
  name: string
  connector: ConnectorApproval
  accepted: Map<ConsentScope, McpConsentResponse>
}

/** Only forms that can be answered by a consent decision belong in this card. */
export function prepareMcpConsent(payload: Record<string, unknown>, provider: 'codex' | 'claude'): McpConsent | undefined {
  if (payload.mode !== undefined && payload.mode !== 'form') return
  const schema = record(payload.requestedSchema)
  if (!schema || (schema.type !== undefined && schema.type !== 'object')) return
  if (schema.properties !== undefined && !record(schema.properties)) return
  const required = strings(schema.required)
  if (schema.required != null && (!Array.isArray(schema.required) || required.length !== schema.required.length)) return
  const fields = Object.entries(record(schema.properties) ?? {}).flatMap(([key, raw]) => {
    const field = record(raw)
    return field ? [{ key, field, options: fieldOptions(field), flag: persistFlag(key, field) }] : []
  })
  const meta = record(payload._meta)
  const labels = new Map<'session' | 'always', string>()
  for (const value of typeof meta?.persist === 'string' ? [meta.persist] : strings(meta?.persist)) {
    const scope = persistence(value)
    if (scope) labels.set(scope, '')
  }
  if (meta?.allowPersistentApproval === true) labels.set('always', '')
  for (const { field, options, flag } of fields) {
    for (const option of options) {
      const scope = persistence(option.value)
      if (scope) labels.set(scope, visibleText(option.label, 70) ?? '')
    }
    if (flag) labels.set('always', visibleText(field.title, 70) ?? '')
  }

  const accepted = new Map<ConsentScope, McpConsentResponse>()
  const supported: ConsentScope[] = provider === 'claude' ? ['once'] : ['once', ...labels.keys()]
  for (const scope of supported) {
    const values: Array<[string, JsonValue]> = []
    for (const { key, field, options, flag } of fields) {
      const choice = options.find(({ value }) => scope === 'once'
        ? /^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$/iu.test(value.trim())
        : persistence(value) === scope)
      if (choice) values.push([key, choice.value])
      else if (flag) values.push([key, scope === 'always'])
      else if (provider === 'codex' && field.default != null) values.push([key, field.default as JsonValue])
    }
    const content = Object.fromEntries(values)
    if (required.some(key => !Object.hasOwn(content, key))) continue
    accepted.set(scope, { action: 'accept', content, ...(scope === 'once' ? {} : { _meta: { persist: scope } }) })
  }
  if (!accepted.has('once')) return
  const choices: ApprovalChoice[] = [
    { decision: 'cancelled', scope: 'once', label: 'Cancel' },
    { decision: 'denied', scope: 'once', label: 'Decline' },
  ]
  if (accepted.has('session')) choices.push({ decision: 'allowed', scope: 'session', label: labels.get('session') || 'Always allow this session' })
  if (accepted.has('always')) choices.push({ decision: 'allowed', scope: 'always', label: labels.get('always') || 'Always allow' })
  choices.push({ decision: 'allowed', scope: 'once', label: 'Approve' })
  const target = record(meta?.target)
  const tool = record(meta?.tool_params)
  const inferred = typeof payload.message === 'string' ? /^Allow ChatGPT to use (.+?)\?$/iu.exec(payload.message)?.[1] : undefined
  const name = [
    payload.displayName, meta?.app_name, meta?.appName, meta?.app, target?.app, target?.name, tool?.app_name,
    tool?.app, inferred, meta?.connector_name, meta?.connectorName, payload.serverName,
  ].map(value => visibleText(value, 100)).find(Boolean) ?? 'MCP connector'
  const prompt = visibleText(payload.description, 600) ?? visibleText(payload.message, 600) ?? 'Approve this connector request?'
  return { name, connector: { prompt, choices }, accepted }
}
