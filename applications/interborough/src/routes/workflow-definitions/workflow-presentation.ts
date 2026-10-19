/**
 * What the Workflows area says of a catalog row, a file's steps, and its trigger, in the words
 * `copy.ts` holds. Plain functions over data, so the badges and the labels are tested without a
 * page.
 */
import type { BadgeVariant } from '@lostgradient/cinder';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import type { CatalogRow } from '../../lib/workflow-catalog.ts';
import { describeCadence } from '../schedules/cadence.ts';

/** One badge on a row: its words, its tone, and the test id of the element that carries it. */
export type RowBadge = {
  readonly label: string;
  readonly variant: BadgeVariant;
  readonly testId?: string;
};

/**
 * The badges of a row. A code-defined type has none. Every Bureau file is agent-authored, and
 * names its agent when it has one; an invalid or paused file, and a source that failed to load,
 * say so.
 */
export function rowBadges(row: CatalogRow): RowBadge[] {
  if (row.kind === 'code') return [];
  const badges: RowBadge[] = [{ label: WORKFLOW_COPY.agentAuthoredBadge, variant: 'accent' }];
  if (row.agent !== null) {
    badges.push({
      label: WORKFLOW_COPY.owner(row.agent),
      variant: 'neutral',
      testId: 'workflow-agent',
    });
  }
  if (row.file?.state === 'invalid') {
    badges.push({ label: WORKFLOW_COPY.invalidBadge, variant: 'danger' });
  }
  if (row.file?.paused === true) {
    badges.push({ label: WORKFLOW_COPY.pausedBadge, variant: 'neutral' });
  }
  if (row.failure !== null) {
    badges.push({
      label: WORKFLOW_COPY.sourceFailed(row.failure),
      variant: 'danger',
      testId: 'workflow-failure',
    });
  }
  return badges;
}

/** Which of its three states a row is in: its file cannot be used, its source failed, or neither. */
export function rowState(row: CatalogRow): 'invalid' | 'failed' | 'ready' {
  if (row.file?.state === 'invalid') return 'invalid';
  return row.failure === null ? 'ready' : 'failed';
}

type Described = { readonly kind: string; readonly [key: string]: unknown };

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One step in words. */
export function stepLabel(step: Described): string {
  switch (step.kind) {
    case 'activity': {
      const handler = text(step['handler']) ?? 'activity';
      const input = step['input'];
      if (handler === 'agent' && isRecord(input)) {
        const agent = text(input['agent']);
        const message = text(input['message']);
        if (agent !== undefined && message !== undefined) {
          return WORKFLOW_COPY.steps.agent(agent, message);
        }
      }
      return WORKFLOW_COPY.steps.activity(handler);
    }
    case 'sleep':
      return WORKFLOW_COPY.steps.sleep(text(step['duration']) ?? '');
    case 'await-signal':
      return WORKFLOW_COPY.steps.awaitSignal(text(step['signal']) ?? '');
    default:
      return WORKFLOW_COPY.steps.unknown(step.kind);
  }
}

/** A trigger in words. */
export function triggerLabel(trigger: Described): string {
  switch (trigger.kind) {
    case 'schedule':
      return WORKFLOW_COPY.triggers.schedule(
        text(trigger['spec']) ?? '',
        text(trigger['overlap']) ?? null,
      );
    case 'signal':
      return WORKFLOW_COPY.triggers.signal(text(trigger['name']) ?? '');
    default:
      return WORKFLOW_COPY.triggers.unknown(trigger.kind);
  }
}

/** A schedule's cadence in words. */
export function scheduleLabel(cadence: {
  readonly cronExpression?: string;
  readonly intervalMs?: number;
}): string {
  return describeCadence(cadence);
}
