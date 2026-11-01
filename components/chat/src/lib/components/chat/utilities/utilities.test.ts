import { describe, expect, it } from 'bun:test';

import type { Message, MultiModalContent } from '../conversation-model.ts';
import type { TranscriptEntryInfo } from './types.ts';
import {
  CINDER_ARTIFACT_METADATA_KEY,
  formatMessageAsMarkdown,
  getMessageParts,
  getMessageRoleLabel,
  getMessageText,
  messagesToMarkdown,
  normalizeArtifactTitle,
  resolveMessageArtifact,
  resolveMessageArtifactValue,
  resolveMessageNotes,
  resolveMessageReasoning,
  resolveMessageSteps,
  resolveMessageSuggestions,
  resolveMessageTranscriptEntries,
  toMultiModalArray,
} from './utilities.ts';

function message(overrides: Partial<Message> & Pick<Message, 'role'>): Message {
  return {
    id: 'm',
    content: '',
    position: 0,
    createdAt: '2026-06-02T00:00:00.000Z',
    metadata: {},
    hidden: false,
    ...overrides,
  };
}

describe('toMultiModalArray', () => {
  it('wraps a string in a single text part', () => {
    expect(toMultiModalArray('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('wraps a single content item in an array', () => {
    const image: MultiModalContent = {
      type: 'image',
      source: { kind: 'remote-url', url: 'https://example.test/a.png' },
    };
    expect(toMultiModalArray(image)).toEqual([image]);
  });

  it('returns an array as-is', () => {
    const parts: MultiModalContent[] = [
      { type: 'text', text: 'a' },
      { type: 'image', source: { kind: 'remote-url', url: 'https://example.test/b.png' } },
    ];
    expect(toMultiModalArray(parts)).toBe(parts);
  });
});

describe('getMessageParts', () => {
  it('treats empty/missing content as a single empty text part', () => {
    const parts = getMessageParts({
      id: 'm',
      role: 'assistant',
      content: '',
      position: 0,
      createdAt: '2026-06-02T00:00:00.000Z',
      metadata: {},
      hidden: false,
    });
    expect(parts).toEqual([{ type: 'text', text: '' }]);
  });

  it('passes a readonly content array through without casts', () => {
    const content = [{ type: 'text', text: 'x' }] as const;
    const parts = getMessageParts(message({ role: 'assistant', content }));
    expect(parts).toEqual([{ type: 'text', text: 'x' }]);
  });
});

describe('getMessageText', () => {
  it('joins only text content parts with newlines', () => {
    expect(
      getMessageText(
        message({
          role: 'assistant',
          content: [
            { type: 'text', text: 'first' },
            {
              type: 'image',
              source: { kind: 'remote-url', url: 'https://example.test/image.png' },
            },
            { type: 'text', text: 'second' },
          ],
        }),
      ),
    ).toBe('first\nsecond');
  });

  it('returns an empty string when a message has no text parts', () => {
    expect(
      getMessageText(
        message({
          role: 'assistant',
          content: [
            {
              type: 'image',
              source: { kind: 'remote-url', url: 'https://example.test/image.png' },
            },
          ],
        }),
      ),
    ).toBe('');
  });

  it('serializes published server tool content blocks instead of dropping them', () => {
    const content: MultiModalContent[] = [
      { type: 'server_tool_use', id: 'tool-1', name: 'web_search', input: { query: 'cinder' } },
      { type: 'web_search_tool_result', tool_use_id: 'tool-1', content: { title: 'Result' } },
      {
        type: 'code_execution_tool_result',
        tool_use_id: 'tool-2',
        content: { stdout: 'ok' },
      },
      { type: 'container_upload', file_id: 'file-1' },
    ];

    expect(getMessageText(message({ role: 'assistant', content }))).toContain(
      'Server tool use: web_search',
    );
    expect(getMessageText(message({ role: 'assistant', content }))).toContain(
      'Web search result: tool-1',
    );
    expect(getMessageText(message({ role: 'assistant', content }))).toContain(
      'Server tool result: tool-2',
    );
    expect(getMessageText(message({ role: 'assistant', content }))).toContain(
      'Container upload: file-1',
    );
  });
});

describe('getMessageRoleLabel', () => {
  // Regression guard for the 'tool-use' → 'tool-call' role rename: the label
  // map must key off the real MessageRole value, or tool-call messages fall
  // back to the raw role string.
  it.each([
    ['user', 'You'],
    ['assistant', 'Assistant'],
    ['system', 'System'],
    ['developer', 'Developer'],
    ['tool-call', 'Tool Call'],
    ['tool-result', 'Tool Result'],
    ['snapshot', 'Snapshot'],
  ] as const)('maps role %s to label %s', (role, label) => {
    expect(getMessageRoleLabel(message({ role }))).toBe(label);
  });
});

describe('formatMessageAsMarkdown', () => {
  it('returns the message text without adding role labels', () => {
    expect(formatMessageAsMarkdown(message({ role: 'assistant', content: 'Hello' }))).toBe('Hello');
  });
});

describe('messagesToMarkdown', () => {
  it('formats visible transcript messages with role labels and separators', () => {
    expect(
      messagesToMarkdown([
        message({ id: 'u', role: 'user', content: 'Hi' }),
        message({ id: 'a', role: 'assistant', content: 'Hello' }),
      ]),
    ).toBe('**You:**\n\nHi\n\n---\n\n**Assistant:**\n\nHello');
  });

  it('omits system and developer messages from transcript export', () => {
    expect(
      messagesToMarkdown([
        message({ id: 's', role: 'system', content: 'Rules' }),
        message({ id: 'd', role: 'developer', content: 'Instructions' }),
        message({ id: 'a', role: 'assistant', content: 'Visible' }),
      ]),
    ).toBe('**Assistant:**\n\nVisible');
  });
});

describe('resolveMessageArtifact', () => {
  it('publishes the cinder artifact metadata key', () => {
    expect(CINDER_ARTIFACT_METADATA_KEY).toBe('cinder:artifact');
  });

  it.each(['html', 'svg', 'code', 'mermaid'] as const)(
    'resolves a valid %s artifact descriptor',
    (type) => {
      const artifact = {
        type,
        content: '<artifact />',
        language: 'text',
        title: 'Generated artifact',
      };
      const value = message({
        role: 'tool-result',
        metadata: { [CINDER_ARTIFACT_METADATA_KEY]: artifact },
      });

      expect(resolveMessageArtifact(value)).toEqual(artifact);
    },
  );

  it.each([
    null,
    'diagram',
    { type: 'image', content: 'unsupported' },
    { type: 'code' },
    { type: 'code', content: 42 },
    { type: 'code', content: 'value', language: false },
    { type: 'code', content: 'value', title: 42 },
  ])('ignores malformed artifact metadata %#', (artifact) => {
    const value = message({
      role: 'assistant',
      metadata: { [CINDER_ARTIFACT_METADATA_KEY]: artifact },
    });

    expect(resolveMessageArtifact(value)).toBeUndefined();
  });

  it('normalizes blank and whitespace artifact titles to Artifact', () => {
    expect(normalizeArtifactTitle(undefined)).toBe('Artifact');
    expect(normalizeArtifactTitle('')).toBe('Artifact');
    expect(normalizeArtifactTitle('   ')).toBe('Artifact');
    expect(normalizeArtifactTitle('  Report  ')).toBe('Report');
  });

  it('resolves artifacts by source message identity instead of title or content', () => {
    const first = message({
      id: 'source-one',
      role: 'assistant',
      metadata: {
        [CINDER_ARTIFACT_METADATA_KEY]: {
          type: 'code',
          content: 'const duplicated = true;',
          language: 'typescript',
          title: 'Duplicate',
        },
      },
    });
    const second = message({
      id: 'source-two',
      role: 'assistant',
      metadata: {
        [CINDER_ARTIFACT_METADATA_KEY]: {
          type: 'code',
          content: 'const duplicated = true;',
          language: 'typescript',
          title: 'Duplicate',
        },
      },
    });

    expect(resolveMessageArtifactValue(first)).toEqual({
      type: 'code',
      content: 'const duplicated = true;',
      language: 'typescript',
      title: 'Duplicate',
      id: 'source-one',
    });
    expect(resolveMessageArtifactValue(second)).toMatchObject({
      id: 'source-two',
      title: 'Duplicate',
    });
  });

  it('preserves the raw artifact descriptor while resolving a user-facing title', () => {
    const value = message({
      id: 'blank-title-source',
      role: 'assistant',
      metadata: {
        [CINDER_ARTIFACT_METADATA_KEY]: {
          type: 'code',
          content: 'const fallback = true;',
          title: ' ',
        },
      },
    });

    expect(resolveMessageArtifact(value)).toEqual({
      type: 'code',
      content: 'const fallback = true;',
      title: ' ',
    });
    expect(resolveMessageArtifactValue(value)).toEqual({
      type: 'code',
      content: 'const fallback = true;',
      title: 'Artifact',
      id: 'blank-title-source',
    });
  });
});

describe('resolveMessageReasoning', () => {
  it('returns undefined for a plain message (no prop, no metadata) — feature absent', () => {
    expect(resolveMessageReasoning(message({ role: 'assistant' }))).toBeUndefined();
  });

  it('reads non-empty cinder:reasoning metadata', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:reasoning': 'I thought hard' } });
    expect(resolveMessageReasoning(m)).toBe('I thought hard');
  });

  it('accepts one reasoning body with an optional summary list', () => {
    const reasoning = {
      content: 'Full reasoning',
      summary: ['Checked constraints', 'Compared APIs'],
    };
    const m = message({ role: 'assistant', metadata: { 'cinder:reasoning': reasoning } });
    expect(resolveMessageReasoning(m)).toEqual(reasoning);
  });

  it('accepts structured reasoning with an explicitly undefined optional summary', () => {
    const reasoning = { content: 'Full reasoning', summary: undefined };
    const m = message({ role: 'assistant' });
    expect(resolveMessageReasoning(m, () => reasoning)).toEqual(reasoning);
  });

  it('rejects malformed structured reasoning and empty content', () => {
    expect(
      resolveMessageReasoning(
        message({ role: 'assistant', metadata: { 'cinder:reasoning': { content: '' } } }),
      ),
    ).toBeUndefined();
    expect(
      resolveMessageReasoning(
        message({
          role: 'assistant',
          metadata: { 'cinder:reasoning': { content: 'body', summary: [42] } },
        }),
      ),
    ).toBeUndefined();
  });

  it('treats empty-string metadata as absent', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:reasoning': '' } });
    expect(resolveMessageReasoning(m)).toBeUndefined();
  });

  it('ignores non-string metadata', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:reasoning': 42 } });
    expect(resolveMessageReasoning(m)).toBeUndefined();
  });

  it('prefers an explicit prop over metadata', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:reasoning': 'meta' } });
    expect(resolveMessageReasoning(m, () => 'prop')).toBe('prop');
  });

  it('a throwing callback never breaks render and falls back to metadata', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:reasoning': 'meta' } });
    // A buggy/throwing callback is treated as "no opinion" — it must not crash
    // the render, and it must not suppress valid metadata.
    expect(
      resolveMessageReasoning(m, () => {
        throw new Error('consumer bug');
      }),
    ).toBe('meta');
  });

  it('a callback returning undefined falls back to cinder:reasoning metadata', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:reasoning': 'meta' } });
    expect(resolveMessageReasoning(m, () => undefined)).toBe('meta');
  });

  it('a callback returning an empty string suppresses reasoning (does NOT fall back)', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:reasoning': 'meta' } });
    expect(resolveMessageReasoning(m, () => '')).toBe('');
  });
});

