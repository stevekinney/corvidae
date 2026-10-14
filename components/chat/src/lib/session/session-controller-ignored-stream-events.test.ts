import { describe, expect, test } from 'bun:test';
import { IGNORED_STREAM_EVENT_TYPES } from './session-controller-events.ts';
import {
  abortedFrame,
  createFrameHarness,
  rolesOf,
  type FrameInput,
} from './session-controller-frame-test-support.ts';

type IgnoredType = (typeof IGNORED_STREAM_EVENT_TYPES)[number];

const block = { id: 'b', type: 'text', index: 0, content: 'x', complete: false } as const;

const ignoredFrames: { [K in IgnoredType]: FrameInput & { type: K } } = {
  'stream:block-start': { type: 'stream:block-start', block },
  'stream:block-delta': { type: 'stream:block-delta', block, delta: 'x' },
  'stream:block-complete': { type: 'stream:block-complete', block: { ...block, complete: true } },
  'stream:tool-call-start': { type: 'stream:tool-call-start', toolName: 'lookup', blockId: 'b' },
  'stream:tool-call-delta': {
    type: 'stream:tool-call-delta',
    toolName: 'lookup',
    blockId: 'b',
    partialArguments: '{',
  },
  'stream:tool-call-complete': {
    type: 'stream:tool-call-complete',
    toolName: 'lookup',
    blockId: 'b',
    arguments: {},
  },
  'stream:usage': { type: 'stream:usage', usage: { prompt: 1, completion: 1, total: 2 } },
  'stream:complete': {
    type: 'stream:complete',
    state: { blocks: [], textContent: '', toolCalls: [], complete: true },
  },
  'stream:error': { type: 'stream:error', error: 'boom' },
};

function structure(harness: ReturnType<typeof createFrameHarness>) {
  const { conversation } = harness;
  return conversation.ids.map((id) => ({
    role: conversation.messages[id]?.role,
    content: conversation.messages[id]?.content,
  }));
}

describe('ignored stream events', () => {
  test('the ignored set is exactly the nine non-text stream frames', () => {
    const expected: string[] = [
      'stream:block-start',
      'stream:block-delta',
      'stream:block-complete',
      'stream:tool-call-start',
      'stream:tool-call-delta',
      'stream:tool-call-complete',
      'stream:usage',
      'stream:complete',
      'stream:error',
    ];
    expect([...IGNORED_STREAM_EVENT_TYPES].map(String).sort()).toEqual([...expected].sort());
  });

  for (const type of IGNORED_STREAM_EVENT_TYPES) {
    test(`${type} changes nothing relative to a control run`, async () => {
      const control = createFrameHarness({ turns: [[abortedFrame()]] });
      await control.send();
      const harness = createFrameHarness({ turns: [[ignoredFrames[type], abortedFrame()]] });
      expect(await harness.send()).toBeUndefined();
      expect(structure(harness)).toEqual(structure(control));
      expect(rolesOf(harness.conversation)).toEqual(rolesOf(control.conversation));
      expect(harness.aborted).toEqual(control.aborted);
      expect(harness.aborted).toHaveLength(1);
      expect(harness.toolActivity).toEqual([]);
      expect(harness.elicitations).toEqual([]);
      expect(harness.toolResults).toEqual([]);
      expect(harness.errors).toEqual([]);
    });
  }
});
