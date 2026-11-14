import type { MediaLimits, Modality, ModalityMatrix } from 'conversationalist';

import type { ModelPricing } from '@lostgradient/operative';
import {
  EFFORT_ORDER,
  FULL_PARAMETER_COMPATIBILITY,
  aliasesFor,
  anthropicSamplingSupport,
  backendPricing,
  deepFreeze,
  degradationOf,
  portableTiers,
  type BackendDescriptor,
  type BaseProviderOptions,
  type Effort,
  type EffortSupport,
  type MediaCount,
  type ModelLimitEntry,
} from '@lostgradient/operative/provider-kit';

// The Anthropic catalog: its models' limits, modalities, prices, aliases and effort support, and the
// rows the plugin offers. Repricing a model or adding one is an edit to this file alone.

// ── Modality matrices ───────────────────────────────────────────────────────

const UNSUPPORTED_MODALITY_ENTRY: ModalityMatrix[Modality] = {
  input: false,
  output: false,
  sourceForms: [],
};

// https://platform.claude.com/docs/en/build-with-claude/vision — confirmed
// 2026-09-02: base64, URL, and the Files API (provider-file) are all
// documented input forms for image content on `messages`. Anthropic's
// `messages` endpoint has no audio or video input/output and no image or
// audio generation.
const ANTHROPIC_MODALITIES: ModalityMatrix = Object.freeze({
  text: { input: true, output: true, sourceForms: ['inline'] },
  image: {
    input: true,
    output: false,
    sourceForms: ['inline', 'data-url', 'remote-url', 'provider-file'],
  },
  document: {
    input: true,
    output: false,
    sourceForms: ['inline', 'data-url', 'remote-url', 'provider-file'],
  },
  audio: UNSUPPORTED_MODALITY_ENTRY,
  video: UNSUPPORTED_MODALITY_ENTRY,
  file: UNSUPPORTED_MODALITY_ENTRY,
});

