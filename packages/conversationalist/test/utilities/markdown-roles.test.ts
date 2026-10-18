import { describe, expect, test } from 'bun:test';

import {
  fromMarkdown,
  getRoleFromLabel,
  getRoleLabel,
  LABEL_TO_ROLE,
  ROLE_LABELS,
} from '../../src';
import type { MessageRole } from '../../src/types';

test('rejects inherited object properties as role labels', () => {
  expect(getRoleFromLabel('constructor')).toBeUndefined();
  expect(getRoleFromLabel('__proto__')).toBeUndefined();
  expect(getRoleFromLabel('toString')).toBeUndefined();
});

describe('role labels', () => {
  describe('ROLE_LABELS', () => {
    test('exports all message roles', () => {
      const roles: MessageRole[] = [
        'user',
        'assistant',
        'system',
        'developer',
        'tool-call',
        'tool-result',
        'snapshot',
      ];

      for (const role of roles) {
        expect(ROLE_LABELS[role]).toBeDefined();
        expect(typeof ROLE_LABELS[role]).toBe('string');
      }
    });

    test('has correct labels for each role', () => {
      expect(ROLE_LABELS.user).toBe('User');
      expect(ROLE_LABELS.assistant).toBe('Assistant');
      expect(ROLE_LABELS.system).toBe('System');
      expect(ROLE_LABELS.developer).toBe('Developer');
      expect(ROLE_LABELS['tool-call']).toBe('Tool Call');
      expect(ROLE_LABELS['tool-result']).toBe('Tool Result');
      expect(ROLE_LABELS.snapshot).toBe('Snapshot');
    });
  });

  describe('LABEL_TO_ROLE', () => {
    test('provides inverse mapping of ROLE_LABELS', () => {
      for (const role of [
        'user',
        'assistant',
        'system',
        'developer',
        'tool-call',
        'tool-result',
        'snapshot',
      ] as const) {
        const label = ROLE_LABELS[role];
        expect(LABEL_TO_ROLE[label]).toBe(role);
      }
    });

    test('has correct roles for each label', () => {
      expect(LABEL_TO_ROLE['User']).toBe('user');
      expect(LABEL_TO_ROLE['Assistant']).toBe('assistant');
      expect(LABEL_TO_ROLE['System']).toBe('system');
      expect(LABEL_TO_ROLE['Developer']).toBe('developer');
      expect(LABEL_TO_ROLE['Tool Call']).toBe('tool-call');
      expect(LABEL_TO_ROLE['Tool Result']).toBe('tool-result');
      expect(LABEL_TO_ROLE['Snapshot']).toBe('snapshot');
    });
  });

  describe('getRoleLabel', () => {
    test('returns correct label for each role', () => {
      expect(getRoleLabel('user')).toBe('User');
      expect(getRoleLabel('assistant')).toBe('Assistant');
      expect(getRoleLabel('system')).toBe('System');
      expect(getRoleLabel('developer')).toBe('Developer');
      expect(getRoleLabel('tool-call')).toBe('Tool Call');
      expect(getRoleLabel('tool-result')).toBe('Tool Result');
      expect(getRoleLabel('snapshot')).toBe('Snapshot');
    });
  });

  describe('getRoleFromLabel', () => {
    test('returns correct role for each label', () => {
      expect(getRoleFromLabel('User')).toBe('user');
      expect(getRoleFromLabel('Assistant')).toBe('assistant');
      expect(getRoleFromLabel('System')).toBe('system');
      expect(getRoleFromLabel('Developer')).toBe('developer');
      expect(getRoleFromLabel('Tool Call')).toBe('tool-call');
      expect(getRoleFromLabel('Tool Result')).toBe('tool-result');
      expect(getRoleFromLabel('Snapshot')).toBe('snapshot');
    });

    test('returns undefined for unknown labels', () => {
      expect(getRoleFromLabel('Unknown')).toBeUndefined();
      expect(getRoleFromLabel('')).toBeUndefined();
      expect(getRoleFromLabel('user')).toBeUndefined(); // lowercase, not valid
      expect(getRoleFromLabel('ASSISTANT')).toBeUndefined(); // uppercase, not valid
    });
  });

  describe('frontmatter key stripping', () => {
    test('strips unknown/malicious frontmatter keys', () => {
      const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: "2024-01-01T00:00:00.000Z"
updatedAt: "2024-01-01T00:00:00.000Z"
messages:
  msg-1:
    position: 0
    createdAt: "2024-01-01T00:00:00.000Z"
    metadata: {}
    hidden: false
maliciousKey: "exec('rm -rf /')"
__proto__: "attack"
---

### User (msg-1)

Hello
`;
      const conversation = fromMarkdown(markdown);
      expect(conversation.id).toBe('conv-1');
      // Malicious keys should not appear anywhere in the conversation
      expect('maliciousKey' in conversation).toBe(false);
      // Extra keys should not leak into metadata
      expect(Object.hasOwn(conversation.metadata, 'maliciousKey')).toBe(false);
    });

    test('preserves all allowlisted frontmatter keys', () => {
      const markdown = `---
schemaVersion: 6
id: conv-2
title: "Test Chat"
status: active
metadata:
  key: value
createdAt: "2024-01-01T00:00:00.000Z"
updatedAt: "2024-01-01T00:00:00.000Z"
messages:
  msg-1:
    position: 0
    createdAt: "2024-01-01T00:00:00.000Z"
    metadata: {}
    hidden: false
---

### User (msg-1)

Hello
`;
      const conversation = fromMarkdown(markdown);
      expect(conversation.id).toBe('conv-2');
      expect(conversation.title).toBe('Test Chat');
      expect(conversation.status).toBe('active');
    });
  });
});
