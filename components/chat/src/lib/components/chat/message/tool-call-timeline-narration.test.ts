/**
 * A settled turn's narration is drawn inside the opened step group, between the steps it was said
 * between. The group's count and summary stay about steps, and a group given only pairs is what it
 * was.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import type { ToolCallPair } from '../conversation-model.ts';

setupHappyDom();

const { render, cleanup } = await import('@testing-library/svelte');
const { default: ToolCallTimeline } = await import('./tool-call-timeline.svelte');

afterEach(cleanup);

function pair(id: string, name = 'lookup'): ToolCallPair {
  return {
    call: { id, name, arguments: {} },
    result: { callId: id, outcome: 'success', content: 'ok' },
  };
}

function listItems(container: HTMLElement): string[] {
  const list = container.querySelector('.chat-tool-call-list')!;
  return [...list.children].map((item) =>
    item.classList.contains('chat-tool-call-narration')
      ? `narration:${item.textContent?.trim()}`
      : 'step',
  );
}

describe('ToolCallTimeline narration', () => {
  test('a group given only pairs has no narration and the same list as before', async () => {
    const { container } = render(ToolCallTimeline, { props: { pairs: [pair('a'), pair('b')] } });
    await tick();
    expect(container.querySelectorAll('.chat-tool-call-narration')).toHaveLength(0);
    expect(container.querySelector('.chat-tool-call-summary-count')?.textContent).toBe('2 steps');
  });

  test('narration sits between the steps it was said between, and the count is steps only', async () => {
    const { container } = render(ToolCallTimeline, {
      props: {
        pairs: [pair('a', 'read'), pair('b', 'write')],
        narration: [
          { id: 'n1', beforePairIndex: 0, content: 'Reading the ledger' },
          { id: 'n2', beforePairIndex: 1, content: 'Now the invoices' },
        ],
      },
    });
    await tick();
    expect(listItems(container)).toEqual([
      'narration:Reading the ledger',
      'step',
      'narration:Now the invoices',
      'step',
    ]);
    expect(container.querySelector('.chat-tool-call-summary-count')?.textContent).toBe('2 steps');
    expect(
      container
        .querySelector('.chat-tool-call-timeline')
        ?.getAttribute('data-cinder-tool-call-count'),
    ).toBe('2');
    // Each line goes through the markdown renderer a message uses.
    expect(
      container.querySelectorAll('.chat-tool-call-narration .message-content-preview'),
    ).toHaveLength(2);
  });

  test('identical calls do not fold into a repeated row across a narration line', async () => {
    const calls = [pair('a'), pair('b'), pair('c'), pair('d')];
    const folded = render(ToolCallTimeline, { props: { pairs: calls } });
    await tick();
    expect(folded.container.querySelectorAll('[data-cinder-tool-call-repeat]')).toHaveLength(1);
    cleanup();

    const split = render(ToolCallTimeline, {
      props: {
        pairs: calls,
        narration: [{ id: 'n', beforePairIndex: 2, content: 'Halfway' }],
      },
    });
    await tick();
    // Two calls on each side are two single rows, not a run of four.
    expect(split.container.querySelectorAll('[data-cinder-tool-call-repeat]')).toHaveLength(0);
    expect(listItems(split.container)).toEqual([
      'step',
      'step',
      'narration:Halfway',
      'step',
      'step',
    ]);
  });

  test('a narration stays a text line between independently reachable step rows', () => {
    const source = readFileSync(join(import.meta.dir, 'tool-call-timeline.svelte'), 'utf8');
    expect(source).toMatch(
      /\.chat-tool-call-row\s*\{[^}]*min-block-size: var\(--cinder-control-height-xs\);/s,
    );
    expect(source).not.toContain('.chat-tool-call-row::before');
  });

  test('narration after the last step is kept at the end', async () => {
    const { container } = render(ToolCallTimeline, {
      props: {
        pairs: [pair('a')],
        narration: [{ id: 'n', beforePairIndex: 1, content: 'Finally' }],
      },
    });
    await tick();
    expect(listItems(container)).toEqual(['step', 'narration:Finally']);
  });
});
