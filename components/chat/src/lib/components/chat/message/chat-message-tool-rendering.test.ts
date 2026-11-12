/**
 * Regression guards for how `ChatMessage` renders tool-call messages through
 * the parts spine. The contract that matters: a tool-call message renders a
 * `ToolCallTimeline` card when a resolved pair is supplied (mirroring the
 * original `isToolCall && toolPair` guard). A standalone `<ChatMessage>` given
 * an empty `toolCallPairs` must fall through to the plain text body — NOT a
 * pending card — exactly as before the parts refactor.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRawSnippet, tick } from 'svelte';

import { expectNoLeakedTimers, setupHappyDom, trackTimers } from '@lostgradient/testing';
import { injectStyles } from '../../../test/css.ts';
import type { Message, ToolCallPair } from '../conversation-model.ts';
import type { ToolCallPresentation } from '../utilities/types.ts';

setupHappyDom();

const { render, cleanup, fireEvent } = await import('@testing-library/svelte');
const { default: ChatMessage } = await import('./chat-message.svelte');
const { default: ToolCallTimeline } = await import('./tool-call-timeline.svelte');

const cinderSrOnlyCss = await Bun.file(
  new URL('../../../../../../cinder/src/styles/utilities.css', import.meta.url),
).text();

function toolCallMessage(): Message {
  return {
    id: 'tc-1',
    role: 'tool-call',
    content: 'raw tool-call text body',
    position: 0,
    createdAt: '2026-06-02T00:00:00.000Z',
    metadata: {},
    hidden: false,
    toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
  };
}

function userMessage(overrides?: Partial<Message>): Message {
  return {
    id: 'user-1',
    role: 'user',
    content: 'Please regenerate this answer.',
    position: 0,
    createdAt: '2026-06-02T12:34:00.000Z',
    metadata: {},
    hidden: false,
    ...overrides,
  };
}

async function clickAndFlush(element: HTMLElement): Promise<void> {
  await fireEvent.click(element);
  await tick();
}

function groupToggle(container: HTMLElement): HTMLButtonElement {
  const toggle = container.querySelector<HTMLButtonElement>('.chat-tool-call-toggle');
  expect(toggle).not.toBeNull();
  return toggle!;
}

function callRows(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.chat-tool-call-row'));
}

/** Opens the group, then the call at `index`, unless either is already open. */
async function openCall(container: HTMLElement, index = 0): Promise<void> {
  const toggle = groupToggle(container);
  if (toggle.getAttribute('aria-expanded') !== 'true') await clickAndFlush(toggle);
  const row = callRows(container)[index]!;
  if (row.getAttribute('aria-expanded') !== 'true') await clickAndFlush(row);
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('ChatMessage — tool-call rendering', () => {
  test('does not leave an orphan timestamp for a paired pending approval', () => {
    const message = toolCallMessage();
    const pair: ToolCallPair = {
      call: message.toolCall!,
      result: {
        callId: message.toolCall!.id,
        outcome: 'action_required',
        content: null,
        action: {
          type: 'approval',
          risk: 'high',
          operation: { kind: 'command', command: 'echo approval', argsPreview: {} },
          policyVersion: 'test-policy',
          idempotencyKey: 'approval-1',
        },
      },
    } as unknown as ToolCallPair;
    const { container } = render(ChatMessage, {
      props: {
        message: { ...message, content: '' },
        toolCallPairs: [pair],
        presentation: 'transcript',
      },
    });

    expect(container.querySelector('[data-cinder-tool-approval]')).not.toBeNull();
    expect(container.querySelector('.chat-message-line')).not.toBeNull();
    expect(container.querySelectorAll('time')).toHaveLength(0);
  });

  test('forwards an expired approval retry to the host with its tool call id', async () => {
    const message = toolCallMessage();
    const pair: ToolCallPair = {
      call: message.toolCall!,
      result: {
        callId: message.toolCall!.id,
        outcome: 'action_required',
        content: null,
        action: {
          type: 'approval',
          risk: 'high',
          operation: { kind: 'command', command: 'echo approval', argsPreview: {} },
          policyVersion: 'test-policy',
          idempotencyKey: 'approval-1',
          expiresAt: '2020-01-01T00:00:00.000Z',
        },
      },
    };
    const calls: string[] = [];
    const { getByRole } = render(ChatMessage, {
      props: {
        message: { ...message, content: '' },
        toolCallPairs: [pair],
        approvalStates: new Map([['call-1', 'expired' as const]]),
        onApprovalRequestAgain: (toolCallId: string) => calls.push(toolCallId),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Ask again' }));
    expect(calls).toEqual(['call-1']);
  });

  test('threads owning stream activity through message tool rendering', () => {
    const messageSource = readFileSync(join(import.meta.dir, 'chat-message.svelte'), 'utf8');
    const rendererSource = readFileSync(
      join(import.meta.dir, 'chat-message-parts-renderer.svelte'),
      'utf8',
    );
    const partSource = readFileSync(join(import.meta.dir, 'parts/tool-call-part.svelte'), 'utf8');

    expect(messageSource).toContain('toolActivityActive?: boolean');
    expect(messageSource).toContain('{toolActivityActive}');
    expect(rendererSource).toContain('activityActive={toolActivityActive}');
    expect(partSource).toContain('{activityActive}');
    expect(partSource).toContain('{onToggle}');
  });

  test('tool activity renders through the retained timeline, not the obsolete group component', () => {
    const source = readFileSync(join(import.meta.dir, 'tool-call-timeline.svelte'), 'utf8');
    expect(source).toContain('class="chat-tool-call-toggle"');
    expect(source).not.toContain('RunStepTimeline');
    expect(source).not.toContain('tool-call-group');
  });

  test('keeps tool surfaces on their structural reading widths without changing user bubbles', () => {
    const messageSource = readFileSync(join(import.meta.dir, 'chat-message.svelte'), 'utf8');
    const timelineSource = readFileSync(join(import.meta.dir, 'tool-call-timeline.svelte'), 'utf8');
    expect(messageSource).toMatch(
      /\.chat-message-wrapper\[data-tool-pair\]\s*\{[^}]*inline-size:\s*100%;[^}]*max-inline-size:\s*var\(--cinder-chat-message-max-width,\s*48rem\);[^}]*min-inline-size:\s*0;/s,
    );
    expect(messageSource).toContain(
      'max-width: min(80%, var(--cinder-chat-message-max-width, 48rem));',
    );
    expect(timelineSource).toMatch(
      /\.chat-tool-call-timeline\s*\{[^}]*inline-size:\s*100%;[^}]*max-inline-size:\s*var\(--cinder-chat-message-max-width,\s*48rem\);[^}]*min-inline-size:\s*0;/s,
    );
    expect(messageSource).not.toMatch(
      /\.chat-message-wrapper\[data-tool-pair\][\s\S]{0,180}inline-size:\s*min\(80%/,
    );
    expect(timelineSource).not.toMatch(/\.chat-tool-call-timeline[\s\S]{0,180}42rem/);
  });

  test('separates a timeline summary from its single approval card', () => {
    const source = readFileSync(join(import.meta.dir, '../container/chat.svelte'), 'utf8');
    expect(source).toMatch(
      /\.chat-tool-call-group\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*var\(--cinder-space-2\);/s,
    );
  });

  test('renders custom message status inside the semantic article while timestamps stay below the bubble', () => {
    const { container } = render(ChatMessage, {
      props: {
        message: userMessage(),
        status: createRawSnippet(() => ({
          render: () =>
            '<span data-testid="custom-status">The assistant could not complete this turn.</span>',
          setup: () => {},
        })),
      },
    });

    const bubble = container.querySelector('article.chat-message');
    const status = container.querySelector('[data-testid="custom-status"]');
    const statusRow = container.querySelector('.chat-message-status');
    const metadata = container.querySelector('.chat-message-metadata');
    const timestamp = metadata?.querySelector('time') ?? null;
    expect(bubble).not.toBeNull();
    expect(status).not.toBeNull();
    expect(statusRow).not.toBeNull();
    expect(metadata).not.toBeNull();
    expect(timestamp).not.toBeNull();
    expect(bubble!.contains(status)).toBe(true);
    expect(statusRow!.contains(status)).toBe(true);
    expect(metadata!.contains(timestamp)).toBe(true);
    expect(statusRow!.contains(timestamp)).toBe(false);
  });

  test('renders metadata snippets below the visual message bubble', () => {
    const { container } = render(ChatMessage, {
      props: {
        message: userMessage({ createdAt: '' }),
        metadata: createRawSnippet(() => ({
          render: () => '<span data-testid="read-receipt">Read</span>',
          setup: () => {},
        })),
      },
    });

    const bubble = container.querySelector('article.chat-message');
    const metadata = container.querySelector('.chat-message-metadata');
    const receipt = container.querySelector('[data-testid="read-receipt"]');
    expect(bubble).not.toBeNull();
    expect(metadata).not.toBeNull();
    expect(receipt).not.toBeNull();
    expect(metadata!.contains(receipt)).toBe(true);
    expect(bubble!.contains(receipt)).toBe(false);
  });

  test('compact edit save button exposes resend semantics to assistive technology', async () => {
    const { container } = render(ChatMessage, {
      props: {
        message: userMessage(),
        onEdit: () => {},
      },
    });

    await fireEvent.click(container.querySelector<HTMLButtonElement>('.chat-message-edit-button')!);
    const save = container.querySelector<HTMLButtonElement>('.chat-message-edit-save');
    expect(save).not.toBeNull();
    expect(save?.textContent?.trim()).toBe('Save');
    expect(save?.getAttribute('aria-label')).toBe('Save & Resend');
  });

  test('renders the ToolCallTimeline card when a resolved pair is supplied', () => {
    const message = toolCallMessage();
    const { container } = render(ChatMessage, {
      props: {
        message,
        toolCallPairs: [{ call: message.toolCall! }],
      },
    });
    expect(container.querySelector('.chat-tool-call-timeline')).not.toBeNull();
    expect(container.querySelector('.chat-tool-call-name')?.textContent).toBe('lookup');
    expect(
      container.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent,
    ).toContain('lookup: Pending');
    expect(container.querySelector('.chat-tool-call-status')?.textContent).toContain('Pending');
  });

  test('announces standalone tool status transitions', async () => {
    const message = toolCallMessage();
    const rendered = render(ChatMessage, {
      props: {
        message,
        toolCallPairs: [{ call: message.toolCall! }],
      },
    });
    const liveRegion = rendered.container.querySelector('[aria-live="polite"][aria-atomic="true"]');
    expect(liveRegion?.textContent).toContain('lookup: Pending');

    await rendered.rerender({
      message,
      toolCallPairs: [
        {
          call: message.toolCall!,
          result: { callId: 'call-1', outcome: 'success', content: 'found' },
        },
      ],
    });
    await tick();

    expect(liveRegion?.textContent).toContain('lookup: Complete');
  });

  test('presentation metadata changes the label and active icon without changing renderer', () => {
    const pair: ToolCallPair = { call: { id: 'search-1', name: 'search_web', arguments: {} } };
    const describeToolCall = (): ToolCallPresentation => ({
      verb: 'Searching',
      tense: 'present',
      detail: 'records',
      kind: 'search',
    });
    const active = render(ToolCallTimeline, {
      props: { pairs: [pair], describeToolCall, activityActive: true },
    });
    expect(active.container.querySelector('.chat-tool-call-timeline')).not.toBeNull();
    expect(active.container.querySelector('.chat-tool-call-label')?.textContent).toBe(
      'Searching records',
    );
    expect(active.container.querySelector('[data-cinder-tool-activity-active]')).not.toBeNull();
    cleanup();

    const inactive = render(ToolCallTimeline, {
      props: { pairs: [pair], describeToolCall, activityActive: false },
    });
    expect(inactive.container.querySelector('[data-cinder-tool-activity-active]')).toBeNull();
  });

  test('renders host tool labels for counts, statuses, problems, announcements and payloads', async () => {
    const failed: ToolCallPair = {
      call: { id: 'failed-labels', name: 'charge_card', arguments: { amount: 20 } },
      result: {
        callId: 'failed-labels',
        outcome: 'error',
        error: { message: 'Card declined' },
        content: 'declined',
      },
    } as unknown as ToolCallPair;
    const succeeded: ToolCallPair = {
      call: { id: 'success-labels', name: 'read_receipt', arguments: { format: 'json' } },
      result: { callId: 'success-labels', outcome: 'success', content: { ok: true } },
    };
    const { container } = render(ToolCallTimeline, {
      props: {
        pairs: [failed, succeeded],
        labels: {
          calls: (count) => `CALLS ${count}`,
          steps: (count) => `STEPS ${count}`,
          stepsDone: (done, total) => `DONE ${done}/${total}`,
          input: 'IN',
          output: 'OUT',
          error: 'ERR',
          toolStatus: (status) => `STATUS ${status}`,
          toolProblem: (count, status) => `PROBLEM ${count} ${status}`,
          toolAnnouncement: (name, status) => `ANN ${name} ${status}`,
        },
      },
    });

    expect(container.querySelector('.chat-tool-call-summary-count')?.textContent).toBe('DONE 1/2');
    expect(container.querySelector('.chat-tool-call-summary-segment')?.textContent).toBe(
      'PROBLEM 1 failed',
    );
    expect(container.querySelector('.chat-tool-call-list')?.getAttribute('aria-label')).toBe(
      'CALLS 2',
    );
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain(
      'ANN charge_card failed',
    );
    // A failed step says it once, through its title and cause line: no separate status word.
    expect(container.textContent).not.toContain('STATUS failed');
    expect(container.textContent).toContain('Card declined');
    await openCall(container, 1);
    expect(container.textContent).toContain('IN');
    expect(container.textContent).toContain('OUT');
  });

  test('result payloads keep ordinary strings as text and structured JSON as code', async () => {
    const textResult = render(ToolCallTimeline, {
      props: {
        pairs: [
          {
            call: { id: 'string-result', name: 'read_file', arguments: {} },
            result: { callId: 'string-result', outcome: 'success', content: 'plain file contents' },
          },
        ],
      },
    });
    await openCall(textResult.container);
    // The input `{}` is structured; the plain-string output stays text.
    const payloads = textResult.container.querySelectorAll('.chat-tool-call-payload');
    expect(payloads[0]?.querySelector('.cinder-code-block')).not.toBeNull();
    expect(payloads[1]?.querySelector('.cinder-code-block')).toBeNull();
    expect(payloads[1]?.querySelector('.chat-tool-call-payload-text')).not.toBeNull();
    expect(textResult.container.textContent).toContain('plain file contents');
    cleanup();

    const jsonResult = render(ToolCallTimeline, {
      props: {
        pairs: [
          {
            call: { id: 'json-result', name: 'lookup', arguments: {} },
            result: { callId: 'json-result', outcome: 'success', content: { ok: true } },
          },
        ],
      },
    });
    await openCall(jsonResult.container);
    expect(
      jsonResult.container.querySelectorAll('.chat-tool-call-details .cinder-code-block'),
    ).toHaveLength(2);
    expect(jsonResult.container.querySelector('.cinder-code-block__language')).toBeNull();
    expect(jsonResult.container.textContent).toContain('"ok"');
  });

  test('a result with parts shows its ordered text and media labels, not the structured value beside them (COR-1634)', async () => {
    const withParts = render(ToolCallTimeline, {
      props: {
        pairs: [
          {
            call: { id: 'chart-result', name: 'chart', arguments: {} },
            result: {
              callId: 'chart-result',
              outcome: 'success',
              content: { series: 'sales' },
              parts: [
                { type: 'text', text: 'Here is the chart:' },
                {
                  type: 'image',
                  mimeType: 'image/png',
                  name: 'chart.png',
                  source: { kind: 'remote-url', url: 'https://tracker.example/pixel.png' },
                },
              ],
            },
          },
        ],
      },
    });
    await openCall(withParts.container);
    const details = withParts.container.querySelector('.chat-tool-call-details');
    const output = details?.querySelectorAll('.chat-tool-call-payload')[1];
    const text = output?.textContent ?? '';
    expect(text).toContain('Here is the chart:');
    expect(text).toContain('[image: chart.png, image/png]');
    expect(text).not.toContain('"series"');
    expect(text).not.toContain('tracker.example');
  });

  test('grouped repeated call ids remain unique and preserve structured error details', async () => {
    const { container } = render(ToolCallTimeline, {
      props: {
        messageId: 'grouped-tools',
        describeToolCall: (pair: ToolCallPair) => ({
          verb: 'Checking',
          tense: 'present',
          detail: pair.call.name,
          kind: 'search',
        }),
        pairs: [
          {
            call: { id: 'repeated', name: 'first', arguments: {} },
            result: { callId: 'repeated', outcome: 'success', content: 'ok' },
          },
          {
            call: { id: 'repeated', name: 'second', arguments: {} },
            result: {
              callId: 'repeated',
              outcome: 'error',
              content: null,
              error: {
                code: 'offline',
                category: 'internal',
                retryable: true,
                message: 'Network unavailable',
              },
            },
          },
        ],
      },
    });

    const rows = callRows(container);
    expect(rows).toHaveLength(2);
    // A failure keeps the group and its own call open.
    expect(groupToggle(container).getAttribute('aria-expanded')).toBe('true');
    expect(rows.map((row) => row.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
    const controls = rows.map((row) => row.getAttribute('aria-controls'));
    expect(new Set(controls).size).toBe(rows.length);
    expect(controls.every((id) => id?.includes('grouped-tools'))).toBe(true);
    const heading = container.querySelector('h3');
    expect(container.querySelector('section')?.getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(heading?.textContent).toContain('2 steps');
    expect(heading?.textContent).toContain('1 failed');
    expect(container.textContent).toContain('Network unavailable');
  });

  test('while a call has no answer, the group’s line is that call in the present tense, and the count returns when it is answered', () => {
    const describeToolCall = (pair: ToolCallPair): ToolCallPresentation =>
      pair.result === undefined
        ? { verb: 'Using', tense: 'present', detail: `${pair.call.name}…` }
        : { verb: 'Used', tense: 'past', detail: pair.call.name };
    const running: ToolCallPair = { call: { id: 'c1', name: 'Lookup order', arguments: {} } };
    const view = render(ToolCallTimeline, {
      props: { pairs: [running], messageId: 'running', describeToolCall },
    });
    const runningHeading = view.container
      .querySelector('h3')
      ?.textContent?.replace(/\s+/g, ' ')
      .trim();
    expect(runningHeading).toContain('Using Lookup order…');
    expect(runningHeading).toContain('Step 1 of 1');
    cleanup();

    const answered = render(ToolCallTimeline, {
      props: {
        pairs: [{ ...running, result: { callId: 'c1', outcome: 'success', content: 'ok' } }],
        messageId: 'answered',
        describeToolCall,
      },
    });
    expect(answered.container.querySelector('h3')?.textContent).toContain('1 step');
  });

  describe('counted strings agree with the count', () => {
    const pair: ToolCallPair = {
      call: { id: 'only', name: 'lookup', arguments: {} },
      result: { callId: 'only', outcome: 'success', content: 'ok' },
    };
    const second: ToolCallPair = {
      call: { id: 'other', name: 'fetch', arguments: {} },
      result: { callId: 'other', outcome: 'success', content: 'ok' },
    };
    const describeToolCall = (): ToolCallPresentation => ({
      verb: 'Checking',
      tense: 'present',
      detail: 'records',
      kind: 'search',
    });

    test('says "1 step" for one pair and "2 steps" for two', () => {
      const one = render(ToolCallTimeline, {
        props: { pairs: [pair], messageId: 'count-one', describeToolCall },
      });
      expect(one.container.querySelector('h3')?.textContent).toContain('1 step');
      expect(one.container.querySelector('h3')?.textContent).not.toContain('1 steps');
      cleanup();

      const two = render(ToolCallTimeline, {
        props: { pairs: [pair, second], messageId: 'count-two', describeToolCall },
      });
      expect(two.container.querySelector('h3')?.textContent).toContain('2 steps');
    });

    test('names the list "1 consecutive tool call" for one pair', () => {
      const one = render(ToolCallTimeline, {
        props: { pairs: [pair], messageId: 'label-one', describeToolCall },
      });
      const list = one.container.querySelector('ol.chat-tool-call-list');
      expect(list?.getAttribute('aria-label')).toBe('1 consecutive tool call');
      cleanup();

      const two = render(ToolCallTimeline, {
        props: { pairs: [pair, second], messageId: 'label-two', describeToolCall },
      });
      expect(
        two.container.querySelector('ol.chat-tool-call-list')?.getAttribute('aria-label'),
      ).toBe('2 consecutive tool calls');
    });
  });

  test('namespaces grouped disclosure ids across separate timelines', async () => {
    const pair: ToolCallPair = { call: { id: 'reused', name: 'lookup', arguments: {} } };
    const describeToolCall = (): ToolCallPresentation => ({
      verb: 'Checking',
      tense: 'present',
      detail: 'records',
      kind: 'search',
    });
    const first = render(ToolCallTimeline, {
      props: { pairs: [pair], messageId: 'timeline-one', describeToolCall },
    });
    const second = render(ToolCallTimeline, {
      props: { pairs: [pair], messageId: 'timeline-two', describeToolCall },
    });
    await openCall(first.container);
    await openCall(second.container);
    const firstControls = callRows(first.container)[0]!.getAttribute('aria-controls');
    const secondControls = callRows(second.container)[0]!.getAttribute('aria-controls');
    expect(firstControls).toBe('timeline-one-0-reused-details');
    expect(secondControls).toBe('timeline-two-0-reused-details');
    expect(firstControls).not.toBe(secondControls);
    expect(
      firstControls ? first.container.ownerDocument.getElementById(firstControls) : null,
    ).not.toBeNull();
    expect(
      secondControls ? second.container.ownerDocument.getElementById(secondControls) : null,
    ).not.toBeNull();
  });

  test('an action-required result with null content shows its Input and no Output (C#6)', async () => {
    const { container } = render(ToolCallTimeline, {
      props: {
        pairs: [
          {
            call: { id: 'approval', name: 'request-approval', arguments: {} },
            result: { callId: 'approval', outcome: 'action_required', content: null },
          },
        ],
      },
    });

    await openCall(container);
    const details = container.querySelector('.chat-tool-call-details')?.textContent ?? '';
    expect(details).toContain('Input');
    expect(details).not.toContain('Output');
    expect(details).not.toContain('null');
  });

  test('tool-call card is collapsed by default (payload bodies hidden)', () => {
    const message = toolCallMessage();
    const { container } = render(ChatMessage, {
      props: {
        message,
        toolCallPairs: [
          {
            call: message.toolCall!,
            result: { callId: 'call-1', outcome: 'success', content: { ok: true } },
          },
        ],
      },
    });
    expect(container.querySelector('.chat-tool-call-timeline')).not.toBeNull();
    expect(container.querySelector<HTMLElement>('.chat-tool-call-list')?.hidden).toBe(true);
    expect(container.querySelector('.chat-tool-call-details .cinder-code-block')).toBeNull();
    expect(groupToggle(container).getAttribute('aria-expanded')).toBe('false');
  });

  test('tool-call timeline IDs include the ChatMessage occurrence prefix', () => {
    const message = toolCallMessage();
    const toolCallPairs: ToolCallPair[] = [
      {
        call: message.toolCall!,
        result: { callId: 'call-1', outcome: 'success', content: { ok: true } },
      },
    ];

    render(ChatMessage, {
      props: {
        message,
        idPrefix: 'sub-session-a-tc-1',
        toolCallPairs,
      },
    });
    render(ChatMessage, {
      props: {
        message,
        idPrefix: 'sub-session-b-tc-1',
        toolCallPairs,
      },
    });
    render(ChatMessage, {
      props: {
        message: { ...message, id: 'foo-message' },
        toolCallPairs,
      },
    });
    render(ChatMessage, {
      props: {
        message: { ...message, id: 'foo-message' },
        idPrefix: 'foo',
        toolCallPairs,
      },
    });

    const timelines = Array.from(
      document.body.querySelectorAll<HTMLElement>('.chat-message .chat-tool-call-timeline'),
    );
    const timelineIds = timelines.map((timeline) => timeline.id);
    const headingIds = timelines.map((timeline) => timeline.getAttribute('aria-labelledby') ?? '');

    expect(timelineIds).toEqual([
      'message-sub-session-a-tc-1-message-tool-call-call-1',
      'message-sub-session-b-tc-1-message-tool-call-call-1',
      'message-message-foo-message-tool-call-call-1',
      'message-foo-message-tool-call-call-1',
    ]);
    expect(new Set(timelineIds).size).toBe(timelineIds.length);
    expect(new Set(headingIds).size).toBe(headingIds.length);
  });

  test('tool-call disclosure is decoupled from markdown truncation (long text stays full)', () => {
    const longText = 'x'.repeat(2000);
    const message: Message = {
      id: 'assistant-1',
      role: 'assistant',
      content: longText,
      position: 0,
      createdAt: '2026-06-02T00:00:00.000Z',
      metadata: {},
      hidden: false,
    };
    const { container } = render(ChatMessage, { props: { message } });
    expect(container.textContent).toContain(longText);
    const control = container.querySelector('.chat-message-expand');
    expect(control?.textContent?.trim()).toBe('Show less');
  });

  test('a standalone ChatMessage (no ontoolcalltoggle) can still expand its tool-call details', async () => {
    const message = toolCallMessage();
    const { container } = render(ChatMessage, {
      props: {
        message,
        toolCallPairs: [{ call: message.toolCall! }],
      },
    });
    const button = groupToggle(container);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await clickAndFlush(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector<HTMLElement>('.chat-tool-call-list')?.hidden).toBe(false);
  });

  test('toggling a tool-call detail fires onExpandedChange, matching the pre-split contract', async () => {
    const message = toolCallMessage();
    const changes: boolean[] = [];
    const { container } = render(ChatMessage, {
      props: {
        message,
        toolCallPairs: [{ call: message.toolCall! }],
        onExpandedChange: (expanded: boolean) => changes.push(expanded),
      },
    });
    await clickAndFlush(groupToggle(container));
    expect(changes).toEqual([true]);
  });

  test('status announcer keeps the transferred cinder-sr-only clipping contract', () => {
    const removeStyles = injectStyles(cinderSrOnlyCss);
    try {
      const { container } = render(ToolCallTimeline, {
        props: { pairs: [{ call: { id: 'note-1', name: 'remember_note', arguments: {} } }] },
      });
      const announcer = container.querySelector('[aria-live="polite"]');
      expect(announcer).not.toBeNull();
      expect(announcer?.textContent).toContain('remember_note');
      expect(announcer?.classList.contains('cinder-sr-only')).toBe(true);
      expect(announcer?.classList.contains('sr-only')).toBe(false);

      const computed = getComputedStyle(announcer as Element);
      expect(computed.display).not.toBe('none');
      expect(computed.visibility).not.toBe('hidden');
      expect(computed.position).toBe('absolute');
      expect(computed.width).toBe('1px');
      expect(computed.height).toBe('1px');
      expect(computed.overflow).toBe('hidden');
      expect(computed.clip).toBe('rect(0, 0, 0, 0)');
      expect(computed.whiteSpace).toBe('nowrap');
    } finally {
      removeStyles();
    }
  });

  describe('quiet consecutive calls', () => {
    const lookups: ToolCallPair[] = [
      {
        call: { id: 'lookup-1', name: 'lookup-order', arguments: { orderId: '4471' } },
        result: { callId: 'lookup-1', outcome: 'success', content: '$42.10, delivered Monday' },
      },
      {
        call: { id: 'lookup-2', name: 'lookup-order', arguments: { orderId: '4402' } },
        result: { callId: 'lookup-2', outcome: 'success', content: '$18.00, refunded Oct 12' },
      },
    ];

    test('collapse into one summary line that expands to one line per call', async () => {
      const { container } = render(ToolCallTimeline, {
        props: {
          pairs: lookups,
          messageId: 'quiet',
          durations: new Map([
            ['lookup-1', 400],
            ['lookup-2', 300],
          ]),
        },
      });
      const toggle = groupToggle(container);
      const list = container.querySelector<HTMLElement>('.chat-tool-call-list')!;

      // The header is the step count, the tools and the total time, one field each and no
      // separator character between them.
      expect(toggle.textContent?.replace(/\s+/g, ' ').trim()).toBe('2 steps lookup-order ×2 700ms');
      expect(toggle.textContent).not.toContain(String.fromCodePoint(0xb7));
      expect(
        Array.from(toggle.querySelectorAll('.chat-tool-call-summary > *'), (field) =>
          field.textContent?.trim(),
        ),
      ).toEqual(['2 steps', 'lookup-order ×2', '700ms']);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(list.hidden).toBe(true);

      await clickAndFlush(toggle);

      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(list.hidden).toBe(false);
      const rows = callRows(container);
      expect(rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
        'lookup-order 4471 → $42.10, delivered Monday 400ms',
        'lookup-order 4402 → $18.00, refunded Oct 12 300ms',
      ]);

      await clickAndFlush(rows[1]!);
      const details = container.querySelectorAll<HTMLElement>('.chat-tool-call-details');
      expect(details[0]!.hidden).toBe(true);
      expect(details[1]!.hidden).toBe(false);
      expect(details[1]!.textContent).toContain('"orderId": "4402"');

      await clickAndFlush(toggle);
      expect(list.hidden).toBe(true);
    });

    test('a denied call reads Denied, not failed', () => {
      const pairs: ToolCallPair[] = [
        lookups[0]!,
        {
          call: { id: 'refund-1', name: 'issue-refund', arguments: { orderId: '4471' } },
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
        },
      ];
      const { container } = render(ToolCallTimeline, {
        props: { pairs, approvalStates: new Map([['refund-1', 'denied' as const]]) },
      });
      const summary = groupToggle(container).textContent ?? '';

      expect(summary).toContain('1 denied');
      expect(summary).not.toContain('failed');
      expect(container.querySelector('.chat-tool-call-status')?.textContent).toBe('Denied');
      expect(
        container.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent,
      ).toContain('issue-refund: Denied');
    });
  });

  describe('an approval with a deadline (COR-2280)', () => {
    const NOW = new Date('2026-11-02T16:40:00.000Z');

    /** A call that waits on an approval which expires `offset` milliseconds after `NOW`. */
    function waitingPair(id: string, offset: number | undefined): ToolCallPair {
      return {
        call: { id, name: 'issue-refund', arguments: { orderId: 4471 } },
        result: {
          callId: id,
          outcome: 'action_required',
          content: null,
          action: {
            type: 'approval',
            risk: 'high',
            operation: { kind: 'other' },
            policyVersion: 'policy',
            idempotencyKey: `key-${id}`,
            ...(offset === undefined
              ? {}
              : { expiresAt: new Date(NOW.getTime() + offset).toISOString() }),
          },
        },
      };
    }

    function summaryOf(container: HTMLElement): string {
      return groupToggle(container).textContent ?? '';
    }

    afterEach(() => {
      if (jest.isFakeTimers()) jest.useRealTimers();
    });

    test('waits before its deadline and reads Expired at it, without a host update', async () => {
      jest.useFakeTimers({ now: NOW });
      const { container } = render(ToolCallTimeline, {
        props: { pairs: [waitingPair('refund-1', 1_000)] },
      });
      await tick();
      expect(summaryOf(container)).toContain('1 waiting for approval');

      jest.advanceTimersByTime(999);
      await tick();
      expect(summaryOf(container)).toContain('1 waiting for approval');

      jest.advanceTimersByTime(1);
      await tick();
      expect(summaryOf(container)).not.toContain('waiting for approval');
      expect(summaryOf(container)).toContain('1 expired');
      await openCall(container);
      expect(container.querySelector('.chat-tool-call-status')?.textContent).toBe('Expired');
      expect(
        container
          .querySelector('.chat-tool-call-item')
          ?.getAttribute('data-cinder-tool-call-status'),
      ).toBe('expired');
    });

    test('reads an approval that expired before it was shown the same way', async () => {
      jest.useFakeTimers({ now: NOW });
      const { container } = render(ToolCallTimeline, {
        props: { pairs: [waitingPair('refund-1', -60_000)] },
      });
      await tick();

      expect(summaryOf(container)).not.toContain('waiting for approval');
      expect(summaryOf(container)).toContain('1 expired');
    });

    test('shows denied approvals as a summary without duplicating their receipt details', async () => {
      const { container } = render(ToolCallTimeline, {
        props: {
          pairs: [waitingPair('refund-1', 60_000)],
          approvalStates: new Map([['refund-1', 'denied' as const]]),
        },
      });
      await tick();
      const toggle = container.querySelector<HTMLButtonElement>('.chat-tool-call-toggle')!;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      toggle.click();
      await tick();
      expect(container.textContent).toContain('Denied');
      expect(container.querySelector('.chat-tool-call-details')).toBeNull();
    });

    test('lets a state the host settled win over the deadline', async () => {
      jest.useFakeTimers({ now: NOW });
      const settled: ToolCallPair = {
        call: { id: 'refund-2', name: 'issue-refund', arguments: {} },
        result: { callId: 'refund-2', outcome: 'success', content: { refunded: 4200 } },
      };
      const { container } = render(ToolCallTimeline, {
        props: {
          pairs: [waitingPair('refund-1', -60_000), settled],
          approvalStates: new Map([['refund-1', 'denied' as const]]),
        },
      });
      await tick();

      expect(summaryOf(container)).toContain('1 denied');
      expect(summaryOf(container)).not.toContain('expired');
      expect(summaryOf(container)).not.toContain('waiting for approval');
    });

    test('says approved, resuming once the person approved, not that it still waits (C#2)', async () => {
      const { container } = render(ToolCallTimeline, {
        props: {
          pairs: [waitingPair('refund-1', 60_000)],
          approvalStates: new Map([['refund-1', 'approved' as const]]),
        },
      });
      await tick();

      expect(summaryOf(container)).toContain('1 approved, resuming');
      expect(summaryOf(container)).not.toContain('waiting');
    });

    test('separates the header count and status facts without punctuation (C#15)', async () => {
      const failed: ToolCallPair = {
        call: { id: 'refund-2', name: 'issue-refund', arguments: {} },
        result: { callId: 'refund-2', outcome: 'error', content: null },
      };
      const { container } = render(ToolCallTimeline, {
        props: {
          pairs: [waitingPair('refund-1', 60_000), failed],
          approvalStates: new Map([['refund-1', 'denied' as const]]),
        },
      });
      await tick();

      const phrases = [
        ...container.querySelectorAll('.chat-tool-call-summary-count, [data-problem]'),
      ].map((element) => element.textContent);
      expect(phrases).toEqual(['0 of 2 steps', '1 failed', '1 denied']);
    });

    test('counts only the calls still waiting in a group with an expired one', async () => {
      jest.useFakeTimers({ now: NOW });
      const { container } = render(ToolCallTimeline, {
        props: {
          pairs: [
            waitingPair('refund-1', -1_000),
            waitingPair('refund-2', 60_000),
            waitingPair('refund-3', undefined),
          ],
        },
      });
      await tick();

      expect(summaryOf(container)).toContain('1 expired');
      expect(summaryOf(container)).toContain('2 waiting for approval');
    });

    test('moves its wake to a changed deadline', async () => {
      jest.useFakeTimers({ now: NOW });
      const view = render(ToolCallTimeline, {
        props: { pairs: [waitingPair('refund-1', 1_000)] },
      });
      await tick();
      await view.rerender({ pairs: [waitingPair('refund-1', 5_000)] });
      await tick();

      jest.advanceTimersByTime(1_000);
      await tick();
      expect(summaryOf(view.container)).toContain('1 waiting for approval');

      jest.advanceTimersByTime(4_000);
      await tick();
      expect(summaryOf(view.container)).toContain('1 expired');
    });

    test('leaves no timer behind once it is unmounted', async () => {
      const timers = trackTimers();
      try {
        const deadline = Date.now() + 3_600_000;
        const pair = waitingPair('refund-1', deadline - NOW.getTime());
        const view = render(ToolCallTimeline, { props: { pairs: [pair] } });
        await tick();
        expect(timers.active().size).toBeGreaterThan(0);

        view.unmount();
        expectNoLeakedTimers(timers.active());
      } finally {
        timers.release();
      }
    });
  });

  describe('steps in one bordered group', () => {
    const describeToolCall = (pair: ToolCallPair): ToolCallPresentation =>
      pair.result === undefined
        ? { verb: 'Comparing', tense: 'present', detail: 'recent orders…', kind: 'search' }
        : { verb: 'Compared', tense: 'past', detail: 'recent orders…', kind: 'search' };

    function lookupPairs(count: number): ToolCallPair[] {
      return Array.from({ length: count }, (_, index): ToolCallPair => ({
        call: {
          id: `lookup-${index}`,
          name: 'lookup_order',
          arguments: { orderId: `${4400 + index}` },
        },
        result: { callId: `lookup-${index}`, outcome: 'success', content: `order ${4400 + index}` },
      }));
    }

    test('each row leads with a status icon, then the sentence title, the tool and the time', async () => {
      const pairs: ToolCallPair[] = [
        {
          call: { id: 'done', name: 'lookup_order', arguments: {} },
          result: { callId: 'done', outcome: 'success', content: 'ok' },
        },
        { call: { id: 'open', name: 'issue_refund', arguments: {} } },
      ];
      const { container } = render(ToolCallTimeline, {
        props: {
          pairs,
          messageId: 'anatomy',
          describeToolCall,
          activityActive: false,
          durations: new Map([['done', 400]]),
        },
      });
      await openCall(container);
      const rows = callRows(container);
      expect(rows).toHaveLength(2);
      const done = rows[0]!;
      expect(done.firstElementChild?.classList.contains('chat-tool-call-status-icon')).toBe(true);
      expect(done.firstElementChild?.getAttribute('data-status')).toBe('succeeded');
      // Svelte appends its scoping class after the authored one, so the first class names a field.
      expect(Array.from(done.children, (child) => child.classList[0])).toEqual([
        'chat-tool-call-status-icon',
        'chat-tool-call-label',
        'chat-tool-call-name',
        'chat-tool-call-result',
        'chat-tool-call-duration',
      ]);
      expect(done.querySelector('.chat-tool-call-label')?.textContent).toBe(
        'Compared recent orders…',
      );
      expect(done.querySelector('.chat-tool-call-name')?.textContent).toBe('lookup_order');
      expect(done.querySelector('.chat-tool-call-duration')?.textContent).toBe('400ms');
      // The pending call has no answer, so the host words it in the present tense.
      expect(rows[1]!.querySelector('.chat-tool-call-label')?.textContent).toBe(
        'Comparing recent orders…',
      );
      expect(rows[1]!.firstElementChild?.getAttribute('data-status')).toBe('pending');
    });

    test('the status icon of the call that is running pulses only while the stream is active', () => {
      const running: ToolCallPair = { call: { id: 'open', name: 'lookup_order', arguments: {} } };
      const active = render(ToolCallTimeline, {
        props: { pairs: [running], messageId: 'pulse-on', describeToolCall, activityActive: true },
      });
      expect(
        active.container
          .querySelector('.chat-tool-call-row .chat-tool-call-status-icon')
          ?.hasAttribute('data-cinder-tool-activity-active'),
      ).toBe(true);
      cleanup();

      const idle = render(ToolCallTimeline, {
        props: {
          pairs: [running],
          messageId: 'pulse-off',
          describeToolCall,
          activityActive: false,
        },
      });
      expect(
        idle.container
          .querySelector('.chat-tool-call-row .chat-tool-call-status-icon')
          ?.hasAttribute('data-cinder-tool-activity-active'),
      ).toBe(false);
    });

    test('on a touch screen the summary line and each step row are full touch targets (C#3)', () => {
      const source = readFileSync(join(import.meta.dir, 'tool-call-timeline.svelte'), 'utf8');
      expect(source).toMatch(
        /@media \(any-pointer: coarse\) \{\s*\.chat-tool-call-toggle,\s*\.chat-tool-call-row\s*\{\s*min-block-size: var\(--cinder-touch-target-min\);/,
      );
      // A failed step's Retry and Copy error are Cinder Buttons: compact paint, hit-area extension.
      expect(source).not.toMatch(
        /@media \(any-pointer: coarse\) \{[^}]*chat-tool-call-failure-action/,
      );
    });

    test('the group is bordered and its header carries the count, the tools and the time', () => {
      const source = readFileSync(join(import.meta.dir, 'tool-call-timeline.svelte'), 'utf8');
      expect(source).toMatch(
        /\.chat-tool-call-timeline\s*\{[^}]*border:\s*1px solid var\(--cinder-border-muted\)/s,
      );
      expect(source).not.toContain(String.fromCodePoint(0xb7));
    });

    test('a narrow header truncates long tool names and keeps its count and duration readable', () => {
      const source = readFileSync(join(import.meta.dir, 'tool-call-timeline.svelte'), 'utf8');
      expect(source).toMatch(
        /\.chat-tool-call-summary-tools\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
      );
      expect(source).toMatch(
        /\.chat-tool-call-summary-count,\s*\.chat-tool-call-summary-description,\s*\.chat-tool-call-summary-segment,\s*\.chat-tool-call-summary-duration\s*\{\s*white-space:\s*nowrap;/,
      );
      // The tool names are cut with an ellipsis, which needs one line: they never wrap.
      expect(source).toMatch(
        /\.chat-tool-call-summary-tools\s*\{[^}]*text-overflow:\s*ellipsis;\s*white-space:\s*nowrap/s,
      );
      // The running call's sentence is not held to one line, so a long one wraps inside the group.
      expect(source).toMatch(/\.chat-tool-call-running\s*\{[^}]*overflow-wrap:\s*anywhere/s);
      // A row wraps between its parts in a narrow chat, so a tool's name is never clipped there.
      expect(source).toMatch(
        /@container \(max-width: 21\.99rem\)\s*\{[^@]*\.chat-tool-call-row\s*\{\s*display:\s*grid;/s,
      );
      // A long result line takes only what is left, so it never squeezes the title.
      expect(source).toMatch(/\.chat-tool-call-result\s*\{\s*flex:\s*1 1 0;/);
      expect(source).toMatch(/\.chat-tool-call-summary\s*\{[^}]*flex-wrap:\s*wrap/s);
      // The row's status words never wrap either.
      expect(source).toMatch(
        /\.chat-tool-call-status,\s*\.chat-tool-call-duration\s*\{[^}]*white-space:\s*nowrap/s,
      );
    });

    test('twenty identical consecutive calls fold into one row with the tool count and the total time', async () => {
      const pairs = lookupPairs(20);
      const { container } = render(ToolCallTimeline, {
        props: {
          pairs,
          messageId: 'twenty',
          describeToolCall,
          durations: new Map(pairs.map((pair) => [pair.call.id, 305])),
        },
      });
      const toggle = groupToggle(container);
      await clickAndFlush(toggle);
      const rows = callRows(container);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        'Compared recent orders… lookup_order ×20 6s',
      );
      expect(
        container
          .querySelector('.chat-tool-call-item')
          ?.getAttribute('data-cinder-tool-call-repeat'),
      ).toBe('20');
      // The group still counts every step, and its navigation row still counts every call.
      expect(toggle.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        '20 steps Compared recent orders… lookup_order ×20 6s',
      );
      expect(
        container
          .querySelector('.chat-tool-call-timeline')
          ?.getAttribute('data-cinder-tool-call-count'),
      ).toBe('20');

      // Nothing of the twenty calls is drawn until the row is opened.
      expect(rows[0]!.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelectorAll('.chat-tool-call-repeated-call')).toHaveLength(0);
    });

    test('opening a folded row shows each call with its own input and output', async () => {
      const { container } = render(ToolCallTimeline, {
        props: { pairs: lookupPairs(3), messageId: 'three', describeToolCall },
      });
      await clickAndFlush(groupToggle(container));
      const row = callRows(container)[0]!;
      expect(callRows(container)).toHaveLength(1);
      await clickAndFlush(row);
      expect(row.getAttribute('aria-expanded')).toBe('true');
      const calls = container.querySelectorAll('.chat-tool-call-repeated-call');
      expect(calls).toHaveLength(3);
      expect(calls[0]!.textContent).toContain('1 of 3');
      expect(calls[0]!.textContent).toContain('4400');
      expect(calls[2]!.textContent).toContain('3 of 3');
      expect(calls[2]!.textContent).toContain('order 4402');
      await clickAndFlush(row);
      expect(container.querySelectorAll('.chat-tool-call-repeated-call')).toHaveLength(0);
    });

    test('two identical calls are not folded, and a different tool breaks a run', () => {
      const two = render(ToolCallTimeline, {
        props: { pairs: lookupPairs(2), messageId: 'two', describeToolCall },
      });
      expect(callRows(two.container)).toHaveLength(2);
      cleanup();

      const pairs = lookupPairs(5);
      const interrupted: ToolCallPair[] = [
        ...pairs.slice(0, 3),
        {
          call: { id: 'other', name: 'issue_refund', arguments: {} },
          result: { callId: 'other', outcome: 'success', content: 'ok' },
        },
        ...pairs.slice(3),
      ];
      const broken = render(ToolCallTimeline, {
        props: { pairs: interrupted, messageId: 'broken' },
      });
      // Three before the other tool fold; the two after it are too few to.
      expect(callRows(broken.container)).toHaveLength(4);
      expect(
        callRows(broken.container).map(
          (row) => row.querySelector('.chat-tool-call-name')?.textContent,
        ),
      ).toEqual(['lookup_order ×3', 'issue_refund', 'lookup_order', 'lookup_order']);
    });

    test('a failed call keeps its own row even among identical calls', () => {
      const pairs = lookupPairs(6);
      pairs[3] = {
        call: pairs[3]!.call,
        result: {
          callId: pairs[3]!.call.id,
          outcome: 'error',
          content: null,
          error: {
            code: 'offline',
            category: 'internal',
            retryable: true,
            message: 'Network unavailable',
          },
        },
      };
      const { container } = render(ToolCallTimeline, {
        props: { pairs, messageId: 'failed-among' },
      });
      const rows = callRows(container);
      expect(rows.map((row) => row.querySelector('.chat-tool-call-name')?.textContent)).toEqual([
        'lookup_order ×3',
        'lookup_order',
        'lookup_order',
        'lookup_order',
      ]);
      expect(container.querySelectorAll('[data-cinder-tool-call-status="failed"]')).toHaveLength(1);
    });
  });

  test('falls through to the text body when no pair is supplied (regression guard)', () => {
    const message = toolCallMessage();
    const { container } = render(ChatMessage, {
      props: { message, toolCallPairs: [] },
    });
    expect(container.querySelector('.chat-tool-call-timeline')).toBeNull();
    expect(container.querySelector('.message-content')).not.toBeNull();
    expect(container.textContent).toContain('raw tool-call text body');
  });
});
