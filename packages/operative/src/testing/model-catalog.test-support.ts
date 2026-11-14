import type { MediaLimits, Modality, ModalityMatrix } from 'conversationalist';

import type { ModelPricing } from '../cost-estimation.ts';
import {
  FULL_PARAMETER_COMPATIBILITY,
  backendPricing,
  deepFreeze,
  degradationOf,
  portableTiers,
} from '../providers/model-catalog-rows.ts';
import {
  createModelCatalog,
  type BackendDescriptor,
  type CreateModelCatalogOptions,
  type EffortSupport,
  type MediaCount,
  type ModelCatalog,
} from '../providers/model-catalog.ts';
import type { Effort } from '../providers/types.ts';

// A small, vendor-neutral catalog for the tests of Operative's own behavior: routing, selection,
// media admission, cost, caching and the rest need some rows with some capability shapes, never a
// vendor's real model or price. The shapes mirror the three kinds of backend the loop meets:
//
//   alpha  messages-style: image and document input, per-part byte cap, tool results carry media,
//          prompt caching, native effort, batches, server-side token counting.
//   beta   completions-style: image and document input, no byte cap, text-only tool results,
//          no caching, effort on one model only, batches.
//   gamma  generate-content-style: image, document, audio and video input, byte cap per modality,
//          caching, one model whose remote URLs the host must fetch.
//
// A test that asserts a vendor's real model id or price belongs in that vendor's package.

/** The provider names of the fixture. */
export const FIXTURE_PROVIDERS = ['alpha', 'beta', 'gamma'] as const;
export type FixtureProvider = (typeof FIXTURE_PROVIDERS)[number];

/** The `freshness` every fixture row carries unless a test passes its own. */
export const FIXTURE_FRESHNESS = '2026-10-17T00:00:00.000Z';

const NO_MODALITY: ModalityMatrix[Modality] = { input: false, output: false, sourceForms: [] };
const ALL_FORMS = ['inline', 'data-url', 'remote-url', 'provider-file'] as const;

const ALPHA_MODALITIES: ModalityMatrix = {
  text: { input: true, output: true, sourceForms: ['inline'] },
  image: { input: true, output: false, sourceForms: [...ALL_FORMS] },
  document: { input: true, output: false, sourceForms: [...ALL_FORMS] },
  audio: NO_MODALITY,
  video: NO_MODALITY,
  file: NO_MODALITY,
};
const BETA_MODALITIES: ModalityMatrix = {
  text: { input: true, output: true, sourceForms: ['inline'] },
  image: { input: true, output: false, sourceForms: ['inline', 'data-url', 'remote-url'] },
  document: { input: true, output: false, sourceForms: ['inline', 'data-url', 'provider-file'] },
  audio: NO_MODALITY,
  video: NO_MODALITY,
  file: NO_MODALITY,
};
const GAMMA_MODALITIES: ModalityMatrix = {
  text: { input: true, output: true, sourceForms: ['inline'] },
  image: { input: true, output: false, sourceForms: [...ALL_FORMS] },
  document: { input: true, output: false, sourceForms: [...ALL_FORMS] },
  audio: { input: true, output: false, sourceForms: [...ALL_FORMS] },
  video: { input: true, output: false, sourceForms: [...ALL_FORMS] },
  file: NO_MODALITY,
};

const TEN_MEBIBYTES = 10 * 1024 * 1024;
const ALPHA_MEDIA_LIMITS: readonly MediaLimits[] = [
  { scope: 'per-part', modality: 'image', maxBytes: TEN_MEBIBYTES },
];
const GAMMA_MEDIA_LIMITS: readonly MediaLimits[] = (
  ['image', 'document', 'audio', 'video'] as const
).map((modality) => ({ scope: 'per-part' as const, modality, maxBytes: 2 * TEN_MEBIBYTES }));

