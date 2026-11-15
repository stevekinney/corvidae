/**
 * COR-1876 — a contributed formatter's sentence appears for its kind, and an event no formatter
 * claims is shown by its raw kind and the run it names.
 */
import type { PluginFormatter } from '@lostgradient/interborough-plugin';
import { describe, expect, it } from 'bun:test';

import { createBureauEventFormatter } from './bureau-event-formatting.ts';

const EVENT = {
  kind: 'run.settled',
  bureauId: 'bureau-1',
  emittedAtMs: 1,
  payload: { runId: 'run-7' },
};

const settled: PluginFormatter = {
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
      tier: 'info',
      runId: 'run-7',
      formattedBy: 'reports/settled',
    });
  });

  it('shows the raw kind and the run link for a kind no formatter claims', () => {
    const format = createBureauEventFormatter([{ plugin: 'reports', formatter: settled }]);
    expect(format({ ...EVENT, kind: 'run.registered' })).toEqual({
      kind: 'run.registered',
      title: 'run.registered',
      tier: 'info',
      runId: 'run-7',
    });
    expect(createBureauEventFormatter(undefined)(EVENT)).toEqual({
      kind: 'run.settled',
      title: 'run.settled',
      tier: 'info',
      runId: 'run-7',
    });
  });

  it('leaves out the run link when the payload names no run, and carries the event’s source', () => {
    const format = createBureauEventFormatter([]);
    expect(format({ ...EVENT, kind: 'diagnostic', payload: {}, source: 'calendar' })).toEqual({
      kind: 'diagnostic',
      title: 'diagnostic',
      tier: 'info',
      source: 'calendar',
    });
  });

  it('shows the raw kind, and says so, when a formatter throws or returns no title', () => {
    const messages: string[] = [];
    const throwing: PluginFormatter = {
      name: 'throwing',
      eventKinds: ['run.settled'],
      format: () => {
        throw new Error('boom');
      },
    };
    const untitled: PluginFormatter = {
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

  describe('the tier, icon and link of a formatting (COR-2222)', () => {
    const formatting = (output: unknown) =>
      createBureauEventFormatter([
        { plugin: 'reports', formatter: { ...settled, format: () => output as never } },
      ])(EVENT);

    it('carries all three when a formatter gives them', () => {
      expect(
        formatting({
          title: 'Run failed',
          tier: 'critical',
          icon: 'circle-alert',
          link: '/runs/7',
        }),
      ).toEqual({
        kind: 'run.settled',
        title: 'Run failed',
        tier: 'critical',
        icon: 'circle-alert',
        link: '/runs/7',
        runId: 'run-7',
        formattedBy: 'reports/settled',
      });
    });

    it.each(['critical', 'warning', 'info'] as const)('keeps the %s tier', (tier) => {
      expect(formatting({ title: 'x', tier }).tier).toBe(tier);
    });

    it('yields tier info, and no icon or link, for the members a formatter leaves out', () => {
      const result = formatting({ title: 'x' });
      expect(result.tier).toBe('info');
      expect(Object.hasOwn(result, 'icon')).toBe(false);
      expect(Object.hasOwn(result, 'link')).toBe(false);
    });

    it.each([
      ['an unknown tier', { tier: 'urgent' }],
      ['a tier that is not a string', { tier: 3 }],
    ])('treats %s as info', (_name, extra) => {
      expect(formatting({ title: 'x', ...extra }).tier).toBe('info');
    });

    it.each([
      ['a relative path', 'runs/7'],
      ['a URL', 'https://example.com/runs/7'],
      ['a protocol-relative URL', '//example.com/runs/7'],
      ['a backslash path', '/\\example.com'],
      ['a mailto link', 'mailto:someone@example.com'],
      ['an empty string', ''],
      ['a value that is not a string', 7],
    ])('drops %s as a link', (_name, link) => {
      const result = formatting({ title: 'x', link });
      expect(Object.hasOwn(result, 'link')).toBe(false);
      expect(result.title).toBe('x');
    });

    it('keeps a router path with a query and a fragment', () => {
      expect(formatting({ title: 'x', link: '/runs/7?tab=steps#top' }).link).toBe(
        '/runs/7?tab=steps#top',
      );
    });

    it.each([
      ['an empty icon', ''],
      ['an icon that is not a string', 4],
    ])('drops %s', (_name, icon) => {
      expect(Object.hasOwn(formatting({ title: 'x', icon }), 'icon')).toBe(false);
    });
  });

  describe('bounding what a formatter returns (COR-2221)', () => {
    const formatting = (output: unknown, diagnose?: (message: string) => void) =>
      createBureauEventFormatter(
        [{ plugin: 'reports', formatter: { ...settled, format: () => output as never } }],
        diagnose,
      )(EVENT);

    it('cuts a title to 200 characters', () => {
      expect(formatting({ title: 'a'.repeat(500) }).title).toBe('a'.repeat(200));
      expect(formatting({ title: 'a'.repeat(200) }).title).toBe('a'.repeat(200));
    });

    it('does not leave half of a surrogate pair at the cut', () => {
      const emoji = String.fromCodePoint(0x1f600);
      const title = formatting({ title: `${'a'.repeat(199)}${emoji}tail` }).title;
      expect(title).toBe('a'.repeat(199));
    });

    it('turns every newline in a title into a space', () => {
      const lineSeparator = String.fromCharCode(0x2028);
      const paragraphSeparator = String.fromCharCode(0x2029);
      const { title } = formatting({
        title: `one\ntwo\r\nthree\rfour${lineSeparator}five${paragraphSeparator}six`,
      });
      expect(title).toBe('one two three four five six');
    });

    it('cuts a body to 2,000 characters and keeps one within the limit', () => {
      expect(formatting({ title: 't', body: 'b'.repeat(5000) }).body).toBe('b'.repeat(2000));
      expect(formatting({ title: 't', body: 'b'.repeat(2000) }).body).toBe('b'.repeat(2000));
    });

    it('keeps the line breaks of a body', () => {
      expect(formatting({ title: 't', body: 'one\ntwo' }).body).toBe('one\ntwo');
    });

    it('drops a body that is not a string, says so once, and keeps the title', () => {
      for (const body of [42, null, { text: 'x' }, ['x']]) {
        const messages: string[] = [];
        const result = formatting({ title: 'Run finished', body }, (message) =>
          messages.push(message),
        );
        expect(result.title).toBe('Run finished');
        expect(result.formattedBy).toBe('reports/settled');
        expect(Object.hasOwn(result, 'body')).toBe(false);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('reports/settled');
      }
    });

    it('says nothing about a body a formatter leaves out', () => {
      const messages: string[] = [];
      formatting({ title: 'Run finished' }, (message) => messages.push(message));
      expect(messages).toEqual([]);
    });
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
