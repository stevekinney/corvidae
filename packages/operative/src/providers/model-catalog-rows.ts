import type { MediaLimits } from 'conversationalist';

import { getModelPricing } from '../cost-estimation.ts';
import { requireLimits, requireModalities } from './model-catalog-data.ts';
import type { BackendDescriptor, EffortSupport, MediaCount, ModelAlias } from './model-catalog.ts';
import {
  GEMINI_THINKING_MODELS,
  OPENAI_REASONING_MODELS,
  resolveAnthropicEffort,
  resolveGeminiEffort,
  resolveOpenAIEffort,
} from './shared/effort.ts';
import {
  ANTHROPIC_MODEL_ALIASES,
  GEMINI_MODEL_ALIASES,
  OPENAI_MODEL_ALIASES,
} from './shared/model-registry.ts';
import { anthropicSamplingSupport } from './shared/sampling.ts';
import type { BaseProviderOptions, Effort } from './types.ts';

// ── Effort degradation, derived from effort.ts — never a second table ──────

const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function anthropicDegradesTo(model: string): EffortSupport['degradesTo'] {
  const degradesTo: Partial<Record<Effort, Effort | undefined>> = {};
  for (const tier of EFFORT_ORDER) degradesTo[tier] = resolveAnthropicEffort(tier, model);
  return Object.freeze(degradesTo);
}

function openAIDegradesTo(model: string): EffortSupport['degradesTo'] {
  const degradesTo: Partial<Record<Effort, Effort | undefined>> = {};
  for (const tier of EFFORT_ORDER) degradesTo[tier] = resolveOpenAIEffort(tier, model);
  return Object.freeze(degradesTo);
}

function geminiDegradesTo(model: string): EffortSupport['degradesTo'] {
  const degradesTo: Partial<Record<Effort, Effort | undefined>> = {};
  for (const tier of EFFORT_ORDER) degradesTo[tier] = resolveGeminiEffort(tier, model)?.effort;
  return Object.freeze(degradesTo);
}

/** `portable` is every tier that survives its own provider's degradation unchanged. */
function portableTiers(degradesTo: EffortSupport['degradesTo']): readonly Effort[] {
  return EFFORT_ORDER.filter((tier) => degradesTo[tier] === tier);
}

function anthropicEffort(model: string): EffortSupport {
  const degradesTo = anthropicDegradesTo(model);
  return {
    portable: portableTiers(degradesTo),
    nativeMapping: 'output_config.effort',
    degradesTo,
  };
}

function openAIEffort(model: string): EffortSupport {
  const degradesTo = openAIDegradesTo(model);
  return {
    portable: portableTiers(degradesTo),
    nativeMapping: OPENAI_REASONING_MODELS.has(model) ? 'reasoning_effort' : 'unsupported',
    degradesTo,
  };
}

function geminiEffort(model: string): EffortSupport {
  const degradesTo = geminiDegradesTo(model);
  return {
    portable: portableTiers(degradesTo),
    nativeMapping: GEMINI_THINKING_MODELS.has(model)
      ? 'thinkingConfig.thinkingBudget'
      : 'unsupported',
    degradesTo,
  };
}

// ── Aliases, derived from model-registry.ts — never a second table ─────────

function aliasesFor(model: string, table: Readonly<Record<string, string>>): readonly ModelAlias[] {
  return Object.entries(table)
    .filter(([, resolvesTo]) => resolvesTo === model)
    .map(([alias, resolvesTo]) => ({ alias, resolvesTo }));
}

// ── Parameter compatibility ─────────────────────────────────────────────────
//
// Every field `BaseProviderOptions` declares. Gemini's adapter has no
// request-level metadata field (`providers/types.ts:56-72` documents
// `requestMetadata` as an explicit no-op for `createGeminiProvider`), so its
// rows omit that one entry; Anthropic and OpenAI honor it.

