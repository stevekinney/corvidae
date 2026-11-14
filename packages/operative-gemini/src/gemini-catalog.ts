import type { MediaLimits, Modality, ModalityMatrix } from 'conversationalist';

import type { ModelPricing } from '@lostgradient/operative';
import {
  FULL_PARAMETER_COMPATIBILITY,
  aliasesFor,
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

// The Gemini catalog: its models' limits, modalities, prices, aliases and effort support, and the
// rows the plugin offers. Repricing a model or adding one is an edit to this file alone.

// ── Modality matrices ───────────────────────────────────────────────────────

const UNSUPPORTED_MODALITY_ENTRY: ModalityMatrix[Modality] = {
  input: false,
  output: false,
  sourceForms: [],
};

// https://ai.google.dev/gemini-api/docs/audio and
// https://ai.google.dev/gemini-api/docs/video-understanding — confirmed
// 2026-09-02: `generateContent` accepts audio input ("Gemini can analyze
// audio input and generate text responses") and video input (inline bytes,
// `remote-url`-shaped YouTube/file URLs, or a prior File-API upload) on the
// 2.5/2.0 family this seed covers. Neither page documents audio or video
// *output* on `generateContent` (that is a separate Live/TTS surface), so
// both stay output: false.
// `remote-url` is listed for every Gemini model: on a Gemini 2.0 row it is the
// `providerFetchesRemoteUrls: false` flag (`model-catalog-rows.ts`), not this
// list, that refuses a remote URL, so the host resolves it instead.
const GEMINI_MODALITIES: ModalityMatrix = Object.freeze({
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
  audio: {
    input: true,
    output: false,
    sourceForms: ['inline', 'data-url', 'remote-url', 'provider-file'],
  },
  video: {
    input: true,
    output: false,
    sourceForms: ['inline', 'data-url', 'remote-url', 'provider-file'],
  },
  file: UNSUPPORTED_MODALITY_ENTRY,
});

// ── Limits ──────────────────────────────────────────────────────────────────
export const GEMINI_LIMITS: Readonly<Record<string, ModelLimitEntry>> = Object.freeze({
  // Long-standing published Gemini 2.5 Pro specification
  // (ai.google.dev/gemini-api/docs/models); the per-model docs page returned
  // 404 on 2026-09-02, so this is not independently reconfirmed live.
  'gemini-2.5-pro': { contextWindowTokens: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.5-flash': { contextWindowTokens: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.0-flash': { contextWindowTokens: 1_048_576, maxOutputTokens: 8_192 },
});

const GEMINI_MODALITIES_TABLE: Readonly<Record<string, ModalityMatrix>> = Object.freeze({
  // GEMINI_MODALITIES above — https://ai.google.dev/gemini-api/docs/audio and
  // https://ai.google.dev/gemini-api/docs/video-understanding, confirmed 2026-09-02.
  'gemini-2.5-pro': GEMINI_MODALITIES,
  'gemini-2.5-flash': GEMINI_MODALITIES,
  'gemini-2.0-flash': GEMINI_MODALITIES,
});

/** One model's limits; throws for a model with no row, so a model added elsewhere without limits fails loudly. */
function requireLimits(model: string): ModelLimitEntry {
  const entry = Object.hasOwn(GEMINI_LIMITS, model) ? GEMINI_LIMITS[model] : undefined;
  if (!entry) throw new Error(`model-catalog: no limits entry for gemini/${model}`);
  return entry;
}

/** One model's modality matrix; throws for a model with no row. */
function requireModalities(model: string): ModalityMatrix {
  const entry = Object.hasOwn(GEMINI_MODALITIES_TABLE, model)
    ? GEMINI_MODALITIES_TABLE[model]
    : undefined;
  if (!entry) throw new Error(`model-catalog: no modalities entry for gemini/${model}`);
  return entry;
}

// ── Pricing ─────────────────────────────────────────────────────────────────
/** Gemini list prices by model. */
export const geminiPricingTable: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'gemini-2.5-pro': { promptCostPerMillionTokens: 1.25, completionCostPerMillionTokens: 10 },
  'gemini-2.5-flash': { promptCostPerMillionTokens: 0.15, completionCostPerMillionTokens: 0.6 },
  'gemini-2.0-flash': { promptCostPerMillionTokens: 0.1, completionCostPerMillionTokens: 0.4 },
});

// ── Aliases ─────────────────────────────────────────────────────────────────
/** The shorthand aliases {@link resolveGeminiModel} resolves, each to a Gemini model. */
export const GEMINI_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  pro: 'gemini-2.5-pro',
  flash: 'gemini-2.5-flash',
  'flash-lite': 'gemini-2.0-flash',
});

function resolveModelAlias(model: string, aliases: Readonly<Record<string, string>>): string {
  if (model === 'inherit') return model;
  return (Object.hasOwn(aliases, model) ? aliases[model] : undefined) ?? model;
}

/** Resolves a Gemini shorthand alias (or full model ID) to a concrete model ID. */
export function resolveGeminiModel(model: string): string {
  return resolveModelAlias(model, GEMINI_MODEL_ALIASES);
}

// ── Effort ──────────────────────────────────────────────────────────────────
/**
 * Gemini models that expose `config.thinkingConfig` — the 2.5
 * family. `gemini-2.0-flash` has no thinking mode at all, so effort is
 * degraded to "omit" for it.
 */
export const GEMINI_THINKING_MODELS: ReadonlySet<string> = new Set([
  'gemini-2.5-pro',
  'gemini-2.5-flash',
]);