describe('resolveMessageTranscriptEntries', () => {
  it('resolves every supported transcript entry kind from namespaced metadata', () => {
    const entries: TranscriptEntryInfo[] = [
      { kind: 'interrupted', content: 'Generation interrupted' },
      { kind: 'redirect', content: 'Try another path' },
      { kind: 'stateChange', content: 'State changed' },
      { kind: 'slashCommand', content: '/compact' },
      { kind: 'turnSummary', content: 'Reviewed the API' },
    ];

    expect(
      resolveMessageTranscriptEntries(
        message({ role: 'assistant', metadata: { 'cinder:entries': entries } }),
      ),
    ).toEqual(entries);
  });

  it('drops malformed entries and suppresses empty metadata', () => {
    expect(
      resolveMessageTranscriptEntries(
        message({
          role: 'assistant',
          metadata: {
            'cinder:entries': [
              { kind: 'turnSummary', content: 'Valid summary' },
              { kind: 'unknown', content: 'Unsupported' },
              { kind: 'redirect', content: '' },
              null,
            ],
          },
        }),
      ),
    ).toEqual([{ kind: 'turnSummary', content: 'Valid summary' }]);
    expect(
      resolveMessageTranscriptEntries(
        message({ role: 'assistant', metadata: { 'cinder:entries': [] } }),
      ),
    ).toBeUndefined();
  });
});

