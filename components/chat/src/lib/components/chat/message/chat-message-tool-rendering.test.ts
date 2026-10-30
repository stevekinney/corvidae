/**
 * Regression guards for how `ChatMessage` renders tool-call messages through
 * the parts spine. The contract that matters: a tool-call message renders a
 * `ToolCallTimeline` card when a resolved pair is supplied (mirroring the
 * original `isToolCall && toolPair` guard). A standalone `<ChatMessage>` given
 * an empty `toolCallPairs` must fall through to the plain text body — NOT a
 * pending card — exactly as before the parts refactor.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRawSnippet, tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
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
          { call: { id: 'repeated', name: 'first', arguments: {} } },
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
    expect(heading?.textContent).toContain('Used 2 tools');
    expect(heading?.textContent).toContain('1 failed');
    expect(container.textContent).toContain('Network unavailable');
  });

  describe('counted strings agree with the count', () => {
    const pair: ToolCallPair = { call: { id: 'only', name: 'lookup', arguments: {} } };
    const second: ToolCallPair = { call: { id: 'other', name: 'fetch', arguments: {} } };
    const describeToolCall = (): ToolCallPresentation => ({
      verb: 'Checking',
      tense: 'present',
      detail: 'records',
      kind: 'search',
    });

    test('says "1 tool" for one pair and "2 tools" for two', () => {
      const one = render(ToolCallTimeline, {
        props: { pairs: [pair], messageId: 'count-one', describeToolCall },
      });
      expect(one.container.querySelector('h3')?.textContent).toContain('Used 1 tool');
      expect(one.container.querySelector('h3')?.textContent).not.toContain('1 tools');
      cleanup();

      const two = render(ToolCallTimeline, {
        props: { pairs: [pair, second], messageId: 'count-two', describeToolCall },
      });
      expect(two.container.querySelector('h3')?.textContent).toContain('Used 2 tools');
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

  test('grouped action-required results render null payloads explicitly', async () => {
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
    expect(container.querySelector('.chat-tool-call-details')?.textContent).toContain('null');
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

      expect(toggle.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        'Used 2 tools · lookup-order ×2 · 0.7s',
      );
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(list.hidden).toBe(true);

      await clickAndFlush(toggle);

      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(list.hidden).toBe(false);
      const rows = callRows(container);
      expect(rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
        'lookup-order 4471 → $42.10, delivered Monday 0.4s',
        'lookup-order 4402 → $18.00, refunded Oct 12 0.3s',
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
