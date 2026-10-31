import { definePlugin } from '@lostgradient/interborough-plugin';
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

/**
 * The TypeSafe plugin. It contributes Jev as the decision model `typesafe:jev`, which the
 * `decisions.model` setting can name. It needs `typesafe-api-key`; without it the plugin is
 * `needs-setup` and a decision routed to `typesafe:jev` refuses until the key is saved.
 */
export default definePlugin({
  name: 'typesafe',
  version: '0.1.0',
  description: 'TypeSafe Jev as a decision model for boolean, choice, and scale questions.',
  secrets: [TYPESAFE_API_KEY_SECRET],
  setup: ({ secrets }) => ({
    decisionRouters: [lazyJev(() => secrets.get(TYPESAFE_API_KEY_SECRET))],
  }),
});
