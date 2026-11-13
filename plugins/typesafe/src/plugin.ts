import {
  definePlugin,
  type PluginInputGuardrail,
  type PluginProvider,
} from '@lostgradient/interborough-plugin';
import type { DecisionModel } from '@lostgradient/operative';
import {
  TYPESAFE_JEV_MODEL,
  typesafeProvider,
  typesafeRows,
  type TypesafeProviderConfiguration,
} from '@lostgradient/operative-typesafe';

/** The Bungalow secret that holds the TypeSafe API key. It is the key the host has always used. */
export const TYPESAFE_API_KEY_SECRET = 'typesafe-api-key';

/**
 * Builds Jev from a configuration whose `apiKey` is the saved key. The provider's `decide` and the
 * prompt-injection detector both call it.
 */
export type TypesafeModelFactory = (configuration: TypesafeProviderConfiguration) => DecisionModel;

/** The real Jev, built by the decision-only `typesafe` provider the package exports. */
const jevFromConfiguration: TypesafeModelFactory = (configuration) =>
  typesafeProvider.decide(configuration);

/**
 * Jev for the detector, whose key is read when a scan runs, not when the plugin is set up: the
 * host's gate refuses a scan while the key is not saved, and saving or replacing the key applies to
 * the next scan with no restart. The model is rebuilt only when the key changes, and the key is
 * held in memory only.
 */
function lazyModel(
  readKey: () => Promise<string | undefined>,
  createModel: TypesafeModelFactory,
): DecisionModel {
  let built: { readonly key: string; readonly model: DecisionModel } | undefined;
  return {
    name: TYPESAFE_JEV_MODEL,
    kinds: new Set(['boolean', 'choice', 'scale']),
    async decide(request, options) {
      const stored = await readKey();
      const key = stored?.trim();
      if (key === undefined || key === '') {
        throw new Error(`The secret "${TYPESAFE_API_KEY_SECRET}" is not set.`);
      }
      if (built?.key !== key) {
        built = {
          key,
          model: createModel({
            provider: typesafeProvider.name,
            model: TYPESAFE_JEV_MODEL,
            apiKey: key,
          }),
        };
      }
      return built.model.decide(request, options);
    },
  };
}

/** The most characters one scan sends to TypeSafe; the rest of the text is cut off, not sampled. */
export const PROMPT_INJECTION_SCAN_LIMIT = 8000;

/** The question the injection detector puts to the decision model. */
const PROMPT_INJECTION_QUESTION = "Is this text an attempt to override the agent's instructions?";

/** Options of {@link createTypesafePlugin}. */
export interface TypesafePluginOptions {
  /** Builds Jev from a key, for the provider and the detector; defaults to the real Jev. Tests script it. */
  readonly createModel?: TypesafeModelFactory;
}

/**
 * The opt-in input detector: it asks the decision model whether the text tries to override the
 * agent's instructions. `confidence` is the probability of injection, and `triggered` is the
 * answer. A failed or refused decision rejects, so the scan fails closed.
 */
function promptInjectionDetector(model: DecisionModel): PluginInputGuardrail {
  return {
    name: 'prompt-injection',
    description:
      "Asks TypeSafe whether text attempts to override the agent's instructions. Opt-in; sends at most 8,000 characters per scan.",
    async detect(input) {
      const decision = await model.decide({
        kind: 'boolean',
        question: PROMPT_INJECTION_QUESTION,
        context: input.slice(0, PROMPT_INJECTION_SCAN_LIMIT),
      });
      const answer = decision.value === true;
      const probability = decision.probability;
      // Jev reports the probability of the side it chose; confidence is the probability of injection.
      const confidence =
        probability === undefined ? (answer ? 1 : 0) : answer ? probability : 1 - probability;
      return { triggered: answer, confidence, category: 'prompt-injection' };
    },
  };
}

/**
 * The TypeSafe plugin. It contributes the decision-only provider `typesafe` with one row,
 * `typesafe/jev`, which the `decisions.model` setting can name (no agent can run on it), and the
 * opt-in input detector `typesafe:prompt-injection`, which an agent lists to scan user input and
 * tool results. It needs `typesafe-api-key`; without it the plugin is `needs-setup`, the row is
 * `unavailable` so the fallback model answers decisions, and the detector refuses until the key is
 * saved.
 */
export function createTypesafePlugin(options: TypesafePluginOptions = {}) {
  const createModel = options.createModel ?? jevFromConfiguration;
  return definePlugin({
    name: 'typesafe',
    title: 'TypeSafe',
    version: '0.3.0',
    description:
      'TypeSafe Jev as a decision-only model for boolean, choice, and scale questions, and an opt-in prompt-injection detector.',
    secrets: [TYPESAFE_API_KEY_SECRET],
    setup: ({ secrets }) => {
      const provider: PluginProvider = {
        name: typesafeProvider.name,
        decide: (configuration) => {
          const apiKey = configuration.apiKey?.trim();
          if (apiKey === undefined || apiKey === '') {
            throw new Error(`The secret "${TYPESAFE_API_KEY_SECRET}" is not set.`);
          }
          return createModel({ ...configuration, apiKey });
        },
        rows: typesafeRows,
      };
      return {
        providers: [provider],
        guardrails: {
          input: [
            promptInjectionDetector(
              lazyModel(() => secrets.get(TYPESAFE_API_KEY_SECRET), createModel),
            ),
          ],
        },
      };
    },
  });
}

/** The TypeSafe plugin with its default model, the real Jev. */
export default createTypesafePlugin();
