/**
 * COR-2104 — a guardrail group's entries, each bare (taking the group's action) or wrapped with an
 * action of its own.
 */
import type { GuardrailEntry, GuardrailWithAction } from './types';

/** Whether `entry` carries an action of its own, rather than being the guardrail itself. */
function isWrapped<T, A extends string>(
  entry: GuardrailEntry<T, A>,
): entry is GuardrailWithAction<T, A> {
  return typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'guardrail');
}

/** The detector or validator an entry holds. */
export function guardrailOf<T, A extends string>(entry: GuardrailEntry<T, A>): T {
  return isWrapped(entry) ? entry.guardrail : entry;
}

/** The action an entry takes: its own, or else `groupAction`. */
export function guardrailActionOf<T, A extends string>(
  entry: GuardrailEntry<T, A>,
  groupAction: A,
): A {
  return (isWrapped(entry) ? entry.action : undefined) ?? groupAction;
}

function guardrailNameOf(guardrail: unknown): string {
  const name = (guardrail as { readonly name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : 'unnamed';
}

/** The guardrails of a group that take one action. */
export interface GuardrailPartition<T, A extends string> {
  readonly action: A;
  readonly members: T[];
  /** Whether this is the group's own action, which also answers for what no guardrail reads. */
  readonly own: boolean;
}

/**
 * `entries` split by the action each takes, in `order`. The group's own action is always present,
 * even with no members, and holds `extra` too (the escalated guardrails a tainted session adds);
 * another action is present only when an entry takes it. Throws `TypeError` for an action `order`
 * does not list, rather than leave its guardrail unrun.
 */
export function guardrailPartitions<T, A extends string>(
  entries: readonly GuardrailEntry<T, A>[],
  groupAction: A,
  order: readonly A[],
  extra: readonly T[] = [],
): GuardrailPartition<T, A>[] {
  const byAction = new Map<A, T[]>([[groupAction, []]]);
  for (const entry of entries) {
    const action = guardrailActionOf(entry, groupAction);
    if (!order.includes(action)) {
      throw new TypeError(
        `The guardrail "${guardrailNameOf(guardrailOf(entry))}" has the action "${action}", which is not one of ${order.join(', ')}.`,
      );
    }
    const members = byAction.get(action) ?? [];
    members.push(guardrailOf(entry));
    byAction.set(action, members);
  }
  byAction.get(groupAction)!.push(...extra);
  return order.flatMap((action) => {
    const members = byAction.get(action);
    return members === undefined ? [] : [{ action, members, own: action === groupAction }];
  });
}
