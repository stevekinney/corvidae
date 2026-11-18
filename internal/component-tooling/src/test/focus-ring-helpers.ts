/**
 * Forced-colors detection for the focus-visible recipe tests: answers whether a PostCSS node
 * sits under an `@media (forced-colors: active)` fallback.
 */

import type { AtRule, Node } from 'postcss';

/**
 * Matches a single CSS media-query branch that contains the
 * `(forced-colors: active)` feature. Used both as a per-branch check (when
 * walking comma-separated query lists) and as a full-params match.
 */
export const FORCED_COLORS_FEATURE = /\(\s*forced-colors\s*:\s*active\s*\)/i;

/**
 * Return every `@media` query string in the ancestor chain of `node`,
 * outermost first. Non-media at-rules (e.g., `@supports`, `@layer`) are
 * ignored — only media queries are relevant to forced-colors detection.
 */
export function ancestorMediaQueries(node: Node): string[] {
  const queries: string[] = [];
  let current = node.parent;
  while (current) {
    if (current.type === 'atrule' && (current as AtRule).name.toLowerCase() === 'media') {
      queries.push((current as AtRule).params);
    }
    current = current.parent;
  }
  return queries;
}

/**
 * Is `node` nested inside an `@media` query that gates only on
 * `(forced-colors: active)`? The check walks every ancestor `@media`; if
 * any one of them has all comma-separated branches matching
 * `(forced-colors: active)`, the rule is treated as a forced-colors
 * fallback even if it also sits inside an unrelated outer query like
 * `@media (hover: hover)`. A comma-separated query that mixes
 * forced-colors with another feature (e.g. `(forced-colors: active),
 * (hover: hover)`) is intentionally NOT treated as a fallback — the
 * non-forced branch would still apply the rule's declarations to ordinary
 * viewports and let a colored outline slip through.
 */
export function isUnderForcedColors(node: Node): boolean {
  const queries = ancestorMediaQueries(node);
  if (queries.length === 0) return false;
  return queries.some((params) => {
    const branches = params.split(',');
    return branches.every((branch) => FORCED_COLORS_FEATURE.test(branch));
  });
}
