/**
 * COR-2532 — the guardrails that fired in a run, read from the audit trail field by field: the
 * run's own records oldest first, then a workflow instance's steps; a record that is not well formed
 * is skipped, the trail is read to its end, and nothing a guardrail flagged is read.
 */
import { describe, expect, it } from 'bun:test';

import type { AuditQueryOptions, AuditRecord } from './audit-trail.ts';
import { readRunVerdicts } from './run-failure-verdicts.ts';

let counter = 0;

function record(runId: string, type: string, detail: unknown): AuditRecord {
  counter += 1;
  return {
    timestamp: new Date(counter).toISOString(),
    timestampMs: counter,
    sequence: counter,
    runId,
    type,
    detail,
  };
}

/** A trail that answers `query` as the real one does: filtered, oldest first, `after` and `limit`. */
function trailOf(records: readonly AuditRecord[]) {
  const queries: AuditQueryOptions[] = [];
  return {
    queries,
    trail: {
      async query(options: AuditQueryOptions = {}): Promise<AuditRecord[]> {
        queries.push(options);
        const after = options.after;
        return records
          .filter((candidate) => options.runId === undefined || candidate.runId === options.runId)
          .filter((candidate) => options.filter?.(candidate) ?? true)
          .filter(
            (candidate) =>
              after === undefined ||
              candidate.timestampMs > after.timestampMs ||
              (candidate.timestampMs === after.timestampMs &&
                (candidate.sequence ?? -1) > after.sequence),
          )
          .slice(0, options.limit);
      },
    },
  };
}

function tasksOf(childrenByParent: Record<string, readonly string[]>) {
  return {
    async enumerate(query: { parentRunId?: string | undefined; offset: number; limit: number }) {
      const ids = childrenByParent[query.parentRunId ?? ''] ?? [];
      const page = ids.slice(query.offset, query.offset + query.limit);
      const next = query.offset + query.limit;
      return {
        tasks: page.map((id) => ({ id })) as never,
        nextOffset: next < ids.length ? next : null,
      };
    },
  };
}

const tripwire = (runId: string, name: string, step = 0) =>
  record(runId, 'run.tripwire', { guardrailName: name, step, text: 'FLAGGED-TEXT-6a1f' });
const guardrail = (runId: string, name: string, action: string) =>
  record(runId, 'run.guardrail', { guardrailName: name, action, step: 1, detail: 'FLAGGED-TEXT' });

describe('readRunVerdicts', () => {
  it('reads each guardrail’s name, kind, outcome and step, and never what it flagged', async () => {
    const { trail } = trailOf([
      guardrail('run-1', 'tone', 'warn'),
      tripwire('run-1', 'pii', 2),
      record('run-1', 'run.completed', { guardrailName: 'not-a-verdict' }),
    ]);

    const verdicts = await readRunVerdicts({ trail, tasks: tasksOf({}) }, 'run-1', 'agent');

    expect(verdicts).toEqual([
      { name: 'tone', kind: 'guardrail', outcome: 'warn', step: 1 },
      { name: 'pii', kind: 'tripwire', outcome: 'tripwire', step: 2 },
    ]);
    expect(JSON.stringify(verdicts)).not.toContain('FLAGGED-TEXT');
  });

  it('skips a record that names no guardrail, or a guardrail action it does not know', async () => {
    const { trail } = trailOf([
      record('run-1', 'run.tripwire', { step: 0 }),
      record('run-1', 'run.tripwire', { guardrailName: '' }),
      guardrail('run-1', 'tone', 'tripwire'),
      guardrail('run-1', 'tone', 'explode'),
      record('run-1', 'run.guardrail', 'not an object'),
      record('run-1', 'run.guardrail', { guardrailName: 'kept', action: 'redact', step: -1 }),
    ]);

    expect(await readRunVerdicts({ trail, tasks: tasksOf({}) }, 'run-1', 'agent')).toEqual([
      { name: 'kept', kind: 'guardrail', outcome: 'redact', step: null },
    ]);
  });

  it('reads a workflow instance’s own records, then its steps’ in id order, and no other run’s', async () => {
    const { trail } = trailOf([
      tripwire('step-b', 'second'),
      tripwire('instance', 'own'),
      tripwire('step-a', 'first'),
      tripwire('unrelated', 'elsewhere'),
    ]);
    const tasks = tasksOf({ instance: ['step-b', 'step-a'] });

    const workflow = await readRunVerdicts({ trail, tasks }, 'instance', 'workflow');
    expect(workflow.map((verdict) => verdict.name)).toEqual(['own', 'first', 'second']);
    // An agent run is read by its own id alone.
    const agent = await readRunVerdicts({ trail, tasks }, 'instance', 'agent');
    expect(agent.map((verdict) => verdict.name)).toEqual(['own']);
  });

  it('reads the trail to its end, a page at a time', async () => {
    const records = Array.from({ length: 1_203 }, (_, index) => tripwire('run-1', `g-${index}`));
    const { trail, queries } = trailOf(records);

    const verdicts = await readRunVerdicts({ trail, tasks: tasksOf({}) }, 'run-1', 'agent');

    expect(verdicts.map((verdict) => verdict.name)).toEqual(
      records.map((_, index) => `g-${index}`),
    );
    expect(queries).toHaveLength(3);
  });

  it('pages the steps of an instance past one page of the registry', async () => {
    const ids = Array.from({ length: 230 }, (_, index) => `step-${String(index).padStart(3, '0')}`);
    const { trail } = trailOf([tripwire('step-229', 'last'), tripwire('step-000', 'first')]);

    const verdicts = await readRunVerdicts(
      { trail, tasks: tasksOf({ instance: ids }) },
      'instance',
      'workflow',
    );

    expect(verdicts.map((verdict) => verdict.name)).toEqual(['first', 'last']);
  });

  it('is empty for a Bureau that keeps no audit trail', async () => {
    expect(
      await readRunVerdicts({ trail: undefined, tasks: tasksOf({}) }, 'run-1', 'workflow'),
    ).toEqual([]);
  });
});