const FULL_PARAMETER_COMPATIBILITY: readonly (keyof BaseProviderOptions)[] = [
  'model',
  'effort',
  'maximumTokens',
  'temperature',
  'topP',
  'stopSequences',
  'toolChoice',
  'responseFormat',
  'requestMetadata',
];

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

const GEMINI_PARAMETER_COMPATIBILITY: readonly (keyof BaseProviderOptions)[] =
  FULL_PARAMETER_COMPATIBILITY.filter((field) => field !== 'requestMetadata');

// ── Row construction ────────────────────────────────────────────────────────

/**
 * Recursively freezes an object graph. The catalog and its top-level
 * `descriptors` array are frozen where they are constructed, but a
 * descriptor row's own nested values — `aliases`, `effort.portable`,
 * `pricing`, `mimeFamilies`, `mediaLimits` — are plain arrays/objects built
 * fresh per row and would otherwise stay mutable underneath a frozen
 * top-level object. Always recurses (never short-circuits on an
 * already-frozen parent), because freezing a parent does not freeze its
 * children — `ANTHROPIC_MODALITIES` is `Object.freeze`d but its per-modality
 * entry objects are not, until this runs.
 */
export function deepFreeze<T>(value: T): T {
  if (!isFreezableObject(value)) return value;
  for (const key of Object.keys(value)) {
    deepFreeze(Reflect.get(value, key));
  }
  return Object.freeze(value);
}

function isFreezableObject(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false;
  return Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype;
}

/** Exported only for `model-catalog.test.ts`; not part of the public `./providers` barrel. */
export function pricingFor(model: string): BackendDescriptor['pricing'] {
  const pricing = getModelPricing(model);
  if (!pricing) return undefined;
  return {
    inputPerMillionTokens: pricing.promptCostPerMillionTokens,
    outputPerMillionTokens: pricing.completionCostPerMillionTokens,
    currency: 'USD',
    ...(pricing.longContext
      ? {
          longContext: {
            inputTokensAbove: pricing.longContext.inputTokensAbove,
            inputPerMillionTokens: pricing.longContext.promptCostPerMillionTokens,
            outputPerMillionTokens: pricing.longContext.completionCostPerMillionTokens,
          },
        }
      : {}),
  };
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
// OpenAI: https://developers.openai.com/api/docs/guides/images-vision: "Up to
// 1,500 images per request" (with up to 512 MB total payload per request).
const OPENAI_MEDIA_COUNTS: readonly MediaCount[] = deepFreeze([
  { modality: 'image', maxPerRequest: 1500 },
]);
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

export function buildAnthropicRow(model: string, freshness: string): BackendDescriptor {
  const limits = requireLimits('anthropic', model);
  const pricingRow = pricingFor(model);
  return {
    descriptorVersion: 2,
    provider: 'anthropic',
    endpoint: 'messages',
    model,
    aliases: aliasesFor(model, ANTHROPIC_MODEL_ALIASES),
    lifecycle: 'stable',
    modalities: requireModalities('anthropic', model),
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

export function buildOpenAIRow(
  model: string,
  freshness: string,
  endpointAmbiguous: boolean,
): BackendDescriptor {
  const limits = requireLimits('openai', model);
  const pricingRow = pricingFor(model);
  return {
    descriptorVersion: 2,
    provider: 'openai',
    endpoint: 'chat.completions',
    model,
    aliases: aliasesFor(model, OPENAI_MODEL_ALIASES),
    lifecycle: 'stable',
    modalities: requireModalities('openai', model),
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

export function buildGeminiRow(model: string, freshness: string): BackendDescriptor {
  const limits = requireLimits('gemini', model);
  const pricingRow = pricingFor(model);
  return {
    descriptorVersion: 2,
    provider: 'gemini',
    endpoint: 'generateContent',
    model,
    aliases: aliasesFor(model, GEMINI_MODEL_ALIASES),
    lifecycle: 'stable',
    modalities: requireModalities('gemini', model),
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
