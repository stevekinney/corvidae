/**
 * The runtime's public validate / resolve / project interface.
 *
 * Everything here is in memory: the caller hands over a resolver and token
 * documents, and receives either a result for all six contexts or
 * path-addressed diagnostics. Nothing reads a file, fetches a source, or
 * formats output; those stay in `scripts/`.
 *
 * Validation always runs first and always includes the schema stage (the
 * standalone DTCG validators) before the semantic checks, so there is no way to
 * reach projection or provenance with a document the schema rejects. Invalid
 * types, unresolvable references, and reference cycles surface as diagnostics
 * and produce no property map and no provenance. A value the CSS projection
 * cannot express is a diagnostic too, never a fallback.
 */

import { traceProvenance } from './authoring-provenance.ts';
import type { AuthoringContext, AuthoringLayer } from './authoring-types.ts';
import { authoringContexts, authoringLayerStack } from './context-stack.ts';
import { validateCorpus } from './corpus-documents.ts';
import {
  evaluateContextProvenance,
  type EvaluatedProvenance,
  type TokenEvaluation,
} from './evaluated-provenance.ts';
import { contextTokenIndex, projectProperties, type PropertyMap } from './projection.ts';
import { TokenValidationError, type ResolverDocument, type TokenDocument } from './types.ts';
import { assertValidResolverDocument } from './validate.ts';

/** The sources of one theme: a resolver and its token documents, keyed by relative path. */
export type ThemeSources = {
  /** Identifies this input. Results echo it so a stale result can be recognized and dropped. */
  revision: number | string;
  resolver: unknown;
  documents: Readonly<Record<string, unknown>>;
};

export type ThemeDiagnostic = {
  revision: number | string;
  severity: 'error';
  /** Where the problem is: a document path, a token path, or `$` for the whole input. */
  path: string;
  reason: string;
  /** The context the problem appears in, when it is specific to one. */
  context?: string;
};

export type ThemeValidation = {
  revision: number | string;
  diagnostics: ThemeDiagnostic[];
};

/**
 * The outcome of evaluating a theme. A failure carries diagnostics and nothing
 * else; a success carries one property map and one provenance result per
 * context, and no diagnostics.
 */
export type ThemeEvaluation =
  | {
      ok: true;
      revision: number | string;
      contexts: AuthoringContext[];
      /** Per context id, the public custom properties and their CSS values. */
      properties: Record<string, PropertyMap>;
      diagnostics: ThemeDiagnostic[];
      provenance: EvaluatedProvenance;
    }
  | { ok: false; revision: number | string; diagnostics: ThemeDiagnostic[] };

function diagnosticsFor(
  revision: number | string,
  error: unknown,
  context?: string,
): ThemeDiagnostic[] {
  const issues =
    error instanceof TokenValidationError
      ? error.issues
      : [{ path: '$', reason: error instanceof Error ? error.message : String(error) }];
  return issues.map(({ path, reason }) => ({
    revision,
    severity: 'error' as const,
    path,
    reason,
    ...(context === undefined ? {} : { context }),
  }));
}

type ValidatedSources = {
  resolver: ResolverDocument;
  documentsByPath: Map<string, TokenDocument>;
};

function validateSources(sources: ThemeSources): ValidatedSources | ThemeDiagnostic[] {
  try {
    assertValidResolverDocument(sources.resolver);
    const documentsByPath = validateCorpus(
      sources.resolver,
      Object.entries(sources.documents).map(([path, document]) => ({ path, document })),
    );
    return { resolver: sources.resolver, documentsByPath };
  } catch (error) {
    return diagnosticsFor(sources.revision, error);
  }
}

/**
 * Validates a theme's sources: the resolver, every document against the DTCG
 * schemas and then the semantic rules, and the resolved tokens of all six
 * contexts. Returns diagnostics; an empty list means the sources are valid.
 * Does not mutate its input.
 */
export function validateThemeSources(sources: ThemeSources): ThemeValidation {
  const validated = validateSources(sources);
  return {
    revision: sources.revision,
    diagnostics: Array.isArray(validated) ? validated : [],
  };
}

/**
 * Evaluates a theme across `light|dark` by `default|reduced|forced-reduced-motion`:
 * validates it, computes every context from source (the two forced contexts
 * included), projects each to its public CSS property map, and traces the
 * evaluated provenance. Does not mutate its input.
 */
export function evaluateTheme(sources: ThemeSources): ThemeEvaluation {
  const { revision } = sources;
  const validated = validateSources(sources);
  if (Array.isArray(validated)) return { ok: false, revision, diagnostics: validated };

  let contexts: Array<AuthoringContext & Record<string, string>>;
  try {
    contexts = authoringContexts(validated.resolver);
  } catch (error) {
    return { ok: false, revision, diagnostics: diagnosticsFor(revision, error) };
  }

  const diagnostics: ThemeDiagnostic[] = [];
  const properties: Record<string, PropertyMap> = {};
  const layerStacks: Record<string, AuthoringLayer[]> = {};
  const tokens: Record<string, TokenEvaluation[]> = {};
  for (const context of contexts) {
    try {
      const stack = authoringLayerStack(validated.resolver, validated.documentsByPath, context);
      const documents = stack.map((layer) => layer.content);
      const index = contextTokenIndex(documents);
      const projection = projectProperties(documents, index);
      if (projection.failures.length > 0) {
        for (const { path, reason } of projection.failures) {
          diagnostics.push({ revision, severity: 'error', path, reason, context: context.id });
        }
        continue;
      }
      const cssPropertyToPath: Record<string, string> = {};
      for (const entry of index.values()) {
        if (entry.cssProperty !== undefined) cssPropertyToPath[entry.cssProperty] = entry.path;
      }
      layerStacks[context.id] = stack.map(({ document, kind, layer }) => ({
        document,
        kind,
        layer,
      }));
      properties[context.id] = projection.properties;
      tokens[context.id] = evaluateContextProvenance(
        layerStacks[context.id]!,
        traceProvenance(stack, { cssPropertyToPath }),
      );
    } catch (error) {
      diagnostics.push(...diagnosticsFor(revision, error, context.id));
    }
  }
  if (diagnostics.length > 0) return { ok: false, revision, diagnostics };

  const plainContexts = contexts.map(({ id, theme, motion }) => ({ id, theme, motion }));
  return {
    ok: true,
    revision,
    contexts: plainContexts,
    properties,
    diagnostics: [],
    provenance: { revision, contexts: plainContexts, layerStacks, tokens },
  };
}
