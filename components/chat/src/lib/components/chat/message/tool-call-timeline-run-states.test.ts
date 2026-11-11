/**
 * COR-2283: the steps of a run say where they stand (rows R1 and R7 of the run-states board). The
 * step under way turns, ends its present-tense title in an ellipsis, and shows where it falls and
 * how long it has run; a failed step is counted in the header, opens with Failed in view, and
 * offers what went wrong, the rest of the error, Copy error and Retry this step.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import { tick } from 'svelte';

import { expectNoLeakedTimers, setupHappyDom, trackTimers } from '@lostgradient/testing';
import type { ToolCallPair } from '../conversation-model.ts';
import type { ToolCallPresentation } from '../utilities/types.ts';

setupHappyDom();

const { render, cleanup, fireEvent } = await import('@testing-library/svelte');
const { default: ToolCallTimeline } = await import('./tool-call-timeline.svelte');

const NOW = new Date('2026-11-11T12:00:00.000Z');

afterEach(() => {
  if (jest.isFakeTimers()) jest.useRealTimers();
  cleanup();
  document.body.replaceChildren();
});

function done(id: string, name = 'search_sources'): ToolCallPair {
  return {
    call: { id, name, arguments: { query: id } },
    result: { callId: id, outcome: 'success', content: `${id} ok` },
  };
}

function running(id: string, name = 'search_sources'): ToolCallPair {
  return { call: { id, name, arguments: { query: id } } };
}

function failed(id: string): ToolCallPair {
  return {
    call: { id, name: 'fetch_source', arguments: { url: 'https://parcelly.example/track/4471' } },
    result: {
      callId: id,
      outcome: 'error',
      content: null,
      error: {
        code: 'timeout',
        category: 'timeout',
        retryable: true,
        message: 'parcelly.example did not answer within 10 s.',
        details: { status: 504, attempts: 3, trace: 'GET /track/4471 timed out after 10000 ms' },
      },
    },
  };
}

const describeToolCall = (pair: ToolCallPair): ToolCallPresentation =>
  pair.result === undefined
    ? { verb: 'Searching', tense: 'present', detail: 'sources', kind: 'search' }
    : { verb: 'Searched', tense: 'past', detail: 'sources', kind: 'search' };

function heading(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('.chat-tool-call-heading');
  expect(element).not.toBeNull();
  return element!;
}

describe('R1: the step under way', () => {
  test('a spinner, a present-tense title ending in an ellipsis, Step N of M and the time it has run', async () => {
    jest.useFakeTimers({ now: NOW });
    const { container } = render(ToolCallTimeline, {
      props: {
        messageId: 'running-step',
        pairs: [done('s1'), done('s2'), running('s3')],
        describeToolCall,
        activityActive: true,
        startTimes: new Map([['s3', NOW.getTime() - 4_500]]),
      },
    });
    await tick();
    const header = heading(container);
    expect(header.querySelector('.chat-tool-call-spinner .cinder-spinner')).not.toBeNull();
    expect(header.querySelector('.chat-tool-call-spinner')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(header.querySelector('.chat-tool-call-running')?.textContent).toBe('Searching sources…');
    expect(header.querySelector('[data-step-position]')?.textContent).toBe('Step 3 of 3');
    expect(header.querySelector('[data-elapsed]')?.textContent).toBe('4s');
    // The running step's own row turns too.
    const rows = container.querySelectorAll('.chat-tool-call-row');
    expect(rows[2]?.querySelector('.chat-tool-call-row-spinner .cinder-spinner')).not.toBeNull();
    expect(rows[0]?.querySelector('.chat-tool-call-row-spinner')).toBeNull();
  });

  test('the elapsed time counts up once a second without a host update', async () => {
    jest.useFakeTimers({ now: NOW });
    const { container } = render(ToolCallTimeline, {
      props: {
        pairs: [done('s1'), running('s2')],
        describeToolCall,
        startTimes: new Map([['s2', NOW.getTime()]]),
      },
    });
    await tick();
    expect(heading(container).querySelector('[data-elapsed]')?.textContent).toBe('0s');

    jest.advanceTimersByTime(1_000);
    await tick();
    expect(heading(container).querySelector('[data-elapsed]')?.textContent).toBe('1s');

    jest.advanceTimersByTime(64_000);
    await tick();
    expect(heading(container).querySelector('[data-elapsed]')?.textContent).toBe('1m 5s');
  });

  test('a single step shows no position, and a step with no known start shows no time', async () => {
    const { container } = render(ToolCallTimeline, {
      props: { pairs: [running('only')], describeToolCall },
    });
    await tick();
    expect(heading(container).querySelector('[data-step-position]')).toBeNull();
    expect(heading(container).querySelector('[data-elapsed]')).toBeNull();
    expect(heading(container).textContent?.replace(/\s+/g, ' ').trim()).toBe('Searching sources…');
  });

  test('a title the host words without an ellipsis gains one', async () => {
    const { container } = render(ToolCallTimeline, {
      props: {
        pairs: [running('only')],
        describeToolCall: () => ({ verb: 'Checking', tense: 'present', detail: 'the carrier' }),
      },
    });
    await tick();
    expect(heading(container).querySelector('.chat-tool-call-running')?.textContent).toBe(
      'Checking the carrier…',
    );
  });

  test('once the step answers, the header returns to the count and the clock stops', async () => {
    const timers = trackTimers();
    try {
      const view = render(ToolCallTimeline, {
        props: {
          pairs: [done('s1'), running('s2')],
          describeToolCall,
          startTimes: new Map([['s2', Date.now()]]),
        },
      });
      await tick();
      expect(timers.active().size).toBeGreaterThan(0);

      await view.rerender({ pairs: [done('s1'), done('s2')] });
      await tick();
      expect(heading(view.container).querySelector('[data-elapsed]')).toBeNull();
      expect(heading(view.container).textContent).toContain('2 steps');
      expectNoLeakedTimers(timers.active());
    } finally {
      timers.release();
    }
  });
});

describe('R7: a failed step', () => {
  test('the header counts the steps that worked, then the failed count, as one phrase', async () => {
    const { container } = render(ToolCallTimeline, {
      props: { pairs: [done('s1'), done('s2'), failed('s3')], describeToolCall },
    });
    await tick();
    const count = heading(container).querySelector('.chat-tool-call-summary-count');
    expect(count?.textContent).toBe('2 of 3 steps,');
    expect(count?.nextElementSibling?.textContent).toBe('1 failed');
    expect(heading(container).textContent).not.toContain(String.fromCodePoint(0xb7));
  });

  test('the host can say what the steps were', async () => {
    const { container } = render(ToolCallTimeline, {
      props: {
        pairs: [done('s1'), done('s2'), failed('s3')],
        describeToolCall,
        labels: {
          stepsDone: (worked: number, total: number) => `Checked ${worked} of ${total} sources`,
        },
      },
    });
    await tick();
    const count = heading(container).querySelector('.chat-tool-call-summary-count');
    expect(count?.textContent).toBe('Checked 2 of 3 sources,');
    expect(count?.nextElementSibling?.textContent).toBe('1 failed');
  });

  test('the failed row opens with Failed in view, a danger summary and a wrapping diagnostic', async () => {
    const { container } = render(ToolCallTimeline, {
      props: { pairs: [done('s1'), done('s2'), failed('s3')], describeToolCall },
    });
    await tick();
    const item = container.querySelector('[data-cinder-tool-call-status="failed"]');
    const row = item?.querySelector('.chat-tool-call-row');
    expect(row?.getAttribute('aria-expanded')).toBe('true');
    expect(row?.querySelector('.chat-tool-call-status')?.textContent).toBe('Failed');
    const failure = item?.querySelector('.chat-tool-call-failure');
    expect(failure?.querySelector('.chat-tool-call-failure-summary')?.textContent?.trim()).toBe(
      'parcelly.example did not answer within 10 s.',
    );
    const diagnostic = failure?.querySelector('.chat-tool-call-diagnostic');
    expect(diagnostic?.textContent).toContain('GET /track/4471 timed out after 10000 ms');
    expect(diagnostic?.getAttribute('dir')).toBe('auto');
  });

  test('Copy error then Retry this step, and Retry hands the host the call id', async () => {
    const retryStep = mock((_toolCallId: string) => undefined);
    const { container, getByRole } = render(ToolCallTimeline, {
      props: {
        pairs: [done('s1'), done('s2'), failed('s3')],
        describeToolCall,
        onRetryStep: retryStep,
      },
    });
    await tick();
    const actions = container.querySelector('.chat-tool-call-failure-actions');
    expect(
      Array.from(actions?.querySelectorAll('button') ?? [], (button) => button.textContent?.trim()),
    ).toEqual(['Copy error', 'Retry this step']);
    await fireEvent.click(getByRole('button', { name: 'Retry this step' }));
    expect(retryStep).toHaveBeenCalledWith('s3');
  });

  test('without the callback only Copy error shows', async () => {
    const { queryByRole, getByRole } = render(ToolCallTimeline, {
      props: { pairs: [failed('s1')], describeToolCall },
    });
    await tick();
    expect(queryByRole('button', { name: 'Retry this step' })).toBeNull();
    expect(getByRole('button', { name: 'Copy error' })).not.toBeNull();
  });

  test('the status is never clipped: a failed row wraps and its status never shrinks', async () => {
    const source = await Bun.file(new URL('./tool-call-timeline.svelte', import.meta.url)).text();
    expect(source).toMatch(
      /\.chat-tool-call-item\[data-cinder-tool-call-status='failed'\] \.chat-tool-call-row\s*\{\s*flex-wrap:\s*wrap;/u,
    );
    expect(source).toMatch(
      /\.chat-tool-call-status,\s*\.chat-tool-call-duration\s*\{\s*flex:\s*none;/u,
    );
    expect(source).toMatch(/\.chat-tool-call-diagnostic\s*\{[^}]*white-space:\s*pre-wrap;/su);
  });
});
