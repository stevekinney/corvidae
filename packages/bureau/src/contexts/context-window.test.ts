/**
 * COR-1937 — the split `buildContextWindow` reports: five categories that always sum to
 * `usedEstimated`, the instructions counted once, the provider's own count labeled as such.
 */
import { createModelCatalog, MEMORY_EVIDENCE_METADATA_KEY } from '@lostgradient/operative';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { compactConversation, Conversation, resolvedSourceKey } from 'conversationalist';
import { describe, expect, it } from 'bun:test';

import { AssetNotFoundError } from '../assets/errors.ts';
import {
  buildContextWindow,
  type ContextWindowInputs,
  estimateText,
  type ManagedAssetFacts,
  reportedInputTokens,
  sizeManagedAssets,
} from './context-window.ts';

const catalog = createModelCatalog({ now: () => '2026-10-30T00:00:00.000Z' }).descriptors;
const anthropic = catalog.find((row) => row.provider === 'anthropic');
if (anthropic === undefined) throw new Error('The default catalog has no Anthropic row.');

const lookup = {
  name: 'lookup',
  description: 'Looks things up',
  input: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
} as const;

/** Base64 for three KiB, so the media estimator reads exact bytes back. */
const base64OfThreeKibibytes = 'A'.repeat(4096);

function inputs(overrides: Partial<ContextWindowInputs> = {}): ContextWindowInputs {
  return {
    history: new Conversation().current,
    tools: [],
    model: anthropic,
    catalog,
    reported: undefined,
    ...overrides,
  };
}

function tokensOf(report: ReturnType<typeof buildContextWindow>, name: string): number | undefined {
  return report.categories.find((category) => category.name === name)?.tokens;
}

describe('buildContextWindow categories', () => {
  it('lists the five categories once, in order, and sums them to usedEstimated', () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are terse.');
    conversation.appendSystemMessage('Remembered: the user likes tea.', {
      [MEMORY_EVIDENCE_METADATA_KEY]: { recordIds: ['m1'] },
    });
    conversation.appendMessages({ role: 'user', content: 'Hello there, how are you today?' });
    conversation.appendMessages({
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this.' },
        {
          type: 'image',
          source: { kind: 'inline', data: base64OfThreeKibibytes, encoding: 'base64' },
          mimeType: 'image/png',
        },
      ],
    });
    conversation.appendMessages({ role: 'assistant', content: 'Fine, thanks.' });

    const report = buildContextWindow(
      inputs({ history: conversation.current, tools: [lookup], instructions: 'ignored' }),
    );

    expect(report.categories.map((category) => category.name)).toEqual([
      'system',
      'tools',
      'messages',
      'memory',
      'attachments',
    ]);
    expect(report.usedEstimated).toBe(
      report.categories.reduce((total, category) => total + category.tokens, 0),
    );
    expect(tokensOf(report, 'system')).toBe(estimateText('You are terse.'));
    expect(tokensOf(report, 'memory')).toBe(estimateText('Remembered: the user likes tea.'));
    expect(tokensOf(report, 'tools')).toBe(
      estimateText(
        JSON.stringify({
          name: lookup.name,
          description: lookup.description,
          input_schema: lookup.input,
        }),
      ),
    );
    expect(tokensOf(report, 'messages')).toBe(
      estimateText('Hello there, how are you today?') +
        estimateText('Look at this.') +
        estimateText('Fine, thanks.'),
    );
    // Three KiB of image at the catalog's two tokens per KiB.
    expect(tokensOf(report, 'attachments')).toBe(6);
  });

  it('estimates a context with no rows from the agent definition, instructions counted once', () => {
    const fromDefinition = buildContextWindow(
      inputs({ instructions: 'You are terse.', tools: [lookup] }),
    );
    expect(tokensOf(fromDefinition, 'system')).toBe(estimateText('You are terse.'));
    expect(tokensOf(fromDefinition, 'messages')).toBe(0);
    expect(tokensOf(fromDefinition, 'memory')).toBe(0);
    expect(tokensOf(fromDefinition, 'attachments')).toBe(0);
    expect(fromDefinition.usedEstimated).toBeGreaterThan(0);

    // Once the history holds the instructions as a system row, the definition's are not added.
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are terse.');
    const afterRun = buildContextWindow(
      inputs({ history: conversation.current, instructions: 'You are terse.', tools: [lookup] }),
    );
    expect(tokensOf(afterRun, 'system')).toBe(tokensOf(fromDefinition, 'system'));
  });

  it('counts a withdrawn memory row as memory and a hidden row not at all', () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('[withdrawn]', {
      [MEMORY_EVIDENCE_METADATA_KEY]: { recordIds: [] },
    });
    conversation.appendMessages({ role: 'user', content: 'unseen by the model', hidden: true });

    const report = buildContextWindow(inputs({ history: conversation.current }));

    expect(tokensOf(report, 'memory')).toBe(estimateText('[withdrawn]'));
    expect(tokensOf(report, 'messages')).toBe(0);
  });

  it('counts the call a tool-call row carries', () => {
    const conversation = new Conversation();
    conversation.appendMessages({
      role: 'tool-call',
      content: '',
      toolCall: { id: 'call-1', name: 'lookup', arguments: { q: 'tea' } },
    });

    const report = buildContextWindow(inputs({ history: conversation.current }));

    expect(tokensOf(report, 'messages')).toBe(
      estimateText(JSON.stringify({ name: 'lookup', arguments: { q: 'tea' } })),
    );
  });
});

