/**
 * COR-1876 — a contributed formatter's sentence appears for its kind, and an event no formatter
 * claims is shown by its raw kind and the run it names.
 */
import type { PluginEventFormatter } from '@lostgradient/interborough-plugin';
import { describe, expect, it } from 'bun:test';

import { createBureauEventFormatter } from './bureau-event-formatting.ts';

const EVENT = {
  kind: 'run.settled',
  bureauId: 'bureau-1',
  emittedAtMs: 1,
  payload: { runId: 'run-7' },
};

const settled: PluginEventFormatter = {
  name: 'settled',
  eventKinds: ['run.settled'],
  format: (event) => ({ title: `Run finished (${event.kind})`, body: 'It went well.' }),
};

describe('formatting an event', () => {
  it('uses the sentence of the formatter that claims the kind', () => {
    const format = createBureauEventFormatter([{ plugin: 'reports', formatter: settled }]);
    expect(format(EVENT)).toEqual({
      kind: 'run.settled',
      title: 'Run finished (run.settled)',
      body: 'It went well.',
      runId: 'run-7',
      formattedBy: 'reports/settled',
    });
  });

  it('shows the raw kind and the run link for a kind no formatter claims', () => {
    const format = createBureauEventFormatter([{ plugin: 'reports', formatter: settled }]);
    expect(format({ ...EVENT, kind: 'run.registered' })).toEqual({
      kind: 'run.registered',
      title: 'run.registered',
      runId: 'run-7',
    });
    expect(createBureauEventFormatter(undefined)(EVENT)).toEqual({
      kind: 'run.settled',
      title: 'run.settled',
      runId: 'run-7',
    });
  });

  it('leaves out the run link when the payload names no run, and carries the event’s source', () => {
    const format = createBureauEventFormatter([]);
    expect(format({ ...EVENT, kind: 'diagnostic', payload: {}, source: 'calendar' })).toEqual({
      kind: 'diagnostic',
      title: 'diagnostic',
      source: 'calendar',
    });
  });

  it('shows the raw kind, and says so, when a formatter throws or returns no title', () => {
    const messages: string[] = [];
    const throwing: PluginEventFormatter = {
      name: 'throwing',
      eventKinds: ['run.settled'],
      format: () => {
        throw new Error('boom');
      },
    };
    const untitled: PluginEventFormatter = {
      name: 'untitled',
      eventKinds: ['run.removed'],
      format: () => ({ title: '' }),
    };
    const format = createBureauEventFormatter(
      [
        { plugin: 'reports', formatter: throwing },
        { plugin: 'reports', formatter: untitled },
      ],
      (message) => messages.push(message),
    );
    expect(format(EVENT).title).toBe('run.settled');
    expect(format({ ...EVENT, kind: 'run.removed' }).title).toBe('run.removed');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('reports/throwing');
  });

  it('refuses two formatters that claim one kind', () => {
    expect(() =>
      createBureauEventFormatter([
        { plugin: 'reports', formatter: settled },
        { plugin: 'other', formatter: { ...settled, name: 'again' } },
      ]),
    ).toThrow('reports/settled');
  });
});
