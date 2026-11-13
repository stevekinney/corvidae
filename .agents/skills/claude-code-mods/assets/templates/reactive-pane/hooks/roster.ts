import type { AgentInfo } from 'claude-code';

import type { AgentRow } from '../types';

/** How many agents stand in each group, for the band's one-line summary. */
export type RosterCounts = {
  readonly active: number;
  readonly idle: number;
  readonly completed: number;
  readonly stopped: number;
};

const ACTIVE_STATUSES = new Set(['pending', 'running', 'waiting']);
const STOPPED_STATUSES = new Set(['failed', 'killed']);

/** Copies the fields the roster draws, so state holds plain data only. */
export function rowsOf(agents: readonly AgentInfo[]): AgentRow[] {
  return agents.map((agent) => ({
    id: agent.id,
    description: agent.description,
    type: agent.type,
    status: agent.status,
    parentId: agent.parentId ?? null,
  }));
}

export function countsOf(rows: readonly AgentRow[]): RosterCounts {
  let active = 0;
  let idle = 0;
  let completed = 0;
  let stopped = 0;
  for (const row of rows) {
    if (ACTIVE_STATUSES.has(row.status)) active += 1;
    else if (row.status === 'idle') idle += 1;
    else if (row.status === 'completed') completed += 1;
    else if (STOPPED_STATUSES.has(row.status)) stopped += 1;
  }
  return { active, idle, completed, stopped };
}

export function summaryOf(counts: RosterCounts): string {
  const parts = [
    counts.active > 0 ? `${counts.active} working` : '',
    counts.idle > 0 ? `${counts.idle} idle` : '',
    counts.completed > 0 ? `${counts.completed} done` : '',
    counts.stopped > 0 ? `${counts.stopped} stopped` : '',
  ].filter((part) => part.length > 0);
  return parts.length === 0 ? 'none yet' : parts.join(', ');
}

/** A single-cell marker for a row's status, readable without color. */
export function markerOf(status: string): string {
  if (ACTIVE_STATUSES.has(status)) return '>';
  if (status === 'idle') return '-';
  if (status === 'completed') return '+';
  return 'x';
}

/** Cuts `text` to `columns` cells, ending with an ellipsis when it was longer. */
export function fitted(text: string, columns: number): string {
  if (columns <= 1) return text.slice(0, Math.max(0, columns));
  return text.length <= columns ? text : `${text.slice(0, columns - 1)}…`;
}
