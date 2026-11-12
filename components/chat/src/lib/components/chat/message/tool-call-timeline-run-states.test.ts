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

  test('a single running step shows its position, and a step with no known start shows no time', async () => {
    const { container } = render(ToolCallTimeline, {
      props: { pairs: [running('only')], describeToolCall },
    });
    await tick();
    expect(heading(container).querySelector('[data-step-position]')?.textContent).toBe(
      'Step 1 of 1',
    );
    expect(heading(container).querySelector('[data-elapsed]')).toBeNull();
    expect(heading(container).textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Searching sources… Step 1 of 1',
    );
  });

  test('a call a finished run left unanswered does not turn, count or tick', async () => {
    const timers = trackTimers();
    try {
      const { container } = render(ToolCallTimeline, {
        props: {
          pairs: [done('s1'), running('s2')],
          describeToolCall,
          activityActive: false,
          startTimes: new Map([['s2', Date.now() - 86_400_000]]),
        },
      });
      await tick();
      const header = heading(container);
      expect(header.querySelector('.cinder-spinner')).toBeNull();
      expect(header.querySelector('[data-step-position]')).toBeNull();
      expect(header.querySelector('[data-elapsed]')).toBeNull();
      expect(header.querySelector('.chat-tool-call-activity-icon')).not.toBeNull();
      expect(header.querySelector('.chat-tool-call-running')?.textContent).toBe(
        'Searching sources',
      );
      expectNoLeakedTimers(timers.active());
    } finally {
      timers.release();
    }
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

  test('uses a supplied count-bearing summary without repeating row prose', async () => {
    const { container } = render(ToolCallTimeline, {
      props: {
        pairs: [done('s1'), done('s2')],
        describeToolCall,
        labels: {
          steps: (count: number) => `Compared ${count} recent orders…`,
        },
      },
    });
    await tick();
    const text = heading(container).textContent?.replace(/\s+/g, ' ').trim() ?? '';
    expect(text).toContain('Compared 2 recent orders…');
    expect(text).not.toContain('Searched sources');
    // No system name in a collapsed summary unless it is the repeated rollup.
    expect(heading(container).querySelector('.chat-tool-call-summary-tools')).toBeNull();
    expect(container.querySelector('.chat-tool-call-name')?.textContent?.trim()).toBe(
      'search_sources',
    );
  });
});

