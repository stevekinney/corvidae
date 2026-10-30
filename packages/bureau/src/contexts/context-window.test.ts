/**
 * COR-1937 — the split `buildContextWindow` reports: five categories that always sum to
 * `usedEstimated`, the instructions counted once, the provider's own count labeled as such.
 */
import { createModelCatalog, MEMORY_EVIDENCE_METADATA_KEY } from '@lostgradient/operative';
import { Conversation } from 'conversationalist';
import { describe, expect, it } from 'bun:test';

import {
  buildContextWindow,
  type ContextWindowInputs,
  estimateText,
  reportedInputTokens,
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