describe('resolveMessageSteps', () => {
  const validStep = { title: 'Plan', content: 'Do it', status: 'done' as const };

  it('returns undefined for a plain message', () => {
    expect(resolveMessageSteps(message({ role: 'assistant' }))).toBeUndefined();
  });

  it('reads and validates cinder:steps metadata, dropping invalid entries', () => {
    const m = message({
      role: 'assistant',
      metadata: {
        'cinder:steps': [
          validStep,
          { title: 'bad', content: 'x', status: 'nope' },
          { title: 'no-content', status: 'done' },
        ],
      },
    });
    expect(resolveMessageSteps(m)).toEqual([validStep]);
  });

  it('returns undefined when all entries are invalid', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:steps': [{ bogus: true }] } });
    expect(resolveMessageSteps(m)).toBeUndefined();
  });

  it('prefers an explicit prop over metadata', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:steps': [validStep] } });
    const other = { title: 'Prop', content: 'c', status: 'running' as const };
    expect(resolveMessageSteps(m, () => [other])).toEqual([other]);
  });

  it('a throwing callback falls back to metadata (never breaks render)', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:steps': [validStep] } });
    expect(
      resolveMessageSteps(m, () => {
        throw new Error('consumer bug');
      }),
    ).toEqual([validStep]);
  });

  it('a callback returning undefined falls back to cinder:steps metadata', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:steps': [validStep] } });
    expect(resolveMessageSteps(m, () => undefined)).toEqual([validStep]);
  });

  it('a prop returning an empty array suppresses steps even when metadata has valid entries', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:steps': [validStep] } });
    expect(resolveMessageSteps(m, () => [])).toBeUndefined();
  });
});

