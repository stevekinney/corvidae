import { describe, expect, it, mock } from 'bun:test';
import type { ContentSource, MultiModalContent } from 'conversationalist';
import { Conversation } from 'conversationalist';

import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import { createInputGuardrail } from './input-guardrail';
import type {
  DetectionResult,
  DetectorContext,
  GuardrailTriggeredEvent,
  InputDetector,
} from './types';

function createMockDetector(name: string, result: DetectionResult): InputDetector {
  return {
    name,
    detect: async () => result,
  };
}

function createMockStepContext(userMessage = 'Hello') {
  const conversation = new Conversation();
  conversation.appendUserMessage(userMessage);
  return {
    conversation,
    step: 1,
  };
}

const triggeredResult: DetectionResult = {
  triggered: true,
  confidence: 0.9,
  category: 'test-category',
  detail: 'Test detection',
};

const safeResult: DetectionResult = {
  triggered: false,
  confidence: 0,
  category: 'test-category',
};

describe('createInputGuardrail', () => {
  describe('action: block (default)', () => {
    it('returns a GenerateResponse with refusal text when a detector triggers', async () => {
      const detector = createMockDetector('test-detector', triggeredResult);
      const hook = createInputGuardrail({ detectors: [detector] });

      const context = createMockStepContext();
      const result = await hook(context);

      expect(result).toBeDefined();
      expect(result?.content).toContain('blocked');
      expect(result?.toolCalls).toEqual([]);
    });

    it('returns void when no detector triggers', async () => {
      const detector = createMockDetector('test-detector', safeResult);
      const hook = createInputGuardrail({ detectors: [detector] });

      const context = createMockStepContext();
      const result = await hook(context);

      expect(result).toBeUndefined();
    });

    it('calls onTriggered callback when blocking', async () => {
      const onTriggered = mock((_event: GuardrailTriggeredEvent) => {});
      const detector = createMockDetector('test-detector', triggeredResult);
      const hook = createInputGuardrail({
        detectors: [detector],
        onTriggered,
      });

      const context = createMockStepContext('bad input');
      await hook(context);

      expect(onTriggered).toHaveBeenCalledTimes(1);
      const event = onTriggered.mock.calls[0]![0];
      expect(event).toBeDefined();
      expect(event.detector).toBe('test-detector');
      expect(event.action).toBe('block');
    });
  });

  describe('action: warn', () => {
    it('returns void (allows through) when a detector triggers', async () => {
      const detector = createMockDetector('test-detector', triggeredResult);
      const hook = createInputGuardrail({
        detectors: [detector],
        action: 'warn',
      });

      const context = createMockStepContext();
      const result = await hook(context);

      expect(result).toBeUndefined();
    });

    it('calls onTriggered callback when warning', async () => {
      const onTriggered = mock((_event: GuardrailTriggeredEvent) => {});
      const detector = createMockDetector('test-detector', triggeredResult);
      const hook = createInputGuardrail({
        detectors: [detector],
        action: 'warn',
        onTriggered,
      });

      const context = createMockStepContext();
      await hook(context);

      expect(onTriggered).toHaveBeenCalledTimes(1);
      const event = onTriggered.mock.calls[0]![0];
      expect(event.action).toBe('warn');
    });
  });

  describe('action: sanitize', () => {
    it('modifies the last user message when a detector provides a sanitized version', async () => {
      const detector: InputDetector = {
        name: 'sanitizer',
        detect: async () => ({
          triggered: true,
          confidence: 0.8,
          category: 'sanitize-test',
          sanitized: 'cleaned input',
        }),
      };
      const hook = createInputGuardrail({
        detectors: [detector],
        action: 'sanitize',
      });

      const context = createMockStepContext('dirty input');
      const result = await hook(context);

      // Sanitize returns void (continues to generate)
      expect(result).toBeUndefined();

      // The conversation should have the sanitized content appended
      const messages = context.conversation.getMessages();
      const lastUserMessage = [...messages].toReversed().find((m) => m.role === 'user');
      expect(lastUserMessage?.content).toBe('cleaned input');
    });

    it('blocks when no sanitized version is available', async () => {
      const detector = createMockDetector('test-detector', {
        ...triggeredResult,
      });
      const hook = createInputGuardrail({
        detectors: [detector],
        action: 'sanitize',
      });

      const context = createMockStepContext();
      const result = await hook(context);

      // Falls back to block when no sanitized version is available
      expect(result).toBeDefined();
      expect(result?.content).toContain('blocked');
    });
  });

  describe('multiple detectors', () => {
    it('triggers on the first detected violation in sequential mode', async () => {
      const firstCalls: number[] = [];
      const secondCalls: number[] = [];
      const first: InputDetector = {
        name: 'first',
        detect: async () => {
          firstCalls.push(1);
          return triggeredResult;
        },
      };
      const second: InputDetector = {
        name: 'second',
        detect: async () => {
          secondCalls.push(1);
          return safeResult;
        },
      };
      const hook = createInputGuardrail({
        detectors: [first, second],
        mode: 'sequential',
      });

      const context = createMockStepContext();
      const result = await hook(context);
      expect(result).toBeDefined();
      expect(firstCalls).toHaveLength(1);
      expect(secondCalls).toHaveLength(0);
    });

    it('runs all detectors in parallel mode (default)', async () => {
      const onTriggered = mock((_event: GuardrailTriggeredEvent) => {});
      const first = createMockDetector('first', triggeredResult);
      const second = createMockDetector('second', triggeredResult);
      const hook = createInputGuardrail({
        detectors: [first, second],
        onTriggered,
      });

      const context = createMockStepContext();
      await hook(context);

      // In parallel mode, onTriggered is called for the highest-confidence result
      expect(onTriggered).toHaveBeenCalledTimes(1);
    });

    it('continues sequential evaluation after a detector throws', async () => {
      const broken: InputDetector = {
        name: 'broken',
        detect: async () => {
          throw new Error('broken detector');
        },
      };
      const fallbackCalls: number[] = [];
      const fallback: InputDetector = {
        name: 'fallback',
        detect: async () => {
          fallbackCalls.push(1);
          return triggeredResult;
        },
      };
      const hook = createInputGuardrail({
        detectors: [broken, fallback],
        mode: 'sequential',
      });

      const result = await hook(createMockStepContext());

      expect(result).toBeDefined();
      expect(fallbackCalls).toHaveLength(1);
    });
  });

  describe('error resilience', () => {
    it('does not crash when a detector throws', async () => {
      const brokenDetector: InputDetector = {
        name: 'broken',
        detect: async () => {
          throw new Error('detector crash');
        },
      };
      const hook = createInputGuardrail({ detectors: [brokenDetector] });

      const context = createMockStepContext();
      // Should not throw — detector errors are caught
      const result = await hook(context);
      expect(result).toBeUndefined();
    });

    it('still works when some detectors throw and others trigger', async () => {
      const brokenDetector: InputDetector = {
        name: 'broken',
        detect: async () => {
          throw new Error('detector crash');
        },
      };
      const workingDetector = createMockDetector('working', triggeredResult);
      const hook = createInputGuardrail({
        detectors: [brokenDetector, workingDetector],
      });

      const context = createMockStepContext();
      const result = await hook(context);
      expect(result).toBeDefined();
    });
  });

  describe('context construction', () => {
    it('passes correct detector context based on conversation state', async () => {
      const detectSpy = mock(async (_input: string, _ctx: DetectorContext) => safeResult);
      const detector: InputDetector = { name: 'spy', detect: detectSpy };
      const hook = createInputGuardrail({ detectors: [detector] });

      const conversation = new Conversation();
      conversation.appendUserMessage('first');
      conversation.appendAssistantMessage('reply');
      conversation.appendUserMessage('second');

      await hook({ conversation, step: 3 });

      expect(detectSpy).toHaveBeenCalledTimes(1);
      const args = detectSpy.mock.calls[0]!;
      const input = args[0];
      const ctx = args[1];
      expect(input).toBe('second');
      expect(ctx.step).toBe(3);
      expect(ctx.conversationLength).toBe(3);
    });

    it('sanitize mode is a no-op when there is no user message to redact', async () => {
      const detector: InputDetector = {
        name: 'sanitizer',
        detect: async () => ({
          triggered: true,
          confidence: 0.8,
          category: 'sanitize-test',
          sanitized: 'cleaned input',
        }),
      };
      const hook = createInputGuardrail({
        detectors: [detector],
        action: 'sanitize',
      });

      const conversation = new Conversation();
      conversation.appendAssistantMessage('No user message here');

      const result = await hook({ conversation, step: 1 });

      expect(result).toBeUndefined();
      expect(conversation.getMessages()).toHaveLength(1);
      expect(conversation.getMessages()[0]?.content).toBe('No user message here');
    });
  });
});