/** The prices the fixture rows carry, by model, for a test's `customPricing`. */
export const fixturePricing: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'alpha-large': {
    promptCostPerMillionTokens: 10,
    completionCostPerMillionTokens: 50,
    cacheWriteCostPerMillionTokens: 12.5,
    cacheReadCostPerMillionTokens: 1,
  },
  'alpha-medium': {
    promptCostPerMillionTokens: 3,
    completionCostPerMillionTokens: 15,
    cacheWriteCostPerMillionTokens: 3.75,
    cacheReadCostPerMillionTokens: 0.3,
  },
  'alpha-small': {
    promptCostPerMillionTokens: 0.1,
    completionCostPerMillionTokens: 0.5,
    cacheWriteCostPerMillionTokens: 0.125,
    cacheReadCostPerMillionTokens: 0.01,
    longContext: {
      inputTokensAbove: 100_000,
      promptCostPerMillionTokens: 0.5,
      completionCostPerMillionTokens: 2.5,
      cacheWriteCostPerMillionTokens: 0.625,
      cacheReadCostPerMillionTokens: 0.05,
    },
  },
  'alpha-restricted': {
    promptCostPerMillionTokens: 10,
    completionCostPerMillionTokens: 50,
  },
  'beta-standard': {
    promptCostPerMillionTokens: 2.5,
    completionCostPerMillionTokens: 10,
    cacheReadCostPerMillionTokens: 1.25,
  },
  'beta-mini': {
    promptCostPerMillionTokens: 0.15,
    completionCostPerMillionTokens: 0.6,
    cacheReadCostPerMillionTokens: 0.075,
  },
  'beta-reasoning': {
    promptCostPerMillionTokens: 10,
    completionCostPerMillionTokens: 40,
    cacheReadCostPerMillionTokens: 5,
  },
  'gamma-pro': { promptCostPerMillionTokens: 1.25, completionCostPerMillionTokens: 10 },
  'gamma-legacy': { promptCostPerMillionTokens: 0.1, completionCostPerMillionTokens: 0.4 },
});

/** The tiers a model takes as they are; the rest degrade to the highest tier it does take. */
function effortOf(supported: readonly Effort[], native: boolean): EffortSupport {
  const order: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  const degradesTo = degradationOf((tier) => {
    if (supported.length === 0) return undefined;
    if (supported.includes(tier)) return tier;
    return order
      .slice(0, order.indexOf(tier))
      .toReversed()
      .find((t) => supported.includes(t));
  });
  return {
    portable: portableTiers(degradesTo),
    nativeMapping: native ? 'native' : 'unsupported',
    degradesTo,
  };
}

interface RowSpec {
  readonly provider: FixtureProvider;
  readonly endpoint: string;
  readonly model: string;
  readonly aliases?: readonly string[];
  readonly modalities: ModalityMatrix;
  readonly mimeFamilies: BackendDescriptor['mimeFamilies'];
  readonly mediaLimits: readonly MediaLimits[];
  readonly mediaCounts: readonly MediaCount[];
  readonly providerFetchesRemoteUrls: boolean;
  readonly toolResultModalities?: readonly Modality[];
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly caching: boolean;
  readonly explicitThinkingRequest: boolean;
  readonly serverSideTokenCounting: boolean;
  readonly effort: EffortSupport;
  readonly availability?: BackendDescriptor['availability'];
}

function row(spec: RowSpec, freshness: string): BackendDescriptor {
  const pricing = backendPricing(fixturePricing[spec.model]);
  return deepFreeze({
    provider: spec.provider,
    endpoint: spec.endpoint,
    model: spec.model,
    aliases: (spec.aliases ?? []).map((alias) => ({ alias, resolvesTo: spec.model })),
    lifecycle: 'stable',
    modalities: spec.modalities,
    mimeFamilies: spec.mimeFamilies,
    mediaLimits: spec.mediaLimits,
    mediaCounts: spec.mediaCounts,
    providerFetchesRemoteUrls: spec.providerFetchesRemoteUrls,
    ...(spec.toolResultModalities === undefined
      ? {}
      : { toolResultModalities: spec.toolResultModalities }),
    contextWindowTokens: spec.contextWindowTokens,
    maxOutputTokens: spec.maxOutputTokens,
    streaming: true,
    tools: true,
    parallelTools: true,
    structuredOutput: true,
    parameterCompatibility: FULL_PARAMETER_COMPATIBILITY,
    caching: spec.caching,
    batchInference: spec.provider !== 'gamma',
    explicitThinkingRequest: spec.explicitThinkingRequest,
    serverSideTokenCounting: spec.serverSideTokenCounting,
    effort: spec.effort,
    ...(pricing === undefined ? {} : { pricing }),
    availability: spec.availability ?? 'available',
    health: 'unknown',
    source: 'static',
    freshness,
  } satisfies BackendDescriptor);
}

const ALPHA = {
  provider: 'alpha',
  endpoint: 'messages',
  modalities: ALPHA_MODALITIES,
  mimeFamilies: ['text', 'image', 'document'],
  mediaLimits: ALPHA_MEDIA_LIMITS,
  providerFetchesRemoteUrls: true,
  toolResultModalities: ['image', 'document'],
  maxOutputTokens: 64_000,
  caching: true,
  explicitThinkingRequest: true,
  serverSideTokenCounting: true,
} as const;
const BETA = {
  provider: 'beta',
  endpoint: 'completions',
  modalities: BETA_MODALITIES,
  mimeFamilies: ['text', 'image', 'document'],
  mediaLimits: [],
  mediaCounts: [{ modality: 'image', maxPerRequest: 1500 }],
  providerFetchesRemoteUrls: true,
  maxOutputTokens: 16_384,
  caching: false,
  explicitThinkingRequest: false,
  serverSideTokenCounting: false,
} as const;
const GAMMA = {
  provider: 'gamma',
  endpoint: 'generate',
  modalities: GAMMA_MODALITIES,
  mimeFamilies: ['text', 'image', 'document', 'audio', 'video'],
  mediaLimits: GAMMA_MEDIA_LIMITS,
  mediaCounts: [{ modality: 'image', maxPerRequest: 3600 }],
  maxOutputTokens: 65_536,
  caching: true,
  explicitThinkingRequest: false,
  serverSideTokenCounting: true,
} as const;

