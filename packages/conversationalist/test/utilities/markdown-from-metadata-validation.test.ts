import { describe, expect, test } from 'bun:test';

import { fromMarkdown, MarkdownParseError } from '../../src';

test('rejects executable frontmatter without evaluating its body', () => {
  const effect = { executed: false };
  const marker = '__corvidaeMarkdownFrontmatterProbe';
  Object.defineProperty(globalThis, marker, { value: effect, configurable: true });
  try {
    const markdown = `---javascript\n(globalThis.${marker}.executed = true, { id: 'probe' })\n---\n`;
    expect(() => fromMarkdown(markdown)).toThrow(MarkdownParseError);
    expect(effect.executed).toBe(false);
  } finally {
    Reflect.deleteProperty(globalThis, marker);
  }
});

test('rejects unsupported frontmatter engines and unterminated YAML', () => {
  expect(() => fromMarkdown('---toml\nid = "probe"\n---\n')).toThrow('Invalid frontmatter');
  expect(() => fromMarkdown('---\nid: probe\n')).toThrow('Invalid frontmatter');
});

describe('fromMarkdown metadata validation', () => {
  test('throws MarkdownParseError when required id field is missing from frontmatter', () => {
    // gray-matter parses most YAML gracefully, so test for missing required fields instead
    expect(() => fromMarkdown('---\nstatus: active\n---')).toThrow(MarkdownParseError);
    expect(() => fromMarkdown('---\nstatus: active\n---')).toThrow('missing required field "id"');
  });

  test('throws MarkdownParseError for invalid frontmatter YAML', () => {
    const markdown = `---
id: [unclosed
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages: {}
---`;

    expect(() => fromMarkdown(markdown)).toThrow(MarkdownParseError);
    expect(() => fromMarkdown(markdown)).toThrow('Invalid frontmatter');
  });

  test('throws MarkdownParseError for unknown role', () => {
    const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
---

### Unknown Role (msg-1)

Content`;

    expect(() => fromMarkdown(markdown)).toThrow(MarkdownParseError);
    expect(() => fromMarkdown(markdown)).toThrow('Unknown role');
  });

  test('throws MarkdownParseError when message metadata is missing', () => {
    const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages: {}
---

### User (msg-1)

Content`;

    expect(() => fromMarkdown(markdown)).toThrow(MarkdownParseError);
    expect(() => fromMarkdown(markdown)).toThrow('Missing metadata for message: msg-1');
  });

  test('throws MarkdownParseError for invalid tool linkage', () => {
    const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
    toolResult:
      callId: call-1
      outcome: success
      content: {}
---

### Tool Result (msg-1)

Tool output`;

    expect(() => fromMarkdown(markdown)).toThrow(MarkdownParseError);
    expect(() => fromMarkdown(markdown)).toThrow('Invalid markdown conversation');
  });
});
