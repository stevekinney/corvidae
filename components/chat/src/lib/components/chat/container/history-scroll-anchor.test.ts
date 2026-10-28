import { describe, expect, test } from 'bun:test';

import type { VirtualItem } from '../../../_internal/virtual-item.ts';
import type { Message } from '../conversation-model.ts';
import {
  firstMessageViewportOffset,
  pinHistoryAnchorVirtualItem,
} from './history-scroll-anchor.ts';
import type { ChatRenderRow } from './use-chat-message-groups.svelte.ts';

function message(id: string): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    createdAt: '2026-05-04T12:00:00.000Z',
    hidden: false,
    metadata: {},
    position: 1,
  } satisfies Message;
}

const virtualItem: VirtualItem = { key: 'row', index: 3, start: 400, end: 460, size: 60, lane: 0 };

function element(top: number): HTMLElement {
  return { getBoundingClientRect: () => ({ top }) } as HTMLElement;
}

describe('pinning a virtual row to the history anchor', () => {
  test('pins the row of the anchored message below the scroll padding', () => {
    const row: ChatRenderRow = { type: 'message', message: message('anchor') };
    expect(pinHistoryAnchorVirtualItem(row, virtualItem, 'anchor', 24, 1000, 16)).toEqual({
      ...virtualItem,
      start: 1008,
      end: 1068,
    });
  });

  test('pins a run of tool calls by the first message in it', () => {
    const row: ChatRenderRow = {
      type: 'tool-call-group',
      messages: [message('first-call'), message('second-call')],
    };
    expect(pinHistoryAnchorVirtualItem(row, virtualItem, 'first-call', 0, 100, 40)).toEqual({
      ...virtualItem,
      start: 60,
      end: 120,
    });
    expect(pinHistoryAnchorVirtualItem(row, virtualItem, 'second-call', 0, 100, 40)).toBe(
      virtualItem,
    );
  });

  test('never moves above the top of the list', () => {
    const row: ChatRenderRow = { type: 'message', message: message('anchor') };
    expect(pinHistoryAnchorVirtualItem(row, virtualItem, 'anchor', -500, 100, 0).start).toBe(0);
  });

  test('leaves every other row where it is, and every row when there is no anchor offset', () => {
    const anchored: ChatRenderRow = { type: 'message', message: message('anchor') };
    expect(pinHistoryAnchorVirtualItem(anchored, virtualItem, 'anchor', null, 100, 0)).toBe(
      virtualItem,
    );
    expect(pinHistoryAnchorVirtualItem(anchored, virtualItem, 'other', 10, 100, 0)).toBe(
      virtualItem,
    );
    for (const row of [
      { type: 'typing' },
      { type: 'unread-divider', afterMessageId: null },
    ] as const) {
      expect(pinHistoryAnchorVirtualItem(row, virtualItem, 'anchor', 10, 100, 0)).toBe(virtualItem);
    }
  });
});

describe('measuring where the first message sits in the viewport', () => {
  test('prefers the offset of a visible anchor', () => {
    expect(
      firstMessageViewportOffset({ messageId: 'a', viewportOffset: 12 }, 'a', null, () => null),
    ).toBe(12);
  });

  test('measures the rendered message against the viewport', () => {
    expect(
      firstMessageViewportOffset(null, 'a', element(100), (id) =>
        id === 'a' ? element(130) : null,
      ),
    ).toBe(30);
  });

  test('is zero without a message, a viewport, or a rendered element', () => {
    expect(firstMessageViewportOffset(null, null, element(0), () => element(5))).toBe(0);
    expect(firstMessageViewportOffset(null, 'a', null, () => element(5))).toBe(0);
    expect(firstMessageViewportOffset(null, 'a', element(0), () => null)).toBe(0);
  });
});
