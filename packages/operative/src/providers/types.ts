import type { ResponseFormat, ToolChoice } from '../structured-output/types.ts';

export type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
  TokenUsage,
} from '../types.ts';

/**
 * Provider names supported by operative providers.
 */
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'voyage' | 'ollama';

/**
 * Provider-neutral reasoning-effort tier. Superset of Tribunal's
 * `effort IN ('low','medium','high','xhigh','max')` database CHECK
 * constraint. Each shipped provider maps this to its own native mechanism —
 * see `providers/shared/effort.ts` for the per-provider mapping table and
 * the fallback matrix used when a resolved model doesn't support a tier.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Base options shared across all provider factories.
 */
export interface BaseProviderOptions {
  /**
   * Provider-native model ID, OR a shorthand alias resolved once at
   * provider-construction time — see `providers/shared/model-registry.ts`
   * for the per-provider alias table and its single resolution point.
   * Full provider-native IDs pass through unchanged. The alias `'inherit'`
   * is never resolved here; it is a caller-side concern (see that module's
   * doc comment).
   */
  model: string;
  /**
   * Provider-neutral effort tier. Mapped to the resolved model's native
   * mechanism, with a deterministic fallback when unsupported — see
   * `providers/shared/effort.ts`. The actually-used tier is reported back
   * on `GenerateResponse.metadata.effectiveEffort`.
   */
  effort?: Effort | undefined;
  maximumTokens?: number | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  stopSequences?: string[] | undefined;
  toolChoice?: ToolChoice | undefined;
  responseFormat?: ResponseFormat | undefined;
  /**
   * Provider-neutral per-run request metadata, attached to every generate
   * request of the run. Mapped to each provider's native field: Anthropic
   * Messages `metadata`; OpenAI Chat Completions `metadata` (native
   * string-keyed map, up to 16 keys). Gemini has no request-level metadata
   * field in its API — this option is an explicit no-op for
   * {@link createGeminiProvider}.
   *
   * Anthropic caveat: its `Metadata` type documents exactly one field
   * (`user_id`) — the whole object is still forwarded as-is so a
   * credential-injecting proxy (see `AnthropicProviderOptions.baseURL`)
   * can inspect arbitrary keys on the wire, but sending non-`user_id` keys
   * straight to Anthropic's real endpoint (no proxy in front) gets the
   * request rejected. Only pass extra keys when a proxy will translate or
   * strip them before forwarding.
   */
  requestMetadata?: Record<string, string> | undefined;
}

/**
 * Provider-neutral result of a server-side token count, per AB-64.
 *
 * Replaces the two provisional, SDK-shaped response types this package
 * shipped ahead of AB-64 (Gemini's `{ totalTokens?, cachedContentTokenCount? }`
 * and Anthropic's `{ input_tokens }`) with one shape both
 * `createGeminiTokenCounter` and `createAnthropicTokenCounter` map onto at
 * their own boundary. The two SDKs do not agree on optionality here: `@google/genai`'s
 * `CountTokensResponse.totalTokens` is optional (the whole response is a
 * loosely-typed class with every field optional), but `@anthropic-ai/sdk`'s
 * `MessageTokensCount.input_tokens` is required—Anthropic's `countTokens`
 * response always carries a count. `totalTokens` is still required here, for
 * both adapters uniformly: AB-64 requires it, and normalizing Gemini's
 * genuinely-absent case to `0` once, at the mapping boundary, is simpler than
 * pushing a `?? 0` onto every caller. Against the official SDK response type
 * `createAnthropicTokenCounter` never actually observes an absent count to
 * normalize—but `AnthropicTokenCountingClient` deliberately keeps
 * `input_tokens` optional too, for a caller-supplied client or proxy `baseURL`
 * that omits it, and the `?? 0` fallback does cover that boundary. `cachedTokens` stays
 * optional and is never fabricated as `0`—Anthropic's `messages.countTokens`
 * reports no cache attribution at all, so its adapter always omits the field,
 * and Gemini's adapter omits it whenever the SDK response omits
 * `cachedContentTokenCount`.
 */
export interface TokenCountResult {
  readonly totalTokens: number;
  readonly cachedTokens?: number | undefined;
  readonly provider: ProviderName;
  readonly model: string;
}