describe('resolveMessageSuggestions', () => {
  it('returns undefined for a plain message', () => {
    expect(resolveMessageSuggestions(message({ role: 'assistant' }))).toBeUndefined();
  });

  it('reads cinder:suggestions metadata, dropping non-strings', () => {
    const m = message({
      role: 'assistant',
      metadata: { 'cinder:suggestions': ['Yes', 7, 'No', null] },
    });
    expect(resolveMessageSuggestions(m)).toEqual(['Yes', 'No']);
  });

  it('returns undefined for an all-invalid array', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:suggestions': [1, 2, 3] } });
    expect(resolveMessageSuggestions(m)).toBeUndefined();
  });

  it('prefers an explicit prop over metadata', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:suggestions': ['meta'] } });
    expect(resolveMessageSuggestions(m, () => ['prop'])).toEqual(['prop']);
  });

  it('a throwing callback falls back to metadata (never breaks render)', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:suggestions': ['meta'] } });
    expect(
      resolveMessageSuggestions(m, () => {
        throw new Error('consumer bug');
      }),
    ).toEqual(['meta']);
  });

  it('a callback returning undefined falls back to cinder:suggestions metadata', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:suggestions': ['meta'] } });
    expect(resolveMessageSuggestions(m, () => undefined)).toEqual(['meta']);
  });

  it('a callback returning an empty array suppresses suggestions (does NOT fall back)', () => {
    const m = message({ role: 'assistant', metadata: { 'cinder:suggestions': ['meta'] } });
    expect(resolveMessageSuggestions(m, () => [])).toBeUndefined();
  });
});

describe('resolveMessageNotes', () => {
  it('resolves every note kind from namespaced metadata and drops malformed entries', () => {
    const notes = [
      { kind: 'memory', id: 'a', recordId: 'r', collection: 'c', memoryClass: 'episodic' },
      { kind: 'wakeup', id: 'b', wakeAt: 1_700_000_000_000, note: 'later' },
      { kind: 'child-run', id: 'c', childRunId: 'x', agentName: 'helper', status: 'running' },
      { kind: 'stopped', id: 'd', reason: 'Budget exceeded' },
    ];
    const malformed = [
      null,
      'text',
      { kind: 'memory', id: 'e', recordId: '', collection: 'c', memoryClass: 'k' },
      { kind: 'wakeup', id: 'f', wakeAt: Number.NaN },
      // Finite, but no `Date` holds it: rendering it throws in `toISOString()`.
      { kind: 'wakeup', id: 'f2', wakeAt: 1e17 },
      { kind: 'wakeup', id: 'f3', wakeAt: -1e17 },
      { kind: 'wakeup', id: 'f4', wakeAt: 8.64e15 + 1 },
      { kind: 'child-run', id: 'g', childRunId: 'x', agentName: 'h', status: 'paused' },
      { kind: 'stopped', id: 'h', reason: '  ' },
      { kind: 'unknown', id: 'i' },
      { kind: 'stopped', reason: 'no id' },
    ];
    const resolved = resolveMessageNotes(
      message({ role: 'assistant', metadata: { 'cinder:notes': [...notes, ...malformed] } }),
    );
    expect(resolved).toEqual(notes as typeof resolved);
  });

  it('keeps the earliest and latest moments a Date can hold', () => {
    const edges = [
      { kind: 'wakeup', id: 'min', wakeAt: -8.64e15 },
      { kind: 'wakeup', id: 'max', wakeAt: 8.64e15 },
    ];
    const resolved = resolveMessageNotes(
      message({ role: 'assistant', metadata: { 'cinder:notes': edges } }),
    );
    expect(resolved).toEqual(edges as typeof resolved);
    for (const note of resolved ?? []) {
      if (note.kind === 'wakeup') expect(() => new Date(note.wakeAt).toISOString()).not.toThrow();
    }
  });

  it('is undefined for a message with no valid note', () => {
    expect(resolveMessageNotes(message({ role: 'assistant' }))).toBeUndefined();
    expect(
      resolveMessageNotes(message({ role: 'assistant', metadata: { 'cinder:notes': 'x' } })),
    ).toBeUndefined();
    expect(
      resolveMessageNotes(message({ role: 'assistant', metadata: { 'cinder:notes': [{}] } })),
    ).toBeUndefined();
  });
});
