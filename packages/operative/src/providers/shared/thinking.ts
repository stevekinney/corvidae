import type { Effort } from '../types.ts';

/**
 * Whether Anthropic accepts `thinking: { type: 'disabled' }` by resolved model
 * ID, per the per-model configuration table and the model paragraphs on
 * https://platform.claude.com/docs/en/build-with-claude/thinking and
 * https://platform.claude.com/docs/en/build-with-claude/effort (confirmed
 * 2026-10-14):
 * - `never`: a 400 at every effort level. Opus 5.5, Fable 5.1, Mythos 5.1,
 *   Fable 5 and Mythos 5 ("reject thinking: {type: "disabled"}. Thinking can't
 *   be turned off on these models"), and Sonnet 5.5 ("rejects thinking:
 *   {type: "disabled"} with a 400 error"; its off switch is `between_tools`).
 * - `high-or-below`: accepted at `low`, `medium` and `high` effort and a 400
 *   at `xhigh` or `max`. Opus 5 ("accepts thinking: {type: "disabled"} at
 *   effort high or below ... xhigh or max ... return a 400 error") and Haiku
 *   5.5 (same sentence).
 * - `always`: accepted at every effort. Sonnet 5, Opus 4.8, 4.7, 4.6, 4.5,
 *   Sonnet 4.6 and Haiku 4.5 ("Thinking off" in the table).
 *
 * A model with no entry is unsettled: the guard stays out of the way and a
 * 400 surfaces from the API. Not settled by these pages: the dated Claude 4 and
 * 3.5 snapshots and any ID newer than this table. The table's `enabled` and
 * `between_tools` columns are outside this guard, and `between_tools` is not a
 * member of {@link import('../types.ts').AnthropicThinkingConfig}.
 */
export type DisabledThinkingRule = 'never' | 'high-or-below' | 'always';

export const ANTHROPIC_DISABLED_THINKING: Readonly<Record<string, DisabledThinkingRule>> =
  Object.freeze({
    'claude-opus-5-5': 'never',
    'claude-fable-5-1': 'never',
    'claude-mythos-5-1': 'never',
    'claude-fable-5': 'never',
    'claude-mythos-5': 'never',
    'claude-sonnet-5-5': 'never',
    'claude-opus-5': 'high-or-below',
    'claude-haiku-5-5': 'high-or-below',
    'claude-sonnet-5': 'always',
    'claude-opus-4-8': 'always',
    'claude-opus-4-7': 'always',
    'claude-opus-4-6': 'always',
    'claude-opus-4-5': 'always',
    'claude-sonnet-4-6': 'always',
    'claude-haiku-4-5': 'always',
  });

export function anthropicDisabledThinkingRule(
  resolvedModel: string,
): DisabledThinkingRule | undefined {
  return ANTHROPIC_DISABLED_THINKING[resolvedModel];
}

export const EFFORTS_THAT_FORBID_DISABLED_THINKING: readonly Effort[] = ['xhigh', 'max'];
