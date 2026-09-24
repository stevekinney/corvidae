/**
 * Formats a saved comment's location for display in `DiffReviewComments`,
 * from its `capturedContext` — the same fields the comment retains even
 * after its target/file disappears, so a removed target's comments still
 * render a meaningful location.
 */

import type { DiffReviewComment } from '../../diff-review-state/index.ts';

function pathLabel(comment: DiffReviewComment): string {
  const { newPath, oldPath, targetLabel } = comment.capturedContext;
  return newPath ?? oldPath ?? targetLabel;
}

export function formatDiffReviewCommentLocation(comment: DiffReviewComment): string {
  const path = pathLabel(comment);
  if (comment.anchor.kind === 'file') return path;
  const { side, startLine, endLine } = comment.anchor;
  const lines = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  return `${path} · ${side} ${lines}`;
}