/**
 * Approximate `thinkingBudget` token allotments per provider-neutral tier.
 * `max` maps to Gemini's dynamic-thinking sentinel (`-1`), letting the
 * model decide its own budget rather than capping it.
 */
const GEMINI_EFFORT_BUDGETS: Readonly<Record<Effort, number>> = Object.freeze({
  low: 1024,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: -1,
});

/** What {@link resolveGeminiEffort} resolves a requested tier to, for a thinking model. */
export interface GeminiResolvedEffort {
  /** The tier the model takes, which a request for a higher one degrades to. */
  effort: Effort;
  /** The `thinkingBudget` the tier maps to: a token count, or `-1` for a dynamic budget. */
  thinkingBudget: number;
}

/**
 * Resolves the requested effort tier to a Gemini `thinkingBudget` for the
 * resolved model. Returns `undefined` when the model has no thinking mode
 * at all — the caller must omit `thinkingConfig` in that case.
 */
export function resolveGeminiEffort(
  requested: Effort,
  resolvedModel: string,
): GeminiResolvedEffort | undefined {
  if (!GEMINI_THINKING_MODELS.has(resolvedModel)) return undefined;
  return { effort: requested, thinkingBudget: GEMINI_EFFORT_BUDGETS[requested] };
}
// ── Rows ────────────────────────────────────────────────────────────────────
const GEMINI_PARAMETER_COMPATIBILITY: readonly (keyof BaseProviderOptions)[] =
  FULL_PARAMETER_COMPATIBILITY.filter((field) => field !== 'requestMetadata');

// Gemini: https://ai.google.dev/gemini-api/docs/image-understanding: "a maximum
// of 3,600 image files per request".
const GEMINI_MEDIA_COUNTS: readonly MediaCount[] = deepFreeze([
  { modality: 'image', maxPerRequest: 3600 },
]);
// https://ai.google.dev/gemini-api/docs/file-input-methods: inline data is capped by
// the 20 MB request total, so no single inline part exceeds 20 MB; a part larger than
// that must go through the Files API (a `provider-file` handle, which carries no size
// here). A public URL is fetched per request up to 15 MB per file, which Gemini
// enforces itself, so the 20 MB cap below over-counts a remote URL by 5 MB at most.
// The per-part cap lets a remote URL of unknown size be costed at the cap instead
// of refused as unbounded, consistent with `providerFetchesRemoteUrls`.
const GEMINI_MEDIA_LIMITS: readonly MediaLimits[] = deepFreeze(
  (['image', 'document', 'audio', 'video'] as const).map((modality) => ({
    scope: 'per-part' as const,
    modality,
    maxBytes: 20 * 1024 * 1024,
  })),
);

function buildGeminiRow(model: string, freshness: string): BackendDescriptor {
  const limits = requireLimits(model);
  const pricingRow = backendPricing(
    Object.hasOwn(geminiPricingTable, model) ? geminiPricingTable[model] : undefined,
  );
  return {
    provider: 'gemini',
    endpoint: 'generateContent',
    model,
    aliases: aliasesFor(model, GEMINI_MODEL_ALIASES),
    lifecycle: 'stable',
    modalities: requireModalities(model),
    mimeFamilies: ['text', 'image', 'document', 'audio', 'video'],
    mediaLimits: GEMINI_MEDIA_LIMITS,
    mediaCounts: GEMINI_MEDIA_COUNTS,
    // https://ai.google.dev/gemini-api/docs/file-input-methods: a public HTTPS
    // URL is accepted as an external URL (up to 15 MB per file, fetched per
    // request), but "Gemini 2.0 models don't support this method"; on those the
    // host fetches the bytes through the resolver.
    providerFetchesRemoteUrls: !model.startsWith('gemini-2.0'),
    contextWindowTokens: limits.contextWindowTokens,
    maxOutputTokens: limits.maxOutputTokens,
    streaming: true,
    tools: true,
    parallelTools: true,
    structuredOutput: true,
    // Gemini has no request-level metadata field; createGeminiProvider
    // treats it as an explicit no-op (providers/types.ts:56-72).
    parameterCompatibility: GEMINI_PARAMETER_COMPATIBILITY,
    caching: true,
    batchInference: true,
    explicitThinkingRequest: false,
    serverSideTokenCounting: true,
    effort: geminiEffort(model),
    ...(pricingRow !== undefined ? { pricing: pricingRow } : {}),
    availability: 'available',
    health: 'unknown',
    source: 'static',
    freshness,
  };
}

function geminiEffort(model: string): EffortSupport {
  const degradesTo = degradationOf((tier) => resolveGeminiEffort(tier, model)?.effort);
  return {
    portable: portableTiers(degradesTo),
    nativeMapping: GEMINI_THINKING_MODELS.has(model) ? 'native' : 'unsupported',
    degradesTo,
  };
}

/** The options of {@link geminiRows}. */
export interface GeminiRowsOptions {
  /** The `freshness` stamped on every row. Defaults to the time of the call. */
  readonly freshness?: string | undefined;
}

/**
 * The catalog rows of the Gemini models, one per model, frozen. The Gemini plugin passes them as
 * its provider's `rows`.
 */
export function geminiRows(options?: GeminiRowsOptions): readonly BackendDescriptor[] {
  const freshness = options?.freshness ?? new Date().toISOString();
  return Object.freeze(
    Object.keys(GEMINI_LIMITS).map((model) => deepFreeze(buildGeminiRow(model, freshness))),
  );
}
