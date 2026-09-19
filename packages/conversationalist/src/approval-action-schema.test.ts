import { describe, expect, test } from 'bun:test';

import { toolActionSchema } from './schemas';

describe('tool action schema approval metadata', () => {
  test('accepts complete approval metadata', () => {
    const parsed = toolActionSchema.safeParse({
      type: 'approval',
      message: 'Approve deployment?',
      risk: 'high',
      operation: {
        kind: 'other',
        argsPreview: { environment: 'production' },
      },
      expiresAt: '2026-09-19T12:34:56-06:00',
      policyVersion: 'policy:1',
      idempotencyKey: 'approval-key',
    });

    expect(parsed.success).toBe(true);
  });

  test('rejects missing approval metadata and malformed timestamps', () => {
    expect(toolActionSchema.safeParse({ type: 'approval' }).success).toBe(false);
    expect(
      toolActionSchema.safeParse({
        type: 'approval',
        risk: 'high',
        operation: { kind: 'other' },
        expiresAt: '2026-09-19T12:34:56',
        policyVersion: 'policy:1',
        idempotencyKey: 'approval-key',
      }).success,
    ).toBe(false);
  });

  test('keeps input actions independent', () => {
    expect(
      toolActionSchema.safeParse({
        type: 'input',
        message: 'Need a value',
        schema: { type: 'object' },
      }).success,
    ).toBe(true);
  });
});
