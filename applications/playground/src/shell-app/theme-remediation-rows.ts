/**
 * Display rows for a remediation proposal (COR-487): every path whose value changes, with
 * the before and after the author will see. The rows come from the same `computeImpact` the
 * previewed detach uses (COR-488), so a dependent's change is listed, never hidden; only the
 * target's authored value is shown as a color rather than as DTCG JSON.
 */

import { readDtcgColor, authoredText } from './theme-color-model.ts';
import type { JsonValue, ThemeContextId, ThemeDraft } from './theme-draft-types.ts';
import type { Impact } from './theme-impact.ts';
import type { ThemePreviewContext } from './theme-preview-message.ts';
import { envelopeWith } from './theme-remediation-check.ts';
import { authoredValueOf, isAliasValue, valueToText } from './theme-token-edit.ts';

export type ChangeRow = {
  path: string;
  context: ThemeContextId;
  before: string;
  after: string;
  role: 'target' | 'dependent' | 'other';
};

export function previewContextOf(context: ThemeContextId): ThemePreviewContext {
  const [colorMode, motion] = context.split('/') as [
    ThemePreviewContext['colorMode'],
    ThemePreviewContext['motion'],
  ];
  return { colorMode, motion };
}

export const authoredLabel = (value: JsonValue | undefined): string => {
  if (value === undefined) return 'not set';
  if (isAliasValue(value)) return value;
  const color = readDtcgColor(value);
  return color === null ? valueToText(value) : authoredText(color);
};

export function changeRowsFor(impact: Extract<Impact, { ok: true }>, draft: ThemeDraft): ChangeRow[] {
  const after = envelopeWith(draft.envelope, impact.state);
  return impact.changed.map((row): ChangeRow => {
    if (row.role !== 'target') {
      return {
        path: row.path,
        context: row.context,
        before: row.before,
        after: row.after,
        role: row.role,
      };
    }
    const context = previewContextOf(row.context);
    return {
      path: row.path,
      context: row.context,
      role: row.role,
      before: authoredLabel(authoredValueOf(draft.envelope, context, row.path)),
      after: authoredLabel(authoredValueOf(after, context, row.path)),
    };
  });
}
