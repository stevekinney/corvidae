/**
 * The one seam between the draft and the shared token runtime (COR-491). The draft never
 * imports the runtime: a single adapter implements `ThemeEvaluator` over it. Responses
 * carry the revision and context they were computed for, and the gate drops any that a
 * newer edit, context change or theme switch has overtaken.
 */

import type { ThemeContextId, ThemeEnvelope } from './theme-draft-types.ts';

export type ThemeDiagnostic = { path: string; code: string; message: string };
export type ThemeProperty = { name: string; value: string };

export type ThemeEvaluation =
  | { revision: number; context: ThemeContextId; ok: true; properties: readonly ThemeProperty[] }
  | {
      revision: number;
      context: ThemeContextId;
      ok: false;
      diagnostics: readonly ThemeDiagnostic[];
    };

export type ThemeEvaluator = {
  evaluate(
    source: ThemeEnvelope,
    revision: number,
    context: ThemeContextId,
  ): Promise<ThemeEvaluation>;
};

/** Accepts only the response for the newest request of the theme that is still open. */
export class EvaluationGate {
  #latest: { themeId: string; revision: number; context: ThemeContextId } | null = null;

  /** Request an evaluation; resolves `null` when a newer request or a switch superseded it. */
  async request(
    evaluator: ThemeEvaluator,
    themeId: string,
    source: ThemeEnvelope,
    revision: number,
    context: ThemeContextId,
  ): Promise<ThemeEvaluation | null> {
    const ticket = { themeId, revision, context };
    this.#latest = ticket;
    const response = await evaluator.evaluate(source, revision, context);
    if (this.#latest !== ticket) return null;
    if (response.revision !== revision || response.context !== context) return null;
    return response;
  }

  /** A theme switch invalidates everything in flight. */
  invalidate(): void {
    this.#latest = null;
  }
}