// ── Limits ──────────────────────────────────────────────────────────────────
export const ANTHROPIC_LIMITS: Readonly<Record<string, ModelLimitEntry>> = Object.freeze({
  // https://platform.claude.com/docs/en/models/fable-5-1/overview — confirmed 2026-10-13.
  'claude-fable-5-1': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // Same page, "Claude Fable 5.1 and Claude Mythos 5.1": Mythos 5.1 "shares
  // Claude Fable 5.1's specifications and pricing" — confirmed 2026-10-13.
  'claude-mythos-5-1': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/overview (compare-models table) — confirmed 2026-10-13.
  'claude-opus-5-5': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/opus-5/overview — confirmed 2026-10-13.
  'claude-opus-5': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/overview (compare-models table) — confirmed 2026-10-13.
  'claude-sonnet-5-5': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/overview (compare-models table) — confirmed 2026-10-13.
  'claude-haiku-5-5': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/fable-5/overview — confirmed 2026-09-02.
  'claude-fable-5': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // Same page, "Fable vs. Mythos": Mythos 5 "shares Claude Fable 5's
  // specifications and pricing" — confirmed 2026-09-02.
  'claude-mythos-5': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/opus-4-8/overview — confirmed 2026-09-02.
  'claude-opus-4-8': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/opus-4-7/overview — confirmed 2026-09-02.
  'claude-opus-4-7': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/overview (compare-models table) — confirmed 2026-09-02.
  'claude-sonnet-5': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/opus-4-6/overview — confirmed 2026-09-02.
  'claude-opus-4-6': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/opus-4-5/overview — confirmed 2026-09-02.
  'claude-opus-4-5': { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
  // https://platform.claude.com/docs/en/models/sonnet-4-6/overview — confirmed 2026-09-02.
  'claude-sonnet-4-6': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/overview (compare-models table) — confirmed 2026-09-02.
  'claude-haiku-4-5': { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
  // Retired (https://platform.claude.com/docs/en/about-claude/model-deprecations
  // lists it retired June 15, 2026; its dedicated model page no longer
  // publishes specs). Value is Anthropic's originally published Claude Opus 4
  // specification, not reconfirmed live on 2026-09-02.
  'claude-opus-4-20250514': { contextWindowTokens: 200_000, maxOutputTokens: 32_000 },
  // Retired (same deprecations page, June 15, 2026). Value is Anthropic's
  // originally published Claude Sonnet 4 specification (64K with the
  // extended-output beta header), not reconfirmed live on 2026-09-02.
  'claude-sonnet-4-20250514': { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
  // No dedicated Anthropic model page or deprecation-history row exists for
  // this exact retired id (`anthropicPricingTable` still prices it, and
  // Anthropic does not publish a standalone spec page for it). Value is
  // Claude Haiku 4.5's pre-128K-generation defaults (200K/64K), the closest
  // documented sibling in the same Haiku 4-generation line; not an
  // independently sourced figure for this specific model id.
  'claude-haiku-4-20250506': { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
  // Long-standing published Claude 3.5 Sonnet specification. Retired
  // (deprecations page: deprecated Aug 13 2025, retired Oct 28 2025), so no
  // live model page remains to reconfirm against on 2026-09-02.
  'claude-3-5-sonnet-20241022': { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
  // Long-standing published Claude 3.5 Haiku specification. Retired
  // (deprecations page: deprecated Dec 19 2025, retired Feb 19 2026), so no
  // live model page remains to reconfirm against on 2026-09-02.
  'claude-3-5-haiku-20241022': { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
});

const ANTHROPIC_MODALITIES_TABLE: Readonly<Record<string, ModalityMatrix>> = Object.freeze({
  // ANTHROPIC_MODALITIES above — https://platform.claude.com/docs/en/build-with-claude/vision,
  // confirmed 2026-09-02. The overview's "All current models support text and image input"
  // covers the 5.1 / 5.5 / Opus 5 rows below, confirmed 2026-10-13.
  'claude-fable-5-1': ANTHROPIC_MODALITIES,
  'claude-mythos-5-1': ANTHROPIC_MODALITIES,
  'claude-opus-5-5': ANTHROPIC_MODALITIES,
  'claude-opus-5': ANTHROPIC_MODALITIES,
  'claude-sonnet-5-5': ANTHROPIC_MODALITIES,
  'claude-haiku-5-5': ANTHROPIC_MODALITIES,
  'claude-fable-5': ANTHROPIC_MODALITIES,
  'claude-mythos-5': ANTHROPIC_MODALITIES,
  'claude-opus-4-8': ANTHROPIC_MODALITIES,
  'claude-opus-4-7': ANTHROPIC_MODALITIES,
  'claude-sonnet-5': ANTHROPIC_MODALITIES,
  'claude-opus-4-6': ANTHROPIC_MODALITIES,
  'claude-opus-4-5': ANTHROPIC_MODALITIES,
  'claude-sonnet-4-6': ANTHROPIC_MODALITIES,
  'claude-haiku-4-5': ANTHROPIC_MODALITIES,
  'claude-opus-4-20250514': ANTHROPIC_MODALITIES,
  'claude-sonnet-4-20250514': ANTHROPIC_MODALITIES,
  'claude-haiku-4-20250506': ANTHROPIC_MODALITIES,
  'claude-3-5-sonnet-20241022': ANTHROPIC_MODALITIES,
  'claude-3-5-haiku-20241022': ANTHROPIC_MODALITIES,
});

/** One model's limits; throws for a model with no row, so a model added elsewhere without limits fails loudly. */
function requireLimits(model: string): ModelLimitEntry {
  const entry = Object.hasOwn(ANTHROPIC_LIMITS, model) ? ANTHROPIC_LIMITS[model] : undefined;
  if (!entry) throw new Error(`model-catalog: no limits entry for anthropic/${model}`);
  return entry;
}

/** One model's modality matrix; throws for a model with no row. */
function requireModalities(model: string): ModalityMatrix {
  const entry = Object.hasOwn(ANTHROPIC_MODALITIES_TABLE, model)
    ? ANTHROPIC_MODALITIES_TABLE[model]
    : undefined;
  if (!entry) throw new Error(`model-catalog: no modalities entry for anthropic/${model}`);
  return entry;
}

// ── Pricing ─────────────────────────────────────────────────────────────────

/**
 * Cache pricing multipliers, applied to a model's `promptCostPerMillionTokens`
 * below. Anthropic prices a 5-minute prompt-cache write at 1.25x the base
 * input rate and a cache read at 0.1x; OpenAI prices a cached-input hit at
 * 0.5x with no separate write charge. Source: Anthropic's and OpenAI's
 * published pricing pages (prompt caching / cached input sections).
 */
const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;
const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;
/** Anthropic prices cache reads on Claude Fable 5.1 and Claude Mythos 5.1 at 0.025x input. */
const ANTHROPIC_FABLE_5_1_CACHE_READ_MULTIPLIER = 0.025;
/** Anthropic prices cache reads on Claude Opus 5.5 and Claude Sonnet 5.5 at 0.05x input. */
const ANTHROPIC_5_5_CACHE_READ_MULTIPLIER = 0.05;

function anthropicCachePricing(
  promptCostPerMillionTokens: number,
  cacheReadMultiplier = ANTHROPIC_CACHE_READ_MULTIPLIER,
) {
  return {
    cacheWriteCostPerMillionTokens: promptCostPerMillionTokens * ANTHROPIC_CACHE_WRITE_MULTIPLIER,
    cacheReadCostPerMillionTokens: promptCostPerMillionTokens * cacheReadMultiplier,
  };
}

function anthropicPricing(
  promptCostPerMillionTokens: number,
  completionCostPerMillionTokens: number,
  cacheReadMultiplier?: number,
): ModelPricing {
  return {
    promptCostPerMillionTokens,
    completionCostPerMillionTokens,
    ...anthropicCachePricing(promptCostPerMillionTokens, cacheReadMultiplier),
  };
}

/** Anthropic list prices by model, at the rates the models' documentation pages publish. */
export const anthropicPricingTable: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // Anthropic current models, at the first-party list prices on Anthropic's pricing page
  // (platform.claude.com/docs/en/about-claude/pricing, read 2026-10-13). Cache writes use the
  // 5-minute rate; consumers on the 1-hour TTL (2x input) can override via `customPricing`.
  // Claude Haiku 5.5 moves to $0.50 / $2.50 for a request over 100K input tokens (`longContext`).
  'claude-fable-5-1': anthropicPricing(10, 50, ANTHROPIC_FABLE_5_1_CACHE_READ_MULTIPLIER),
  'claude-mythos-5-1': anthropicPricing(10, 50, ANTHROPIC_FABLE_5_1_CACHE_READ_MULTIPLIER),
  'claude-fable-5': anthropicPricing(10, 50),
  'claude-mythos-5': anthropicPricing(10, 50),
  'claude-opus-5-5': anthropicPricing(4, 20, ANTHROPIC_5_5_CACHE_READ_MULTIPLIER),
  'claude-opus-5': anthropicPricing(5, 25),
  'claude-opus-4-8': anthropicPricing(5, 25),
  'claude-opus-4-7': anthropicPricing(5, 25),
  'claude-opus-4-6': anthropicPricing(5, 25),
  'claude-opus-4-5': anthropicPricing(5, 25),
  'claude-sonnet-5-5': anthropicPricing(2, 10, ANTHROPIC_5_5_CACHE_READ_MULTIPLIER),
  'claude-sonnet-5': anthropicPricing(2, 10),
  'claude-sonnet-4-6': anthropicPricing(3, 15),
  'claude-haiku-5-5': {
    ...anthropicPricing(0.1, 0.5),
    longContext: { inputTokensAbove: 100_000, ...anthropicPricing(0.5, 2.5) },
  },
  'claude-haiku-4-5': anthropicPricing(1, 5),

  // Anthropic Claude 4 / 3.5 dated snapshots
  'claude-opus-4-20250514': {
    promptCostPerMillionTokens: 15,
    completionCostPerMillionTokens: 75,
    ...anthropicCachePricing(15),
  },
  'claude-sonnet-4-20250514': {
    promptCostPerMillionTokens: 3,
    completionCostPerMillionTokens: 15,
    ...anthropicCachePricing(3),
  },
  'claude-haiku-4-20250506': {
    promptCostPerMillionTokens: 0.8,
    completionCostPerMillionTokens: 4,
    ...anthropicCachePricing(0.8),
  },
  'claude-3-5-sonnet-20241022': {
    promptCostPerMillionTokens: 3,
    completionCostPerMillionTokens: 15,
    ...anthropicCachePricing(3),
  },
  'claude-3-5-haiku-20241022': {
    promptCostPerMillionTokens: 0.8,
    completionCostPerMillionTokens: 4,
    ...anthropicCachePricing(0.8),
  },
});

// ── Aliases ─────────────────────────────────────────────────────────────────
/** Anthropic shorthand aliases. Mirrors Tribunal's `sonnet|opus|haiku|fable` vocabulary. */
export const ANTHROPIC_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
});

function resolveModelAlias(model: string, aliases: Readonly<Record<string, string>>): string {
  if (model === 'inherit') return model;
  return (Object.hasOwn(aliases, model) ? aliases[model] : undefined) ?? model;
}

/** Resolves an Anthropic shorthand alias (or full model ID) to a concrete model ID. */
export function resolveAnthropicModel(model: string): string {
  return resolveModelAlias(model, ANTHROPIC_MODEL_ALIASES);
}

// ── Effort ──────────────────────────────────────────────────────────────────
/**
 * Anthropic `output_config.effort` support by resolved model ID, per
 * https://platform.claude.com/docs/en/build-with-claude/effort (effort-levels
 * table and per-model sections, confirmed 2026-10-13):
 * - Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5.5, Opus 5, Opus 4.8,
 *   Opus 4.7, Sonnet 5.5, Sonnet 5, Haiku 5.5: full `low` .. `max` range,
 *   including `xhigh`.
 * - Opus 4.6, Sonnet 4.6: `low` .. `max`, no `xhigh`.
 * - Opus 4.5: `low` .. `high` only (the page lists it under neither `xhigh`
 *   nor `max`).
 * - Haiku 4.5 and Sonnet 4.5 or earlier: no effort parameter support at all.
 * A resolved model absent from this table is treated conservatively as
 * unsupported (empty list) — the effort parameter is omitted rather than
 * guessed at.
 */
export const ANTHROPIC_EFFORT_SUPPORT: Readonly<Record<string, readonly Effort[]>> = Object.freeze({
  'claude-fable-5-1': EFFORT_ORDER,
  'claude-mythos-5-1': EFFORT_ORDER,
  'claude-fable-5': EFFORT_ORDER,
  'claude-mythos-5': EFFORT_ORDER,
  'claude-opus-5-5': EFFORT_ORDER,
  'claude-opus-5': EFFORT_ORDER,
  'claude-opus-4-8': EFFORT_ORDER,
  'claude-opus-4-7': EFFORT_ORDER,
  'claude-sonnet-5-5': EFFORT_ORDER,
  'claude-sonnet-5': EFFORT_ORDER,
  'claude-haiku-5-5': EFFORT_ORDER,
  'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
  'claude-opus-4-5': ['low', 'medium', 'high'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
});

/**
 * Resolves the requested effort tier to what Anthropic will actually
 * receive on `output_config.effort` for the resolved model. Returns
 * `undefined` when the model has no effort support at all — the caller
 * must omit `output_config` in that case.
 */
export function resolveAnthropicEffort(
  requested: Effort,
  resolvedModel: string,
): Effort | undefined {
  const supported = Object.hasOwn(ANTHROPIC_EFFORT_SUPPORT, resolvedModel)
    ? (ANTHROPIC_EFFORT_SUPPORT[resolvedModel] ?? [])
    : [];
  if (supported.length === 0) return undefined;
  if (supported.includes(requested)) return requested;

  const requestedIndex = EFFORT_ORDER.indexOf(requested);
  return (
    EFFORT_ORDER.slice(0, requestedIndex)
      .toReversed()
      .find((tier) => supported.includes(tier)) ?? supported[0]
  );
}
// ── Rows ────────────────────────────────────────────────────────────────────

/**
 * Anthropic rows advertise `temperature` and `topP` only for a model that
 * `shared/sampling.ts` records as accepting them — current Claude models
 * reject non-default sampling with a 400. A model the documentation does not
 * settle is treated the same way, conservatively. Everything else, including
 * `toolChoice` (`auto` and `none` stay valid where forced choice is not), is
 * unchanged.
 */
function anthropicParameterCompatibility(model: string): readonly (keyof BaseProviderOptions)[] {
  if (anthropicSamplingSupport(model) === 'accepted') return FULL_PARAMETER_COMPATIBILITY;
  return FULL_PARAMETER_COMPATIBILITY.filter(
    (field) => field !== 'temperature' && field !== 'topP',
  );
}

/**
 * Anthropic models offered only to organizations accepted into Anthropic's
 * verification programs, per https://platform.claude.com/docs/en/models/mythos-5-1/overview
 * ("available only to organizations verified through Anthropic's verification
 * programs, such as the Cyber Verification Program"; the Mythos 5 page says the
 * same, status "Active (verification required)"). Whether a given caller is
 * verified is invisible to a static seed, so these rows report `'unknown'`
 * rather than `'available'`; `'unavailable'` would exclude the model for
 * verified organizations too.
 */
const ACCESS_RESTRICTED_ANTHROPIC_MODELS: ReadonlySet<string> = new Set([
  'claude-mythos-5',
  'claude-mythos-5-1',
]);

// Per-provider media caps. A modality with no entry has no known cap; an
// absent figure is "unknown", never "unlimited". Each figure was checked against
// the page named beside it on 2026-10-17. Request-total caps (Anthropic 32 MB,
// OpenAI 512 MB, Gemini 20 MB inline) span every modality and `MediaLimits` has
// no whole-request field, so they are not modelled.
//
// Anthropic: https://platform.claude.com/docs/en/build-with-claude/vision
// ("Request limits"): up to 100 images per request when the model's context
// window is 200k tokens, 600 for every other model; 10 MB per image
// (base64-encoded) on the Claude API directly. These rows target the direct
// Messages API; Amazon Bedrock and Google Cloud cap an image at 5 MB.
const ANTHROPIC_MEDIA_LIMITS: readonly MediaLimits[] = deepFreeze([
  { scope: 'per-part', modality: 'image', maxBytes: 10 * 1024 * 1024 },
]);
function anthropicMediaCounts(contextWindowTokens: number): readonly MediaCount[] {
  return deepFreeze([
    { modality: 'image', maxPerRequest: contextWindowTokens === 200_000 ? 100 : 600 },
  ]);
}

function buildAnthropicRow(model: string, freshness: string): BackendDescriptor {
  const limits = requireLimits(model);
  const pricingRow = backendPricing(
    Object.hasOwn(anthropicPricingTable, model) ? anthropicPricingTable[model] : undefined,
  );
  return {
    provider: 'anthropic',
    endpoint: 'messages',
    model,
    aliases: aliasesFor(model, ANTHROPIC_MODEL_ALIASES),
    lifecycle: 'stable',
    modalities: requireModalities(model),
    mimeFamilies: ['text', 'image', 'document'],
    mediaLimits: ANTHROPIC_MEDIA_LIMITS,
    mediaCounts: anthropicMediaCounts(limits.contextWindowTokens),
    providerFetchesRemoteUrls: true,
    // https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use,
    // checked 2026-10-22: a tool_result's content may hold text, image, and document blocks.
    // Chat Completions tool messages (OpenAI) are text only, and the Gemini 2.x rows here
    // have no documented multimodal function response, so those rows declare none.
    toolResultModalities: ['image', 'document'],
    contextWindowTokens: limits.contextWindowTokens,
    maxOutputTokens: limits.maxOutputTokens,
    streaming: true,
    tools: true,
    parallelTools: true,
    structuredOutput: true,
    parameterCompatibility: anthropicParameterCompatibility(model),
    caching: true,
    batchInference: true,
    explicitThinkingRequest: true,
    serverSideTokenCounting: true,
    effort: anthropicEffort(model),
    ...(pricingRow !== undefined ? { pricing: pricingRow } : {}),
    availability: ACCESS_RESTRICTED_ANTHROPIC_MODELS.has(model) ? 'unknown' : 'available',
    health: 'unknown',
    source: 'static',
    freshness,
  };
}

function anthropicEffort(model: string): EffortSupport {
  const degradesTo = degradationOf((tier) => resolveAnthropicEffort(tier, model));
  return { portable: portableTiers(degradesTo), nativeMapping: 'native', degradesTo };
}

/** The options of {@link anthropicRows}. */
export interface AnthropicRowsOptions {
  /** The `freshness` stamped on every row. Defaults to the time of the call. */
  readonly freshness?: string | undefined;
}

/**
 * The catalog rows of the Anthropic models, one per model, frozen. The Anthropic plugin passes
 * them as its provider's `rows`.
 */
export function anthropicRows(options?: AnthropicRowsOptions): readonly BackendDescriptor[] {
  const freshness = options?.freshness ?? new Date().toISOString();
  return Object.freeze(
    Object.keys(ANTHROPIC_LIMITS).map((model) => deepFreeze(buildAnthropicRow(model, freshness))),
  );
}