describe('buildContextWindow limits and reported usage', () => {
  it('takes maxTokens from the model row, and null when the model is not known', () => {
    expect(buildContextWindow(inputs()).maxTokens).toBe(anthropic.contextWindowTokens);
    expect(buildContextWindow(inputs({ model: undefined })).maxTokens).toBeNull();
  });

  it('reports the provider’s input tokens, cache included, and null when there are none', () => {
    expect(buildContextWindow(inputs()).usedReported).toBeNull();
    expect(
      buildContextWindow(
        inputs({ reported: { prompt: 50, cacheReadTokens: 100_000, cacheCreationTokens: 7 } }),
      ).usedReported,
    ).toBe(100_057);
    expect(reportedInputTokens({ prompt: 12 })).toBe(12);
    expect(reportedInputTokens(undefined)).toBeNull();
    // A counter read back from storage that is not a number is ignored, and a missing prompt is none.
    expect(reportedInputTokens({ prompt: 5, cacheReadTokens: '9' as unknown as number })).toBe(5);
    expect(reportedInputTokens({ prompt: Number.NaN })).toBeNull();
  });
});

describe('buildContextWindow tool results, compaction and managed assets', () => {
  it('counts a tool result’s content, which sits beside its parts and not in the row’s content', () => {
    const conversation = new Conversation();
    const payload = 'x'.repeat(40_000);
    const call = (id: string) =>
      conversation.appendMessages({
        role: 'tool-call',
        content: '',
        toolCall: { id, name: 'lookup', arguments: {} },
      });
    const callTokens = estimateText(JSON.stringify({ name: 'lookup', arguments: {} }));
    call('call-1');
    conversation.appendMessages({
      role: 'tool-result',
      content: '',
      toolResult: { callId: 'call-1', outcome: 'success', content: payload },
    });
    call('call-2');
    conversation.appendMessages({
      role: 'tool-result',
      content: '',
      toolResult: { callId: 'call-2', outcome: 'success', content: { rows: [1, 2, 3] } },
    });
    // With parts, `content` is the application value no provider sends: only the parts count.
    call('call-3');
    conversation.appendMessages({
      role: 'tool-result',
      content: '',
      toolResult: {
        callId: 'call-3',
        outcome: 'success',
        content: 'y'.repeat(40_000),
        parts: [{ type: 'text', text: 'short' }],
      },
    });

    const report = buildContextWindow(inputs({ history: conversation.current }));

    expect(tokensOf(report, 'messages')).toBe(
      3 * callTokens +
        estimateText(payload) +
        estimateText(JSON.stringify({ rows: [1, 2, 3] })) +
        estimateText('short'),
    );
    expect(tokensOf(report, 'messages')).toBeGreaterThan(10_000);
  });

  it('counts a compaction summary as conversation, so system stays the instructions', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are terse.');
    for (let turn = 0; turn < 6; turn += 1) {
      conversation.appendMessages({ role: 'user', content: `Question ${turn}?` });
      conversation.appendMessages({ role: 'assistant', content: `Answer ${turn}.` });
    }
    const { conversation: compacted, result } = await compactConversation(
      conversation.current,
      async () => 'The user asked six questions about tea.',
      { preserveRecentCount: 2 },
    );
    expect(result.compacted).toBe(true);
    const summaryRow = Object.values(compacted.messages).find(
      (row) => row.metadata['compactionSummary'] === true,
    );
    expect(summaryRow?.role).toBe('system');

    const report = buildContextWindow(inputs({ history: compacted }));

    expect(tokensOf(report, 'system')).toBe(estimateText('You are terse.'));
    expect(tokensOf(report, 'messages')).toBeGreaterThanOrEqual(
      estimateText('The user asked six questions about tea.'),
    );
  });

  describe('a managed-asset attachment', () => {
    const managedImage = (assetId: string) => ({
      type: 'image' as const,
      source: { kind: 'managed-asset' as const, assetId },
      mimeType: 'image/png',
    });
    const held = (overrides: Partial<ManagedAssetFacts> = {}): ManagedAssetFacts => ({
      state: 'available',
      custody: 'bureau',
      mediaType: 'image/png',
      byteLength: 3 * 1024,
      ...overrides,
    });

    function conversationWith(...assetIds: string[]) {
      const conversation = new Conversation();
      conversation.appendMessages({
        role: 'user',
        content: [{ type: 'text', text: 'Look.' }, ...assetIds.map(managedImage)],
      });
      return conversation;
    }

    it('costs nothing without a resolved source, as its stored form is one no backend accepts', () => {
      const report = buildContextWindow(inputs({ history: conversationWith('asset-1').current }));
      expect(tokensOf(report, 'attachments')).toBe(0);
    });

    it('is sized from the descriptor’s byte length, as the inline bytes of the same size are', async () => {
      const conversation = conversationWith('asset-1');
      const inspected: string[] = [];
      const resolvedSources = await sizeManagedAssets(conversation.current, async (assetId) => {
        inspected.push(assetId);
        return held();
      });

      const report = buildContextWindow(inputs({ history: conversation.current, resolvedSources }));

      // Three KiB at the catalog's two tokens per KiB, as the inline image above.
      expect(tokensOf(report, 'attachments')).toBe(6);
      expect(inspected).toEqual(['asset-1']);
      const [message] = Object.values(conversation.current.messages);
      expect(resolvedSources?.has(resolvedSourceKey(message!.id, 1))).toBe(true);
    });

    it('inspects each asset once and costs one that is gone or not available at nothing', async () => {
      const conversation = conversationWith('asset-1', 'asset-1', 'gone', 'pending');
      const inspected: string[] = [];
      const resolvedSources = await sizeManagedAssets(conversation.current, async (assetId) => {
        inspected.push(assetId);
        if (assetId === 'gone') throw new AssetNotFoundError(assetId);
        return assetId === 'pending' ? held({ state: 'pending' }) : held();
      });

      const report = buildContextWindow(inputs({ history: conversation.current, resolvedSources }));

      expect(inspected).toEqual(['asset-1', 'gone', 'pending']);
      expect(tokensOf(report, 'attachments')).toBe(12);
    });

    it('lets an unexpected failure of the asset store through', async () => {
      const failure = await throwingRejectionOf(
        sizeManagedAssets(conversationWith('asset-1').current, async () => {
          throw new Error('the store is down');
        }),
      );
      expect(failure).toThrow('the store is down');
    });

    it('is undefined for a history with no managed asset', async () => {
      const conversation = new Conversation();
      conversation.appendMessages({ role: 'user', content: 'plain' });
      expect(
        await sizeManagedAssets(conversation.current, async () => {
          throw new Error('not called');
        }),
      ).toBeUndefined();
    });
  });
});