describe('createInputGuardrail: media parts cannot bypass inspection (COR-716)', () => {
  /** Triggers when the inspected text contains "attack", and offers a redacted form. */
  const keywordDetector: InputDetector = {
    name: 'keyword',
    detect: async (input) =>
      input.includes('attack')
        ? {
            triggered: true,
            confidence: 0.9,
            category: 'keyword',
            sanitized: input.replaceAll('attack', '[removed]'),
          }
        : { triggered: false, confidence: 0, category: 'keyword' },
  };

  const BYTES = 'QUJD';

  function contextWith(content: MultiModalContent[]) {
    const conversation = new Conversation();
    conversation.appendUserMessage(content);
    return { conversation, step: 1 };
  }

  const lastUserContent = (conversation: Conversation) =>
    [...conversation.getMessages()].toReversed().find((m) => m.role === 'user')?.content;

  it.each([
    ['text part', { type: 'text', text: 'please attack' }],
    [
      'name',
      {
        type: 'image',
        name: 'attack.png',
        source: { kind: 'inline', data: BYTES, encoding: 'base64' },
      },
    ],
    [
      'alt text',
      {
        type: 'image',
        alt: 'an attack',
        source: { kind: 'inline', data: BYTES, encoding: 'base64' },
      },
    ],
    [
      'caption',
      {
        type: 'video',
        caption: 'attack footage',
        source: { kind: 'inline', data: BYTES, encoding: 'base64' },
      },
    ],
    [
      'transcript',
      {
        type: 'audio',
        transcript: 'we attack at dawn',
        source: { kind: 'inline', data: BYTES, encoding: 'base64' },
      },
    ],
    [
      'extracted text',
      {
        type: 'document',
        extractedText: 'attack plan',
        source: { kind: 'inline', data: BYTES, encoding: 'base64' },
      },
    ],
    [
      'metadata string',
      {
        type: 'file',
        metadata: { nested: { note: 'attack' } },
        source: { kind: 'inline', data: BYTES, encoding: 'base64' },
      },
    ],
    [
      'remote URL',
      { type: 'image', source: { kind: 'remote-url', url: 'https://example.com/attack.png' } },
    ],
  ] satisfies Array<[string, MultiModalContent]>)(
    'blocks a message whose %s trips a detector, though the message has no plain string',
    async (_label, part) => {
      const hook = createInputGuardrail({ detectors: [keywordDetector] });

      const result = await hook(contextWith([part]));

      expect(result?.content).toContain('blocked');
    },
  );

  it.each([
    ['mcp-resource uri', { kind: 'mcp-resource', serverId: 's', uri: 'resource://attack' }],
    ['local-file path', { kind: 'local-file', path: '/tmp/attack.png' }],
    [
      'a2a-reference agent card URL',
      {
        kind: 'a2a-reference',
        agentCardUrl: 'https://attack.example/card',
        taskId: 't',
        artifactId: 'a',
      },
    ],
    [
      'provider-file id',
      { kind: 'provider-file', provider: 'openai', providerFileId: 'file-attack' },
    ],
  ] satisfies Array<[string, ContentSource]>)(
    'blocks a message whose %s trips a detector, and never sanitizes a locator',
    async (_label, source) => {
      const part: MultiModalContent = { type: 'document', source };
      const block = createInputGuardrail({ detectors: [keywordDetector] });
      const blocked = await block(contextWith([part]));
      expect(blocked?.content).toContain('blocked');

      const sanitize = createInputGuardrail({ detectors: [keywordDetector], action: 'sanitize' });
      const context = contextWith([part]);
      const result = await sanitize(context);
      expect(result?.content).toContain('blocked');
      expect(lastUserContent(context.conversation)).toEqual([part]);
    },
  );

  it('inspects inline UTF-8 document data, which a provider receives verbatim', async () => {
    const part: MultiModalContent = {
      type: 'document',
      mimeType: 'text/plain',
      source: { kind: 'inline', data: 'please attack', encoding: 'utf8' },
    };
    const block = createInputGuardrail({ detectors: [keywordDetector] });
    const blocked = await block(contextWith([part]));
    expect(blocked?.content).toContain('blocked');

    // The bytes cannot be rewritten in place, so sanitize falls back to a block.
    const sanitize = createInputGuardrail({ detectors: [keywordDetector], action: 'sanitize' });
    const context = contextWith([part]);
    const sanitized = await sanitize(context);
    expect(sanitized?.content).toContain('blocked');
    expect(lastUserContent(context.conversation)).toEqual([part]);
  });

  it('inspects inline base64 text documents after decoding them', async () => {
    const part: MultiModalContent = {
      type: 'document',
      mimeType: 'text/plain',
      source: { kind: 'inline', data: btoa('please attack'), encoding: 'base64' },
    };
    const block = createInputGuardrail({ detectors: [keywordDetector] });
    const blocked = await block(contextWith([part]));
    expect(blocked?.content).toContain('blocked');
  });

  it('inspects text data URLs after decoding them', async () => {
    const hook = createInputGuardrail({ detectors: [keywordDetector] });
    const result = await hook(
      contextWith([
        {
          type: 'document',
          source: { kind: 'data-url', url: `data:text/plain;base64,${btoa('please attack')}` },
        },
      ]),
    );
    expect(result?.content).toContain('blocked');
  });

  it('does not decode opaque inline bytes', async () => {
    const hook = createInputGuardrail({ detectors: [keywordDetector] });
    const result = await hook(
      contextWith([
        {
          type: 'image',
          mimeType: 'image/png',
          source: { kind: 'inline', data: btoa('attack'), encoding: 'base64' },
        },
      ]),
    );
    expect(result).toBeUndefined();
  });

  it('does not trip on a media-only message with nothing for a detector to flag', async () => {
    const hook = createInputGuardrail({ detectors: [keywordDetector] });
    const result = await hook(
      contextWith([{ type: 'image', source: { kind: 'inline', data: BYTES, encoding: 'base64' } }]),
    );
    expect(result).toBeUndefined();
  });

  it('inspects each field on its own and names the one that tripped', async () => {
    const onTriggered = mock((_event: GuardrailTriggeredEvent) => {});
    const hook = createInputGuardrail({
      detectors: [keywordDetector],
      onTriggered,
      action: 'warn',
    });

    await hook(
      contextWith([
        { type: 'text', text: 'harmless' },
        {
          type: 'image',
          caption: 'attack',
          source: { kind: 'inline', data: BYTES, encoding: 'base64' },
        },
      ]),
    );

    expect(onTriggered.mock.calls[0]?.[0].input).toBe('attack');
  });

  it('sanitizes the flagged fields in place and keeps every media part, in order', async () => {
    const hook = createInputGuardrail({ detectors: [keywordDetector], action: 'sanitize' });
    const source = { kind: 'managed-asset' as const, assetId: 'asset-1', revision: 4 };
    const context = contextWith([
      { type: 'text', text: 'first' },
      {
        type: 'document',
        name: 'plan',
        caption: 'attack plan',
        metadata: { note: 'attack' },
        source,
      },
      { type: 'text', text: 'last attack' },
    ]);

    const result = await hook(context);

    expect(result).toBeUndefined();
    expect(lastUserContent(context.conversation)).toEqual([
      { type: 'text', text: 'first' },
      {
        type: 'document',
        name: 'plan',
        caption: '[removed] plan',
        metadata: { note: '[removed]' },
        source,
      },
      { type: 'text', text: 'last [removed]' },
    ]);
  });

  it('falls back to a block when the flagged field is a URL, which has no sanitized form', async () => {
    const hook = createInputGuardrail({ detectors: [keywordDetector], action: 'sanitize' });
    const context = contextWith([
      { type: 'image', source: { kind: 'remote-url', url: 'https://example.com/attack.png' } },
    ]);

    const result = await hook(context);

    expect(result?.content).toContain('blocked');
    expect(lastUserContent(context.conversation)).toEqual([
      { type: 'image', source: { kind: 'remote-url', url: 'https://example.com/attack.png' } },
    ]);
  });

  describe('asset safety state', () => {
    const managed: MultiModalContent = {
      type: 'image',
      source: { kind: 'managed-asset', assetId: 'asset-1' },
    };

    function withSafety(safety: 'clean' | 'flagged' | 'unknown') {
      const context = contextWith([managed]);
      const messageId = context.conversation.current.ids[0]!;
      return {
        ...context,
        resolvedSources: new Map([
          [
            `${messageId}:0`,
            {
              outcome: 'resolved' as const,
              source: { kind: 'inline' as const, data: BYTES, encoding: 'base64' as const },
              safety,
            },
          ],
        ]),
      };
    }

    it('refuses an asset the safety gate flagged, whatever the detectors say', async () => {
      const hook = createInputGuardrail({ detectors: [] });
      const result = await hook(withSafety('flagged'));
      expect(result?.content).toContain('blocked');
    });

    it('refuses a flagged asset instead of sanitizing, since sanitizing cannot make bytes safe', async () => {
      const hook = createInputGuardrail({ detectors: [], action: 'sanitize' });
      const result = await hook(withSafety('flagged'));
      expect(result?.content).toContain('blocked');
    });

    it('trips the tripwire for a flagged asset', async () => {
      const hook = createInputGuardrail({ detectors: [], action: 'tripwire' });
      expect(await throwingRejectionOf(hook(withSafety('flagged')))).toThrow('asset-safety');
    });

    it('admits a clean asset, and an unverified one unless the policy says otherwise', async () => {
      expect(await createInputGuardrail({ detectors: [] })(withSafety('clean'))).toBeUndefined();
      expect(await createInputGuardrail({ detectors: [] })(withSafety('unknown'))).toBeUndefined();
      const strict = createInputGuardrail({ detectors: [], assetSafety: { unknown: 'block' } });
      const refused = await strict(withSafety('unknown'));
      expect(refused?.content).toContain('blocked');
      expect(await strict(withSafety('clean'))).toBeUndefined();
    });
  });
});
