/** Configuration owned by the Paperclip deployment of this fork. */
export function createManagedProfile({ model, instructions }) {
  const split = typeof model === 'string' ? model.indexOf('/') : -1
  if (split <= 0 || split === model.length - 1 || !/^[a-z][a-z0-9-]*$/.test(model.slice(0, split))) {
    throw new Error('DeepSeek Harness requires an explicit provider/model identifier')
  }
  if (typeof instructions !== 'string' || !instructions.trim() || instructions.includes('\0') || Buffer.byteLength(instructions) > 256 * 1024) {
    throw new Error('DeepSeek Harness requires bounded, nonempty Paperclip instructions')
  }
  const provider = model.slice(0, split)
  const modelId = model.slice(split + 1)
  const envKey = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', google: 'GEMINI_API_KEY', xai: 'XAI_API_KEY' }[provider]
  return {
    provider, model: modelId,
    patch: [
      { id: 'acp', config: { provider, model: modelId, paperclipInstructions: instructions } },
      ...(provider === 'deepseek-official' ? [] : [{ id: 'llm-pi-ai', config: { providers: {
        [provider]: { ...(envKey ? { apiKeyEnv: envKey } : {}), models: [{ id: modelId }], retryPolicy: { mode: 'normal', maxRetries: 0 } },
      } } }]),
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { id: 'web-search-deepseek', disabled: true },
      { id: 'web-deepseek-api', disabled: true },
      ...['tool-fs-search', 'pwsh-sandbox', 'tool-pwsh', 'ptc-runtime', 'workflow-ptc', 'tool-workflow'].map(id => ({ id, disabled: true })),
    ],
  }
}

/** Convert only an explicitly selected Codex subscription's native auth record. */
export function codexSubscriptionRecord(auth) {
  const tokens = auth?.tokens
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token
    || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token
    || typeof tokens.account_id !== 'string' || !tokens.account_id) {
    throw new Error('A selected ChatGPT/Codex subscription credential is required')
  }
  let claims
  try { claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString('utf8')) }
  catch { throw new Error('The selected subscription credential has no token expiry') }
  if (!Number.isSafeInteger(claims.exp * 1000) || claims.exp <= 0) throw new Error('The selected subscription credential has no token expiry')
  return { kind: 'grant', payload: { type: 'oauth', access: tokens.access_token,
    refresh: tokens.refresh_token, expires: claims.exp * 1000, accountId: tokens.account_id } }
}

/** Unchanged credentials never acquire a new freshness timestamp. */
export function rotatedCodexSubscription(previous, current, now = new Date()) {
  if (current?.type !== 'oauth' || current.accountId !== previous.tokens.account_id
    || typeof current.access !== 'string' || !current.access || typeof current.refresh !== 'string' || !current.refresh) {
    throw new Error('DeepSeek subscription refresh changed the bound account or credential format')
  }
  if (current.access === previous.tokens.access_token && current.refresh === previous.tokens.refresh_token) return undefined
  return { ...previous, tokens: { ...previous.tokens, access_token: current.access,
    refresh_token: current.refresh }, last_refresh: now.toISOString() }
}
