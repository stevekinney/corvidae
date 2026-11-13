import type { DecisionModel } from '@lostgradient/operative';
import type {
  BackendDescriptor,
  ProviderConfigurationBase,
  ProviderDefinition,
} from '@lostgradient/operative/provider-kit';

import { typesafeJev } from './decisions/typesafe-jev';

/** The configuration {@link typesafeProvider} accepts: the shared base, whose `apiKey` is required, and a replacement `fetch`. */
export type TypesafeProviderConfiguration = ProviderConfigurationBase & {
  /** Replaces the global `fetch` for every request, which tests use to replay recorded responses. */
  readonly fetch?: typeof fetch;
};

/** The model name of the one catalog row, `typesafe/jev`. */
export const TYPESAFE_JEV_MODEL = 'jev';

/**
 * The TypeSafe provider: decisions only. It has no `generate` or `stream`, so no agent can run on
 * it, and its one `decide` builds Jev from the configuration's `apiKey`, which `boolean`, `choice`
 * and `scale` requests are answered with.
 */
export const typesafeProvider = {
  name: 'typesafe',
  decide: (configuration: TypesafeProviderConfiguration): DecisionModel => {
    const apiKey = configuration.apiKey?.trim();
    if (apiKey === undefined || apiKey === '') {
      throw new TypeError('The typesafe provider needs an apiKey.');
    }
    return typesafeJev({
      apiKey,
      ...(configuration.fetch === undefined ? {} : { fetch: configuration.fetch }),
    });
  },
} as const satisfies ProviderDefinition<'typesafe', TypesafeProviderConfiguration>;

/** What a modality the row does not take holds. */
const NO_MODALITY = { input: false, output: false, sourceForms: [] } as const;

/**
 * The catalog row `typesafe/jev`: it answers `boolean`, `choice` and `scale` decisions natively
 * (`decisions.only`), runs no agent, and has no structured output, so the language-model fallback
 * answers every other kind. It carries no price, which keeps the fallback from choosing it, and
 * its token limits are 0 because Jev has no context window to select against.
 */
export const typesafeRows: readonly BackendDescriptor[] = Object.freeze([
  Object.freeze<BackendDescriptor>({
    descriptorVersion: 2,
    provider: 'typesafe',
    endpoint: 'decide',
    model: TYPESAFE_JEV_MODEL,
    aliases: [],
    lifecycle: 'stable',
    modalities: {
      text: { input: true, output: false, sourceForms: ['inline'] },
      image: NO_MODALITY,
      audio: NO_MODALITY,
      video: NO_MODALITY,
      document: NO_MODALITY,
      file: NO_MODALITY,
    },
    mimeFamilies: ['text'],
    mediaLimits: [],
    mediaCounts: [],
    providerFetchesRemoteUrls: false,
    contextWindowTokens: 0,
    maxOutputTokens: 0,
    streaming: false,
    tools: false,
    parallelTools: false,
    structuredOutput: false,
    decisions: { kinds: ['boolean', 'choice', 'scale'], only: true },
    parameterCompatibility: [],
    caching: false,
    batchInference: false,
    explicitThinkingRequest: false,
    serverSideTokenCounting: false,
    effort: { portable: [], nativeMapping: 'unsupported', degradesTo: {} },
    availability: 'available',
    health: 'unknown',
    source: 'static',
    freshness: '2026-11-12T00:00:00.000Z',
  }),
]);
