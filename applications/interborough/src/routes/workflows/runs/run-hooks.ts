/**
 * What the run page's Run hooks section says (COR-2115, the agreed design), with no DOM in it: which
 * rows it lists and in what order, each row's status, hook point in words and line two, and the
 * line under the heading. Plain functions, so the section, its tests and the browser specs read one
 * source.
 *
 * A live run lists every hook of its plan, the hooks that threw first, latest failure first, then the
 * rest in the plan's own order (grouped by hook point, highest priority first, as the Bureau lists
 * them); each hook once. A settled run lists the hooks that threw and nothing else, because the plan
 * is not kept once a run has ended. A hook row has no action and gives no reason for a failure: the
 * record names the registration, the hook point and who registered it, and nothing of the error.
 */
import type { StatusDotWordLabel } from '@lostgradient/cinder';

import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
import type { TaskFailedHook, TaskHook, TaskHooks } from '../../../lib/bureau-tasks.ts';

const copy = RUN_DETAIL_COPY.hooks;

/** Text the page says in words, or an identifier it sets in code. */
export type HookText = { readonly words: string } | { readonly code: string };

/** One row of the section. */
export interface RunHookRow {
  /** The row's key: the registration's identity, which no other row shares. */
  readonly key: string;
  /** The registration's identity, shown as an identifier. */
  readonly id: string;
  /** The hook point as the Bureau names it, which is the row's tooltip. */
  readonly hookPoint: string;
  /** The hook point in words, or its name in code when this page has no words for it. */
  readonly title: HookText;
  /** The raw source, when the registration has one. */
  readonly source: string | null;
  readonly priority: number | undefined;
  readonly replay: TaskHook['replay'] | undefined;
  /** How the hook failed: how often, and when it last did, or `undefined` for a hook that did not. */
  readonly failure: { readonly count: number; readonly lastFailedAt: number } | undefined;
}

/** What the section shows for a run. */
export interface RunHooksView {
  /** `none` draws no section; `rows` draws the heading, the description and the rows. */
  readonly kind: 'none' | 'rows';
  /** The line under the heading. */
  readonly description: string;
  readonly rows: readonly RunHookRow[];
}

/** The hook point in words, or its name in code for one this page has no words for. */
export function hookPointText(hookPoint: string): HookText {
  return Object.hasOwn(copy.points, hookPoint)
    ? { words: copy.points[hookPoint]! }
    : { code: hookPoint };
}

/** The words of a hook point where only text fits, such as a tooltip: its name when it has none. */
export function hookPointString(hookPoint: string): string {
  const text = hookPointText(hookPoint);
  return 'words' in text ? text.words : text.code;
}

/**
 * Who registered a hook, in words: Interborough for the Bureau's own, the run's agent by its name for
 * the agent's, This run for one the caller gave the run, a plugin by its title when the catalog has
 * one, and otherwise the raw source in code. `undefined` for a hook that names no one.
 *
 * @param source - The source the Bureau reports.
 * @param context - The run's agent as a person reads it, and a plugin's title from the catalog.
 */
export function hookSourceText(
  source: string | null,
  context: {
    readonly agentLabel: string | undefined;
    readonly pluginTitle: (plugin: string) => string | undefined;
  },
): HookText | undefined {
  if (source === null) return undefined;
  if (source === 'bureau') return { words: copy.sources.bureau };
  if (source === 'direct') return { words: copy.sources.direct };
  if (source === 'agent') {
    return context.agentLabel === undefined ? { code: source } : { words: context.agentLabel };
  }
  const title = context.pluginTitle(source);
  return title === undefined ? { code: source } : { words: title };
}

/** A part of line two, in order: words, or the identifier in code. */
export type HookLinePart = HookText;

/**
 * Line two of a row, in order: who registered it, the hook id in code, then, when the plan carries
 * them, "priority N" and the replay words. A hook that is only known from its failure has neither.
 */
export function hookLineParts(
  row: Pick<RunHookRow, 'id' | 'source' | 'priority' | 'replay'>,
  context: Parameters<typeof hookSourceText>[1],
): readonly HookLinePart[] {
  const source = hookSourceText(row.source, context);
  return [
    ...(source === undefined ? [] : [source]),
    { code: row.id },
    ...(row.priority === undefined ? [] : [{ words: copy.priority(row.priority) }]),
    ...(row.replay === undefined ? [] : [{ words: copy.replay[row.replay] }]),
  ];
}

/** Line two as one string, for the tooltip and the phone's form. */
export function hookLineString(parts: readonly HookLinePart[]): string {
  return parts.map((part) => ('words' in part ? part.words : part.code)).join(', ');
}

/** The status word of a hook that threw: "Failed", or "Failed, 3 times" when it threw more than once. */
export function hookStatusWord(row: Pick<RunHookRow, 'failure'>): StatusDotWordLabel | undefined {
  return row.failure === undefined ? undefined : copy.failed(row.failure.count);
}

function failedRow(failed: TaskFailedHook, planned: TaskHook | undefined): RunHookRow {
  return {
    key: failed.hookId,
    id: failed.hookId,
    hookPoint: planned?.hookPoint ?? failed.hookPoint,
    title: hookPointText(planned?.hookPoint ?? failed.hookPoint),
    source: planned?.source ?? failed.source,
    priority: planned?.priority,
    replay: planned?.replay,
    failure: { count: failed.count, lastFailedAt: Date.parse(failed.lastFailedAt) },
  };
}

/**
 * The rows of a run's section, and what it says under its heading.
 *
 * @param hooks - What `bureau.tasks.inspect` said of the run's hooks.
 * @param over - Whether the run has ended, which is when its plan is no longer shown.
 */
export function runHooksView(hooks: TaskHooks, over: boolean): RunHooksView {
  const planned = new Map(hooks.plan?.map((entry) => [entry.id, entry]) ?? []);
  const failed = hooks.failed
    .map((entry) => failedRow(entry, planned.get(entry.hookId)))
    .toSorted(
      (first, second) => (second.failure?.lastFailedAt ?? 0) - (first.failure?.lastFailedAt ?? 0),
    );
  if (over) {
    return {
      kind: failed.length === 0 ? 'none' : 'rows',
      description: copy.descriptionSettled,
      rows: failed,
    };
  }
  if (hooks.plan === null) {
    // A live run whose plan cannot be read lists its failed hooks and nothing else, however many.
    return { kind: 'rows', description: copy.descriptionUnreadable, rows: failed };
  }
  const failedIds = new Set(failed.map((row) => row.id));
  const rest: RunHookRow[] = [];
  for (const entry of hooks.plan) {
    if (failedIds.has(entry.id)) continue;
    // Each hook appears once, whichever way the plan lists it.
    failedIds.add(entry.id);
    rest.push({
      key: entry.id,
      id: entry.id,
      hookPoint: entry.hookPoint,
      title: hookPointText(entry.hookPoint),
      source: entry.source,
      priority: entry.priority,
      replay: entry.replay,
      failure: undefined,
    });
  }
  const rows = [...failed, ...rest];
  return {
    // A live run whose plan holds no hook and none threw has nothing to say.
    kind: rows.length === 0 ? 'none' : 'rows',
    description: copy.descriptionLive,
    rows,
  };
}
