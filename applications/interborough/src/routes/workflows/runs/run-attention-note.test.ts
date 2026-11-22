/**
 * The Run page's note for a run that needs a look (COR-2528): a stalled run says when it was seen
 * to stall and so that it last made progress before then, a looping run says its tools reported a
 * loop, and a run over the spend threshold says what it cost, whether it is still going or not.
 * Read in the sample world's zone.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import RunAttentionNote from './run-attention-note.svelte';
import { runAttentionNotes } from './run-attention-note.ts';

afterEach(cleanup);

const ZONE = 'America/Chicago';
/** Monday, Nov 2, 2026, 10:50 AM Central time. */
const NOW = Date.parse('2026-11-02T10:50:00-06:00');

describe('the notes of a task', () => {
  test('are none for a task with no attention state, or from a Bureau that reports none', () => {
    expect(runAttentionNotes(taskFixture({ attention: [] }), NOW, ZONE)).toEqual([]);
    expect(runAttentionNotes(taskFixture(), NOW, ZONE)).toEqual([]);
  });

  test('of a stalled run say when it was seen to stall, and that it last made progress before then', () => {
    const [note, ...rest] = runAttentionNotes(
      taskFixture({
        status: 'working',
        attention: ['stalled'],
        stalledSince: '2026-11-02T09:05:00-06:00',
      }),
      NOW,
      ZONE,
    );
    expect(rest).toEqual([]);
    expect(note).toEqual({
      state: 'stalled',
      title: 'This run has stopped making progress',
      line: 'It was seen stalled at 9:05 AM, so it last made progress before then. It is still running.',
    });
  });

  test('of a stalled run name the day when it stalled before today', () => {
    const [note] = runAttentionNotes(
      taskFixture({
        status: 'working',
        attention: ['stalled'],
        stalledSince: '2026-11-01T16:12:00-06:00',
      }),
      NOW,
      ZONE,
    );
    expect(note?.line).toContain('It was seen stalled yesterday at 4:12 PM,');
    const [older] = runAttentionNotes(
      taskFixture({
        status: 'working',
        attention: ['stalled'],
        stalledSince: '2026-10-29T16:12:00-05:00',
      }),
      NOW,
      ZONE,
    );
    expect(older?.line).toContain('It was seen stalled on Thu, Oct 29, 4:12 PM,');
  });

  test('of a stalled run with no recorded instant still say it stalled, and make no claim about when', () => {
    const [note] = runAttentionNotes(
      taskFixture({ status: 'working', attention: ['stalled'], stalledSince: null }),
      NOW,
      ZONE,
    );
    expect(note?.line).toBe('It was seen stalled, and it is still running.');
  });

  test('of a looping run say so, and that it keeps running', () => {
    const [note] = runAttentionNotes(
      taskFixture({ status: 'working', attention: ['looping'] }),
      NOW,
      ZONE,
    );
    expect(note).toEqual({
      state: 'looping',
      title: 'This run is repeating itself',
      line: 'Its tools reported a loop. It keeps running until you stop it.',
    });
  });

  test('of a run over the spend threshold say what it cost, going or settled', () => {
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 12.3456 };
    const [going] = runAttentionNotes(
      taskFixture({ status: 'working', attention: ['overspending'], usage }),
      NOW,
      ZONE,
    );
    expect(going?.title).toBe('This run is over the spend threshold');
    expect(going?.line).toBe(
      'It has cost $12.35, more than the spend threshold. It keeps running until you stop it.',
    );
    const [settled] = runAttentionNotes(
      taskFixture({ status: 'completed', attention: ['overspending'], usage }),
      NOW,
      ZONE,
    );
    expect(settled?.line).toBe('It cost $12.35, more than the spend threshold.');
    const [unpriced] = runAttentionNotes(
      taskFixture({ status: 'completed', attention: ['overspending'], usage: null }),
      NOW,
      ZONE,
    );
    expect(unpriced?.line).toBe('It cost more than the spend threshold.');
  });

  test('come one for each state, in the order stalled, looping, overspending', () => {
    const notes = runAttentionNotes(
      taskFixture({
        status: 'working',
        attention: ['overspending', 'looping', 'stalled'],
        stalledSince: '2026-11-02T09:05:00-06:00',
      }),
      NOW,
      ZONE,
    );
    expect(notes.map((note) => note.state)).toEqual(['stalled', 'looping', 'overspending']);
  });
});

describe('the note on the page', () => {
  test('is one note for each state, and nothing for a run with none', () => {
    const quiet = render(RunAttentionNote, { props: { task: taskFixture() } });
    expect(quiet.container.querySelector('[data-testid="run-attention-note"]')).toBeNull();
    cleanup();

    const view = render(RunAttentionNote, {
      props: { task: taskFixture({ status: 'working', attention: ['looping', 'stalled'] }) },
    });
    const notes = [...view.container.querySelectorAll('[data-testid="run-attention-note"]')];
    expect(notes.map((note) => note.getAttribute('data-attention'))).toEqual([
      'stalled',
      'looping',
    ]);
    expect(notes[0]?.textContent).toContain('This run has stopped making progress');
  });
});
