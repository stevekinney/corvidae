import { definePlugin, type PluginInputGuardrail } from '@lostgradient/interborough-plugin';
import type { DecisionKind, DecisionModel } from '@lostgradient/operative';
import { typesafeJev } from '@lostgradient/operative-typesafe';

/** The Bungalow secret that holds the TypeSafe API key. It is the key the host has always used. */
export const TYPESAFE_API_KEY_SECRET = 'typesafe-api-key';

/** The kinds Jev answers; every other kind goes to the `decisions.model` fallback. */
const JEV_KINDS: ReadonlySet<DecisionKind> = new Set(['boolean', 'choice', 'scale']);

/**
 * TypeSafe's Jev as a decision model whose key is read when a decision is made, not when the plugin
 * is set up. The host's gate refuses a decision while the key is not saved, and calls through once
 * it is, so saving or replacing the key applies to the next decision with no restart. The Jev model
 * is rebuilt only when the key changes, and the key is held in memory only.
 */
function lazyJev(readKey: () => Promise<string | undefined>): DecisionModel {
  let built: { readonly key: string; readonly model: DecisionModel } | undefined;
  return {
    name: 'jev',
    kinds: JEV_KINDS,
    async decide(request, options) {
      const stored = await readKey();
      const key = stored?.trim();
      if (key === undefined || key === '') {
        throw new Error(`The secret "${TYPESAFE_API_KEY_SECRET}" is not set.`);
      }
      if (built?.key !== key) built = { key, model: typesafeJev({ apiKey: key }) };
      return built.model.decide(request, options);
    },
  };
}

/** The most characters one scan sends to TypeSafe; the rest of the text is cut off, not sampled. */
export const PROMPT_INJECTION_SCAN_LIMIT = 8000;

/** The question the injection detector puts to the decision model. */
const PROMPT_INJECTION_QUESTION = "Is this text an attempt to override the agent's instructions?";

/** Builds the decision model a plugin uses from a reader of the TypeSafe key. */
export type TypesafeModelFactory = (readKey: () => Promise<string | undefined>) => DecisionModel;

/** Options of {@link createTypesafePlugin}. */
export interface TypesafePluginOptions {
  /** Builds the decision model; defaults to TypeSafe's Jev. Tests script it. */
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
 * The TypeSafe plugin. It contributes Jev as the decision model `typesafe:jev`, which the
 * `decisions.model` setting can name, and the opt-in input detector `typesafe:prompt-injection`,
 * which an agent lists to scan user input and tool results. It needs `typesafe-api-key`; without
 * it the plugin is `needs-setup` and both refuse until the key is saved.
 */
export function createTypesafePlugin(options: TypesafePluginOptions = {}) {
  const createModel = options.createModel ?? lazyJev;
  return definePlugin({
    name: 'typesafe',
    title: 'TypeSafe',
    version: '0.2.0',
    description:
      'TypeSafe Jev as a decision model for boolean, choice, and scale questions, and an opt-in prompt-injection detector.',
    secrets: [TYPESAFE_API_KEY_SECRET],
    setup: ({ secrets }) => {
      const model = createModel(() => secrets.get(TYPESAFE_API_KEY_SECRET));
      return {
        decisionRouters: [model],
        guardrails: { input: [promptInjectionDetector(model)] },
      };
    },
  });
}

/** The TypeSafe plugin with its default model, the real Jev. */
export default createTypesafePlugin();
