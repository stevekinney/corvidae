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
  AUTHORING_CATALOGUE,
  evaluateThemeProperties,
  type ThemeSources,
} from '@lostgradient/cinder/tokens/runtime';

import type {
  ThemeDiagnostic,
  ThemeEvaluation,
  ThemeEvaluator,
  ThemeProperty,
} from './theme-draft-evaluation.ts';
import type { ThemeContextId, ThemeEnvelope } from './theme-draft-types.ts';
import { themePreviewValueProblem } from './theme-preview-message.ts';
import { trustedDocuments } from './theme-recipe-trust.ts';

/** Where each override scope's document lives in the resolver, and which source list it joins. */
export const OVERRIDE_DOCUMENTS = {
  shared: 'overrides/shared.tokens.json',
  light: 'overrides/light.tokens.json',
  dark: 'overrides/dark.tokens.json',
  reduced: 'overrides/reduced.tokens.json',
  forcedReduced: 'overrides/forced-reduced-motion.tokens.json',
} as const;

type SourceList = Array<{ $ref: string }>;
type ResolverShape = {
  sets: Record<string, { sources: SourceList }>;
  modifiers: Record<string, { contexts: Record<string, SourceList> }>;
  resolutionOrder: Array<{ $ref: string }>;
};

function append(list: SourceList | undefined, path: string): void {
  list?.push({ $ref: path });
}

/** The first set in resolution order: the base set sources the shared overrides follow. */
function firstSetName(resolver: ResolverShape): string | undefined {
  const entry = resolver.resolutionOrder.find((reference) => reference.$ref.startsWith('#/sets/'));
  return entry?.$ref.slice('#/sets/'.length);
}

/** The envelope as runtime sources: the embedded base with the override documents inserted. */
export function buildThemeSources(envelope: ThemeEnvelope, revision: number): ThemeSources {
  const resolver = structuredClone(envelope.base.resolver) as unknown as ResolverShape;
  append(resolver.sets[firstSetName(resolver) ?? '']?.sources, OVERRIDE_DOCUMENTS.shared);
  const theme = resolver.modifiers['theme']?.contexts;
  append(theme?.['light'], OVERRIDE_DOCUMENTS.light);
  append(theme?.['dark'], OVERRIDE_DOCUMENTS.dark);
  const motion = resolver.modifiers['motion']?.contexts;
  append(motion?.['reduced'], OVERRIDE_DOCUMENTS.reduced);
  append(motion?.['forced-reduced-motion'], OVERRIDE_DOCUMENTS.forcedReduced);
  return {
    revision,
    resolver,
    // Untrusted recipes stay in the envelope but are inert here (see theme-recipe-trust.ts).
    documents: trustedDocuments({
      ...envelope.base.documents,
      [OVERRIDE_DOCUMENTS.shared]: envelope.overrides.shared,
      [OVERRIDE_DOCUMENTS.light]: envelope.overrides.light,
      [OVERRIDE_DOCUMENTS.dark]: envelope.overrides.dark,
      [OVERRIDE_DOCUMENTS.reduced]: envelope.overrides.reduced,
      [OVERRIDE_DOCUMENTS.forcedReduced]: envelope.overrides.forcedReduced,
    }, envelope.base),
  };
}

const cssPropertyByPath = new Map(
  AUTHORING_CATALOGUE.records.map((record) => [record.path, record.cssProperty] as const),
);

/**
 * Lay CSS-only overrides over a projected context. They win over everything, and only a value
 * that passes the same check the preview frame applies is used.
 */
export function applyCssOverrides(
  properties: Readonly<Record<string, string>>,
  envelope: ThemeEnvelope,
  context: ThemeContextId,
): Record<string, string> {
  const merged: Record<string, string> = { ...properties };
  for (const [path, byContext] of Object.entries(envelope.cssOverrides)) {
    const value = byContext[context];
    const property = cssPropertyByPath.get(path);
    if (value === undefined || property === undefined) continue;
    if (themePreviewValueProblem(value) === null) merged[property] = value;
  }
  return merged;
}

const toList = (properties: Record<string, string>): ThemeProperty[] =>
  Object.entries(properties).map(([name, value]) => ({ name, value }));

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
      const outcome = evaluateThemeProperties(buildThemeSources(source, revision), {
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