const ALL_TIERS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The fixture rows: three `alpha` models (one with a long-context price, one with a 200K window
 * and so a 100-image cap), three `beta` models (one with native effort), and two `gamma` models
 * (one whose remote URLs the host must fetch). Every row is deeply frozen.
 */
export function fixtureRows(freshness: string = FIXTURE_FRESHNESS): readonly BackendDescriptor[] {
  return Object.freeze([
    row(
      {
        ...ALPHA,
        model: 'alpha-large',
        aliases: ['alpha-best'],
        mediaCounts: [{ modality: 'image', maxPerRequest: 600 }],
        contextWindowTokens: 1_000_000,
        effort: effortOf(ALL_TIERS, true),
      },
      freshness,
    ),
    row(
      {
        ...ALPHA,
        model: 'alpha-medium',
        mediaCounts: [{ modality: 'image', maxPerRequest: 100 }],
        contextWindowTokens: 200_000,
        effort: effortOf(['low', 'medium', 'high'], true),
      },
      freshness,
    ),
    row(
      {
        ...ALPHA,
        model: 'alpha-small',
        mediaCounts: [{ modality: 'image', maxPerRequest: 100 }],
        contextWindowTokens: 200_000,
        effort: effortOf([], false),
      },
      freshness,
    ),
    // Offered only to accounts the catalog cannot see: availability is `unknown`, never `available`.
    row(
      {
        ...ALPHA,
        model: 'alpha-restricted',
        mediaCounts: [{ modality: 'image', maxPerRequest: 600 }],
        contextWindowTokens: 1_000_000,
        effort: effortOf(ALL_TIERS, true),
        availability: 'unknown',
      },
      freshness,
    ),
    row(
      {
        ...BETA,
        model: 'beta-standard',
        contextWindowTokens: 128_000,
        effort: effortOf([], false),
      },
      freshness,
    ),
    row(
      { ...BETA, model: 'beta-mini', contextWindowTokens: 128_000, effort: effortOf([], false) },
      freshness,
    ),
    row(
      {
        ...BETA,
        model: 'beta-reasoning',
        contextWindowTokens: 200_000,
        effort: effortOf(['low', 'medium', 'high'], true),
      },
      freshness,
    ),
    row(
      {
        ...GAMMA,
        model: 'gamma-pro',
        providerFetchesRemoteUrls: true,
        contextWindowTokens: 1_048_576,
        effort: effortOf(ALL_TIERS, true),
      },
      freshness,
    ),
    row(
      {
        ...GAMMA,
        model: 'gamma-legacy',
        providerFetchesRemoteUrls: false,
        contextWindowTokens: 1_048_576,
        effort: effortOf([], false),
      },
      freshness,
    ),
  ]);
}

/** The first fixture row of `provider`. */
export function fixtureRowOf(provider: FixtureProvider, freshness?: string): BackendDescriptor {
  const found = fixtureRows(freshness).find((descriptor) => descriptor.provider === provider);
  if (!found) throw new Error(`the fixture has no ${provider} row`);
  return found;
}

/** The fixture row of `model`. */
export function fixtureRowFor(model: string, freshness?: string): BackendDescriptor {
  const found = fixtureRows(freshness).find((descriptor) => descriptor.model === model);
  if (!found) throw new Error(`the fixture has no ${model} row`);
  return found;
}

/** Options of {@link createFixtureCatalog}: `createModelCatalog`'s, with `descriptors` added to the fixture. */
export type CreateFixtureCatalogOptions = CreateModelCatalogOptions;

/**
 * `createModelCatalog` over the fixture rows. `options.descriptors` is added after them; `now` is
 * the catalog's clock and, when it is given, the rows' `freshness`.
 */
export function createFixtureCatalog(options?: CreateFixtureCatalogOptions): ModelCatalog {
  const now = options?.now;
  return createModelCatalog({
    ...options,
    descriptors: [...fixtureRows(now?.() ?? FIXTURE_FRESHNESS), ...(options?.descriptors ?? [])],
  });
}
