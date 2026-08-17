/**
 * Configurable OpenAI-compatible vision-provider catalog. Ported in spirit
 * from visionDS's `providers.json` (see `docs/adr/rp_dshPlugins.md`'s
 * visionDS review for why that catalog was worth keeping), but every
 * provider resolves its key through `ctx.credentials` — never a raw env var
 * read inline, and never a per-call override the model can supply (visionDS's
 * `--api-key`/`--base-url` flags were exactly the gap that made an
 * attacker-choosable exfiltration destination possible; this plugin's tool
 * schema exposes neither).
 * @module dsh-plugin-vision-bridge/providers
 */

/** One OpenAI-compatible chat-completions vision route. */
export interface ProviderConfig {
  /** Stable id used in `providerOrder` and error messages. */
  id: string
  /** Human-readable label for diagnostics. */
  label: string
  /** Endpoint base; `/chat/completions` is appended if missing. */
  baseUrl: string
  model: string
  /** `ctx.credentials` reference naming this provider's bearer token/API key. */
  credentialRef: string
  /** Header name for the key when it isn't a `Bearer` token. Defaults to `Authorization` with a `Bearer ` prefix. */
  authHeaderName?: string
  /** Request field carrying the output-token cap. Defaults to `max_tokens`. */
  maxTokensField?: string
}

/**
 * Default catalog, matching visionDS's provider list so an existing
 * deployment's credential names/endpoints can be reused unchanged: point
 * `ctx.credentials` at the same env vars visionDS's `.env.example` documents
 * (`MIMO_API_KEY`, `GLM_API_KEY`, `ARK_API_KEY`, `DASHSCOPE_API_KEY`,
 * `MOONSHOT_API_KEY`, `OPENAI_API_KEY`) and this plugin resolves them the
 * same way, just through the credential seam instead of `os.environ` directly.
 */
export const DEFAULT_PROVIDERS: readonly ProviderConfig[] = [
  {
    id: 'mimo',
    label: '小米 MiMo V2.5',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5',
    credentialRef: 'MIMO_API_KEY',
    authHeaderName: 'api-key',
    maxTokensField: 'max_completion_tokens',
  },
  {
    id: 'glm',
    label: '智谱 GLM 视觉',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6v',
    credentialRef: 'GLM_API_KEY',
  },
  {
    id: 'ark',
    label: '火山方舟（豆包视觉）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-1-6-vision-250815',
    credentialRef: 'ARK_API_KEY',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼 Qwen-VL',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max',
    credentialRef: 'DASHSCOPE_API_KEY',
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi 视觉',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-32k-vision-preview',
    credentialRef: 'MOONSHOT_API_KEY',
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    credentialRef: 'OPENAI_API_KEY',
  },
]

/** Append `/chat/completions` to a configured base URL unless it's already there. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`
}

/** Build the auth header(s) for one provider's resolved key. Never logged or echoed back to the model. */
export function authHeaders(provider: ProviderConfig, apiKey: string): Record<string, string> {
  if (provider.authHeaderName !== undefined) return { [provider.authHeaderName]: apiKey }
  return { Authorization: `Bearer ${apiKey}` }
}

/** Order providers by `providerOrder`, appending any catalog entries the order list omitted. */
export function orderedProviders(catalog: readonly ProviderConfig[], providerOrder: readonly string[]): ProviderConfig[] {
  const byId = new Map(catalog.map(p => [p.id, p] as const))
  const ordered: ProviderConfig[] = []
  for (const id of providerOrder) {
    const provider = byId.get(id)
    if (provider !== undefined) {
      ordered.push(provider)
      byId.delete(id)
    }
  }
  ordered.push(...byId.values())
  return ordered
}
