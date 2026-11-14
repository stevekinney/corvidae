import type { Modality, ModalityMatrix } from 'conversationalist';

import type { ModelPricing } from '@lostgradient/operative';
import {
  FULL_PARAMETER_COMPATIBILITY,
  aliasesFor,
  backendPricing,
  deepFreeze,
  degradationOf,
  portableTiers,
  readEnvironmentConfiguration,
  type BackendDescriptor,
  type Effort,
  type EffortSupport,
  type MediaCount,
  type ModelLimitEntry,
} from '@lostgradient/operative/provider-kit';

// The OpenAI catalog: its models' limits, modalities, prices, aliases and effort support, and the
// rows the plugin offers. Repricing a model or adding one is an edit to this file alone.

// ── Modality matrices ───────────────────────────────────────────────────────

const UNSUPPORTED_MODALITY_ENTRY: ModalityMatrix[Modality] = {
  input: false,
  output: false,
  sourceForms: [],
};

// https://developers.openai.com/api/docs/guides/pdf-files and
// https://developers.openai.com/api/docs/guides/images-vision — confirmed
// 2026-09-02: both pages document base64/URL image and file input; neither
// documents a `file_id` (Files-API) input path for `chat.completions`
// specifically — that capability is scoped to the Responses API — so
// `chat.completions` takes a PDF as `inline` bytes, a `data-url`, or a Files API
// `provider-file` id (https://developers.openai.com/api/docs/guides/pdf-files:
// "Chat Completions supports only .pdf (application/pdf) for both file_data and
// file_id"), and a `remote-url` as well for an image.
// `chat.completions` has no audio or video input/output and no image or
// audio generation (that is the Responses/Realtime API's surface).
const OPENAI_MODALITIES: ModalityMatrix = Object.freeze({
  text: { input: true, output: true, sourceForms: ['inline'] },
  image: { input: true, output: false, sourceForms: ['inline', 'data-url', 'remote-url'] },
  document: { input: true, output: false, sourceForms: ['inline', 'data-url', 'provider-file'] },
  audio: UNSUPPORTED_MODALITY_ENTRY,
  video: UNSUPPORTED_MODALITY_ENTRY,
  file: UNSUPPORTED_MODALITY_ENTRY,
});