describe('R7: a failed step', () => {
  test('the header counts the steps that worked, then the failed count, as one phrase', async () => {
    const { container } = render(ToolCallTimeline, {
      props: { pairs: [done('s1'), done('s2'), failed('s3')], describeToolCall },
    });
    await tick();
    const count = heading(container).querySelector('.chat-tool-call-summary-count');
    expect(count?.textContent).toBe('2 of 3 steps');
    expect(count?.nextElementSibling?.matches('[data-problem]')).toBe(true);
    expect(count?.nextElementSibling?.textContent).toBe('1 failed');
    expect(count?.nextElementSibling?.nextElementSibling?.textContent).toBe('Searched sources');
    expect(heading(container).querySelector('.chat-tool-call-summary-tools')).toBeNull();
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
    expect(count?.textContent).toBe('Checked 2 of 3 sources');
    expect(count?.nextElementSibling?.matches('[data-problem]')).toBe(true);
    expect(count?.nextElementSibling?.textContent).toBe('1 failed');
    expect(count?.nextElementSibling?.nextElementSibling?.textContent).toBe('Searched sources');
  });

  test('does not expose raw tool names in a collapsed human-action header', async () => {
    const approval: ToolCallPair = {
      call: { id: 'approval', name: 'issue_refund', arguments: { orderId: '4471' } },
      result: {
        callId: 'approval',
        outcome: 'action_required',
        action: { type: 'approval', operation: { kind: 'other' } },
      },
    } as unknown as ToolCallPair;
    const { container } = render(ToolCallTimeline, {
      props: {
        pairs: [done('s1'), approval],
        describeToolCall,
        expanded: false,
      },
    });
    await tick();
    expect(heading(container).querySelector('.chat-tool-call-summary-tools')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('.chat-tool-call-name'), (element) =>
        element.textContent?.trim(),
      ),
    ).toContain('issue_refund');
  });

  test('a call a card in the turn speaks for says no waiting word in the summary', async () => {
    const approval = {
      call: { id: 'approval', name: 'issue_refund', arguments: {} },
      result: {
        callId: 'approval',
        outcome: 'action_required',
        action: { type: 'approval', operation: { kind: 'other' } },
      },
    } as unknown as ToolCallPair;
    const alone = render(ToolCallTimeline, { props: { pairs: [approval], describeToolCall } });
    await tick();
    expect(heading(alone.container).querySelector('[data-problem]')).not.toBeNull();
    alone.unmount();
    const owned = render(ToolCallTimeline, {
      props: { pairs: [approval], describeToolCall, cardOwnedCallIds: new Set(['approval']) },
    });
    await tick();
    expect(heading(owned.container).querySelector('[data-problem]')).toBeNull();
  });

  test('the failed row opens with its failure in view, a danger summary and a wrapping diagnostic', async () => {
    const { container } = render(ToolCallTimeline, {
      props: { pairs: [done('s1'), done('s2'), failed('s3')], describeToolCall },
    });
    await tick();
    const item = container.querySelector('[data-cinder-tool-call-status="failed"]');
    const row = item?.querySelector('.chat-tool-call-row');
    expect(row?.getAttribute('aria-expanded')).toBe('true');
    expect(row?.querySelector('.chat-tool-call-status')).toBeNull();
    const failure = item?.querySelector('.chat-tool-call-failure');
    expect(failure?.querySelector('.chat-tool-call-failure-summary')?.textContent?.trim()).toBe(
      'parcelly.example did not answer within 10 s.',
    );
    const diagnostic = failure?.querySelector('.chat-tool-call-diagnostic');
    expect(diagnostic?.textContent).toContain('GET /track/4471 timed out after 10000 ms');
    expect(diagnostic?.getAttribute('dir')).toBe('auto');
  });

  test('icon-only Copy error tooltip pairs with Retry this step and preserves the call id', async () => {
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
    expect(actions?.querySelectorAll('button')).toHaveLength(2);
    expect(getByRole('button', { name: 'Copy error' }).hasAttribute('data-cinder-icon-only')).toBe(
      true,
    );
    const tooltip = actions?.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('Copy error');
    expect(tooltip?.hasAttribute('data-cinder-visible')).toBe(false);
    await fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(retryStep).toHaveBeenCalledWith('s3');
  });

  test('a denial reported as an error reads Denied, with no danger summary and no retry', async () => {
    const denied: ToolCallPair = {
      call: { id: 'refund-1', name: 'issue_refund', arguments: { orderId: '4471' } },
      result: {
        callId: 'refund-1',
        outcome: 'error',
        content: null,
        error: {
          code: 'denied',
          category: 'internal',
          retryable: false,
          message: 'The user denied this call',
        },
      },
    };
    const { container, queryByRole } = render(ToolCallTimeline, {
      props: {
        pairs: [denied],
        approvalStates: new Map([['refund-1', 'denied' as const]]),
        onRetryStep: () => undefined,
      },
    });
    await tick();
    expect(container.querySelector('.chat-tool-call-failure')).toBeNull();
    expect(queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(container.textContent).toContain('The user denied this call');
  });

  test('without the callback only Copy error shows', async () => {
    const { queryByRole, getByRole } = render(ToolCallTimeline, {
      props: { pairs: [failed('s1')], describeToolCall },
    });
    await tick();
    expect(queryByRole('button', { name: 'Retry' })).toBeNull();
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

  test('coarse failed rows place status and duration in separate grid slots', async () => {
    const source = await Bun.file(new URL('./tool-call-timeline.svelte', import.meta.url)).text();
    expect(source).toMatch(
      /\.chat-tool-call-result\s*\{\s*grid-column:\s*2 \/ -1;\s*grid-row:\s*3;/su,
    );
    expect(source).toMatch(
      /\.chat-tool-call-status\s*\{\s*grid-column:\s*3;\s*\}\s*\.chat-tool-call-duration\s*\{\s*grid-column:\s*3;\s*grid-row:\s*2;/su,
    );
  });

  test('the count is never shrunk; the description and tool name yield space', async () => {
    const source = await Bun.file(new URL('./tool-call-timeline.svelte', import.meta.url)).text();
    expect(source).toMatch(/\.chat-tool-call-summary-count\s*\{\s*flex:\s*0 0 auto;/su);
    expect(source).toMatch(
      /data-has-repeated-summary='true'\]\s+\.chat-tool-call-summary\s*\{\s*display:\s*grid;/su,
    );
    expect(source).toMatch(
      /data-has-repeated-summary='true'\]\s+\.chat-tool-call-summary-tools\s*\{[\s\S]*?grid-column:\s*1;[\s\S]*?grid-row:\s*2;[\s\S]*?flex:\s*none;/su,
    );
    expect(source).toMatch(/\.chat-tool-call-summary-duration\s*\{\s*flex:\s*0 0 auto;/su);
  });
});
