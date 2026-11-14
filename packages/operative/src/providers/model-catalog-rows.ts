import type { ModelPricing } from '../cost-estimation.ts';
import type { BackendDescriptor, EffortSupport, ModelAlias } from './model-catalog.ts';
import type { BaseProviderOptions, Effort } from './types.ts';

// The vendor-neutral parts of building a catalog row. A provider package owns its rows, limits,
// prices and aliases; what is shared between them lives here.

/** One model's context window and output cap. */
export interface ModelLimitEntry {
  /** The tokens of context the model reads. */
  readonly contextWindowTokens: number;
  /** The most tokens the model writes in one response. */
  readonly maxOutputTokens: number;
}

/** The provider-neutral effort tiers, lowest first. */
export const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Where each provider-neutral tier lands for one model, computed by the provider's own resolver, so
 * a row's degradation is never a second table beside it.
 */
export function degradationOf(
  resolve: (tier: Effort) => Effort | undefined,
): EffortSupport['degradesTo'] {
  const degradesTo: Partial<Record<Effort, Effort | undefined>> = {};
  for (const tier of EFFORT_ORDER) degradesTo[tier] = resolve(tier);
  return Object.freeze(degradesTo);
}

/** `portable` is every tier that survives its own provider's degradation unchanged. */
export function portableTiers(degradesTo: EffortSupport['degradesTo']): readonly Effort[] {
  return EFFORT_ORDER.filter((tier) => degradesTo[tier] === tier);
}

/** The aliases of `table` that resolve to `model`. */
export function aliasesFor(
  model: string,
  table: Readonly<Record<string, string>>,
): readonly ModelAlias[] {
  return Object.entries(table)
    .filter(([, resolvesTo]) => resolvesTo === model)
    .map(([alias, resolvesTo]) => ({ alias, resolvesTo }));
}

/** Every field `BaseProviderOptions` declares; a provider that ignores one filters it out. */
export const FULL_PARAMETER_COMPATIBILITY: readonly (keyof BaseProviderOptions)[] = [
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
 * Recursively freezes an object graph. A row's own nested values (`aliases`, `effort.portable`,
 * `pricing`, `mimeFamilies`, `mediaLimits`) are plain arrays and objects that would otherwise stay
 * mutable underneath a frozen top-level object. Always recurses, because freezing a parent does not
 * freeze its children.
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

/** A row's `pricing`, from a model's {@link ModelPricing}; `undefined` for an unpriced model. */
export function backendPricing(pricing: ModelPricing | undefined): BackendDescriptor['pricing'] {
  if (!pricing) return undefined;
  return {
    inputPerMillionTokens: pricing.promptCostPerMillionTokens,
    outputPerMillionTokens: pricing.completionCostPerMillionTokens,
    currency: 'USD',
    ...(pricing.cacheReadCostPerMillionTokens === undefined
      ? {}
      : { cacheReadPerMillionTokens: pricing.cacheReadCostPerMillionTokens }),
    ...(pricing.cacheWriteCostPerMillionTokens === undefined
      ? {}
      : { cacheWritePerMillionTokens: pricing.cacheWriteCostPerMillionTokens }),
    ...(pricing.longContext
      ? {
          longContext: {
            inputTokensAbove: pricing.longContext.inputTokensAbove,
            inputPerMillionTokens: pricing.longContext.promptCostPerMillionTokens,
            outputPerMillionTokens: pricing.longContext.completionCostPerMillionTokens,
            ...(pricing.longContext.cacheReadCostPerMillionTokens === undefined
              ? {}
              : { cacheReadPerMillionTokens: pricing.longContext.cacheReadCostPerMillionTokens }),
            ...(pricing.longContext.cacheWriteCostPerMillionTokens === undefined
              ? {}
              : {
                  cacheWritePerMillionTokens: pricing.longContext.cacheWriteCostPerMillionTokens,
                }),
          },
        }
      : {}),
  };
}