// ── Limits ──────────────────────────────────────────────────────────────────
export const OPENAI_LIMITS: Readonly<Record<string, ModelLimitEntry>> = Object.freeze({
  // https://developers.openai.com/api/docs/models/gpt-4.1 — confirmed
  // 2026-09-02: context 1,047,576, max output 32,768.
  'gpt-4.1': { contextWindowTokens: 1_047_576, maxOutputTokens: 32_768 },
  // Same family; OpenAI documents gpt-4.1-mini and gpt-4.1-nano sharing the
  // gpt-4.1 page's context/output limits. Not separately confirmed live.
  'gpt-4.1-mini': { contextWindowTokens: 1_047_576, maxOutputTokens: 32_768 },
  'gpt-4.1-nano': { contextWindowTokens: 1_047_576, maxOutputTokens: 32_768 },
  // Long-standing published o-series specification (OpenAI's o3/o3-mini/
  // o4-mini model pages); the OpenAI docs domain redirected mid-fetch on
  // 2026-09-02 and the redirected page did not carry this table, so this is
  // not independently reconfirmed live in this change.
  o3: { contextWindowTokens: 200_000, maxOutputTokens: 100_000 },
  'o3-mini': { contextWindowTokens: 200_000, maxOutputTokens: 100_000 },
  'o4-mini': { contextWindowTokens: 200_000, maxOutputTokens: 100_000 },
  // Long-standing published GPT-4o specification, same live-fetch caveat as
  // the o-series rows above.
  'gpt-4o': { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
  'gpt-4o-mini': { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
});

const OPENAI_MODALITIES_TABLE: Readonly<Record<string, ModalityMatrix>> = Object.freeze({
  // OPENAI_MODALITIES above — https://developers.openai.com/api/docs/guides/pdf-files
  // and https://developers.openai.com/api/docs/guides/images-vision, confirmed 2026-09-02.
  'gpt-4.1': OPENAI_MODALITIES,
  'gpt-4.1-mini': OPENAI_MODALITIES,
  'gpt-4.1-nano': OPENAI_MODALITIES,
  o3: OPENAI_MODALITIES,
  'o3-mini': OPENAI_MODALITIES,
  'o4-mini': OPENAI_MODALITIES,
  'gpt-4o': OPENAI_MODALITIES,
  'gpt-4o-mini': OPENAI_MODALITIES,
});

/** One model's limits; throws for a model with no row, so a model added elsewhere without limits fails loudly. */
function requireLimits(model: string): ModelLimitEntry {
  const entry = Object.hasOwn(OPENAI_LIMITS, model) ? OPENAI_LIMITS[model] : undefined;
  if (!entry) throw new Error(`model-catalog: no limits entry for openai/${model}`);
  return entry;
}

/** One model's modality matrix; throws for a model with no row. */
function requireModalities(model: string): ModalityMatrix {
  const entry = Object.hasOwn(OPENAI_MODALITIES_TABLE, model)
    ? OPENAI_MODALITIES_TABLE[model]
    : undefined;
  if (!entry) throw new Error(`model-catalog: no modalities entry for openai/${model}`);
  return entry;
}

// ── Pricing ─────────────────────────────────────────────────────────────────
const OPENAI_CACHE_READ_MULTIPLIER = 0.5;

function openAICachePricing(promptCostPerMillionTokens: number) {
  return {
    cacheReadCostPerMillionTokens: promptCostPerMillionTokens * OPENAI_CACHE_READ_MULTIPLIER,
  };
}

/** OpenAI list prices by model. */
export const openAIPricingTable: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // OpenAI GPT-4o / 4.1 / o3 / o4-mini
  'gpt-4o': {
    promptCostPerMillionTokens: 2.5,
    completionCostPerMillionTokens: 10,
    ...openAICachePricing(2.5),
  },
  'gpt-4o-mini': {
    promptCostPerMillionTokens: 0.15,
    completionCostPerMillionTokens: 0.6,
    ...openAICachePricing(0.15),
  },
  'gpt-4.1': {
    promptCostPerMillionTokens: 2,
    completionCostPerMillionTokens: 8,
    ...openAICachePricing(2),
  },
  'gpt-4.1-mini': {
    promptCostPerMillionTokens: 0.4,
    completionCostPerMillionTokens: 1.6,
    ...openAICachePricing(0.4),
  },
  'gpt-4.1-nano': {
    promptCostPerMillionTokens: 0.1,
    completionCostPerMillionTokens: 0.4,
    ...openAICachePricing(0.1),
  },
  o3: {
    promptCostPerMillionTokens: 10,
    completionCostPerMillionTokens: 40,
    ...openAICachePricing(10),
  },
  'o3-mini': {
    promptCostPerMillionTokens: 1.1,
    completionCostPerMillionTokens: 4.4,
    ...openAICachePricing(1.1),
  },
  'o4-mini': {
    promptCostPerMillionTokens: 1.1,
    completionCostPerMillionTokens: 4.4,
    ...openAICachePricing(1.1),
  },
});

// ── Aliases ─────────────────────────────────────────────────────────────────
/**
 * OpenAI shorthand aliases. `gpt`/`gpt-mini`/`gpt-nano` map to the GPT-4.1
 * chat-completion family; `o`/`o-mini` map to the o-series reasoning models
 * that accept `reasoning_effort` (see `./effort.ts`). Targets are drawn from
 * the model IDs already pinned in `cost-estimation.ts`.
 */
export const OPENAI_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  gpt: 'gpt-4.1',
  'gpt-mini': 'gpt-4.1-mini',
  'gpt-nano': 'gpt-4.1-nano',
  o: 'o3',
  'o-mini': 'o3-mini',
});

function resolveModelAlias(model: string, aliases: Readonly<Record<string, string>>): string {
  if (model === 'inherit') return model;
  return (Object.hasOwn(aliases, model) ? aliases[model] : undefined) ?? model;
}

/** Resolves an OpenAI shorthand alias (or full model ID) to a concrete model ID. */
export function resolveOpenAIModel(model: string): string {
  return resolveModelAlias(model, OPENAI_MODEL_ALIASES);
}

// ── Effort ──────────────────────────────────────────────────────────────────
/**
 * OpenAI models that accept `reasoning_effort` — the o-series reasoning
 * models. The GPT-4o / GPT-4.1 chat-completion family rejects the
 * parameter, so it is degraded to "omit" for those models.
 */
export const OPENAI_REASONING_MODELS: ReadonlySet<string> = new Set(['o3', 'o3-mini', 'o4-mini']);

