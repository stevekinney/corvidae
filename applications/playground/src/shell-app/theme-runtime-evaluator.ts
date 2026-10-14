/**
 * The real `ThemeEvaluator` (COR-490): the draft's envelope becomes the token runtime's
 * sources, the runtime validates and projects them, and CSS-only overrides are laid over the
 * projection last. Nothing here reads a file or the network.
 *
 * Resolution order, per the spec: base set sources, shared overrides, the chosen theme base
 * and then its overrides, the chosen motion base and then its overrides, and finally the
 * explicit CSS-only overrides. The override documents are the envelope's DTCG source trees
 * as authored, appended to the resolver's own source lists, so layering is the resolver's
 * and is not reimplemented here.
 */

import {
  applyCssOnlyOverrides,
  evaluateThemeProperties,
} from '@lostgradient/cinder/tokens/runtime';

import type {
  ThemeDiagnostic,
  ThemeEvaluation,
  ThemeEvaluator,
  ThemeProperty,
} from './theme-draft-evaluation.ts';
import { type ThemeContextId, type ThemeEnvelope } from './theme-draft-types.ts';
import { themePreviewValueProblem } from './theme-preview-message.ts';
import { trustedThemeSources } from './theme-recipe-trust.ts';

/**
 * Lay CSS-only overrides over a projected context. They win over everything, and only a value
 * that passes the same check the preview frame applies is used.
 */
export function applyCssOverrides(
  properties: Readonly<Record<string, string>>,
  envelope: ThemeEnvelope,
  context: ThemeContextId,
): Record<string, string> {
  return applyCssOnlyOverrides(
    properties,
    envelope.cssOverrides,
    context,
    (value) => themePreviewValueProblem(value) === null,
  );
}

const toList = (properties: Record<string, string>): ThemeProperty[] =>
  Object.entries(properties).map(([name, value]) => ({ name, value }));

let installed: ThemeEvaluator | null = null;
let shared: ThemeEvaluator | null = null;

/**
 * Make `evaluator` the one every builder surface shares. The builder entry installs the
 * off-thread evaluator before anything mounts; without one (unit tests, server rendering) the
 * in-thread evaluator is used.
 */
export function installThemeEvaluator(evaluator: ThemeEvaluator | null): void {
  installed = evaluator;
}

/** The shared evaluator: the installed one, otherwise a single in-thread evaluator. */
export function defaultThemeEvaluator(): ThemeEvaluator {
  if (installed !== null) return installed;
  shared ??= createRuntimeEvaluator();
  return shared;
}

/**
 * Evaluates an envelope for one context. Results are kept per envelope object (every commit
 * makes a new one), so asking again for the same revision and context costs nothing, and
 * `setContext` re-renders from a map it already holds.
 */
export function createRuntimeEvaluator(): ThemeEvaluator {
  const results = new WeakMap<ThemeEnvelope, Map<string, ThemeEvaluation>>();
  return {
    async evaluate(source, revision, context): Promise<ThemeEvaluation> {
      const key = `${revision}:${context}`;
      const remembered = results.get(source)?.get(key);
      if (remembered !== undefined) return remembered;
      const outcome = evaluateThemeProperties(trustedThemeSources(source, revision), {
        contexts: [context],
      });
      let evaluation: ThemeEvaluation;
      if (outcome.ok) {
        const projected = outcome.properties[context] ?? {};
        evaluation = {
          revision,
          context,
          ok: true,
          properties: toList(applyCssOverrides(projected, source, context)),
        };
      } else {
        const diagnostics: ThemeDiagnostic[] = outcome.diagnostics.map((diagnostic) => ({
          path: diagnostic.path,
          code: 'invalid-theme',
          message:
            diagnostic.context === undefined
              ? diagnostic.reason
              : `${diagnostic.reason} (${diagnostic.context})`,
        }));
        evaluation = { revision, context, ok: false, diagnostics };
      }
      const forEnvelope = results.get(source) ?? new Map<string, ThemeEvaluation>();
      forEnvelope.set(key, evaluation);
      results.set(source, forEnvelope);
      return evaluation;
    },
  };
}