/**
 * Resolves the requested effort tier to OpenAI's `reasoning_effort` value.
 * OpenAI's own vocabulary has only three tiers (`low`/`medium`/`high`) —
 * the two provider-neutral tiers above `high` (`xhigh`, `max`) clamp down
 * to `high` rather than erroring. Returns `undefined` for non-reasoning
 * models, where the caller must omit `reasoning_effort` entirely.
 */
export function resolveOpenAIEffort(
  requested: Effort,
  resolvedModel: string,
): 'low' | 'medium' | 'high' | undefined {
  if (!OPENAI_REASONING_MODELS.has(resolvedModel)) return undefined;
  if (requested === 'low' || requested === 'medium') return requested;
  return 'high';
}
// ── Rows ────────────────────────────────────────────────────────────────────
// OpenAI: https://developers.openai.com/api/docs/guides/images-vision: "Up to
// 1,500 images per request" (with up to 512 MB total payload per request).
const OPENAI_MEDIA_COUNTS: readonly MediaCount[] = deepFreeze([
  { modality: 'image', maxPerRequest: 1500 },
]);

function buildOpenAIRow(
  model: string,
  freshness: string,
  endpointAmbiguous: boolean,
): BackendDescriptor {
  const limits = requireLimits(model);
  const pricingRow = backendPricing(
    Object.hasOwn(openAIPricingTable, model) ? openAIPricingTable[model] : undefined,
  );
  return {
    provider: 'openai',
    endpoint: 'chat.completions',
    model,
    aliases: aliasesFor(model, OPENAI_MODEL_ALIASES),
    lifecycle: 'stable',
    modalities: requireModalities(model),
    mimeFamilies: ['text', 'image', 'document'],
    mediaLimits: [],
    mediaCounts: OPENAI_MEDIA_COUNTS,
    providerFetchesRemoteUrls: true,
    contextWindowTokens: limits.contextWindowTokens,
    maxOutputTokens: limits.maxOutputTokens,
    streaming: true,
    tools: true,
    parallelTools: true,
    structuredOutput: true,
    parameterCompatibility: FULL_PARAMETER_COMPATIBILITY,
    // OpenAI's chat.completions endpoint never supports request-controlled
    // caching or server-side token counting, ambiguous or not — only
    // batchInference depends on the effective endpoint. The effective
    // endpoint, not the options object: an ambiguous baseURL means operative
    // cannot tell whether the request reaches api.openai.com, a
    // credential-injecting proxy, or an OpenAI-compatible local server — see
    // capabilities.ts's historical rationale, now sourced from here.
    caching: false,
    batchInference: !endpointAmbiguous,
    explicitThinkingRequest: false,
    serverSideTokenCounting: false,
    effort: openAIEffort(model),
    endpointAmbiguous,
    ...(pricingRow !== undefined ? { pricing: pricingRow } : {}),
    availability: endpointAmbiguous ? 'unknown' : 'available',
    health: 'unknown',
    source: 'static',
    freshness,
  };
}

function openAIEffort(model: string): EffortSupport {
  const degradesTo = degradationOf((tier) => resolveOpenAIEffort(tier, model));
  return {
    portable: portableTiers(degradesTo),
    nativeMapping: OPENAI_REASONING_MODELS.has(model) ? 'native' : 'unsupported',
    degradesTo,
  };
}

/** The options of {@link openAIRows}. */
export interface OpenAIRowsOptions {
  /** The `freshness` stamped on every row. Defaults to the time of the call. */
  readonly freshness?: string | undefined;
  /**
   * The base URL the provider will be configured with. A custom one, or an `OPENAI_BASE_URL` in
   * the environment, makes the endpoint ambiguous: the rows then report no batch inference and an
   * `unknown` availability, because the request may reach a server that is not OpenAI's.
   */
  readonly baseURL?: string | undefined;
}

/**
 * The catalog rows of the OpenAI models, one per model, frozen. The OpenAI plugin passes them as
 * its provider's `rows`.
 */
export function openAIRows(options?: OpenAIRowsOptions): readonly BackendDescriptor[] {
  const freshness = options?.freshness ?? new Date().toISOString();
  const endpointAmbiguous = Boolean(
    options?.baseURL || readEnvironmentConfiguration().openaiBaseUrl,
  );
  return Object.freeze(
    Object.keys(OPENAI_LIMITS).map((model) =>
      deepFreeze(buildOpenAIRow(model, freshness, endpointAmbiguous)),
    ),
  );
}
