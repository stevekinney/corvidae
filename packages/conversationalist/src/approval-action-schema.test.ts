import { describe, expect, test } from 'bun:test';

import { materializeToolResult } from 'armorer/protocol';

import { conversationSchema, toolActionSchema } from './schemas';
import { CURRENT_SCHEMA_VERSION } from './types';

describe('tool action schema approval metadata', () => {
  const approvalAction = {
    type: 'approval',
    message: 'Approve deployment?',
    risk: 'high',
    operation: {
      kind: 'command',
      command: 'deploy',
      argsPreview: { environment: 'production' },
    },
    sandbox: {
      provider: 'codex',
      name: 'workspace-write',
      workingDir: '/workspace',
    },
    expiresAt: '2026-09-19T12:34:56-06:00',
    policyVersion: 'policy:1',
    idempotencyKey: 'approval-key',
  } as const;

  describe('irreversible, consequence and why (COR-2438)', () => {
    const explained = {
      ...approvalAction,
      irreversible: true,
      consequence: 'Deploys to production.',
      why: 'The release passed staging.',
    };

    test('carries all three through a parse unchanged', () => {
      const parsed = toolActionSchema.parse(explained);
      expect(parsed).toEqual(explained);
    });

    test('parses an approval stored before the fields existed, adding none of them', () => {
      const parsed = toolActionSchema.parse(approvalAction);
      expect(parsed).toEqual(approvalAction);
      expect('irreversible' in parsed || 'consequence' in parsed || 'why' in parsed).toBe(false);
    });

    test('holds the bounds armorer holds: a consequence of 500 characters and a why of 2000', () => {
      const atBound = { ...approvalAction, consequence: 'c'.repeat(500), why: 'w'.repeat(2000) };
      expect(toolActionSchema.safeParse(atBound).success).toBe(true);
      // The same action materializes through armorer, so the two packages agree on the bound.
      expect(
        materializeToolResult({
          callId: 'call-bound',
          outcome: 'action_required',
          content: null,
          action: atBound,
        }).action,
      ).toMatchObject({ consequence: 'c'.repeat(500), why: 'w'.repeat(2000) });
    });

    test.each([
      ['a non-boolean irreversible', { irreversible: 'yes' }],
      ['an empty consequence', { consequence: '' }],
      ['a consequence over 500 characters', { consequence: 'c'.repeat(501) }],
      ['an empty why', { why: '' }],
      ['a why over 2000 characters', { why: 'w'.repeat(2001) }],
    ])('rejects %s, as armorer does', (_label, override) => {
      const action = { ...approvalAction, ...override };
      expect(toolActionSchema.safeParse(action).success).toBe(false);
      expect(() =>
        materializeToolResult({
          callId: 'call-refused',
          outcome: 'action_required',
          content: null,
          action,
        }),
      ).toThrow();
    });
  });

  test('a stored conversation from before the fields and one carrying them both parse under the current version', () => {
    function stored(action: Record<string, unknown>) {
      return {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        id: 'stored',
        status: 'active',
        metadata: {},
        ids: ['call', 'result'],
        messages: {
          call: {
            id: 'call',
            role: 'tool-call',
            content: '',
            position: 0,
            createdAt: '2026-11-01T00:00:00.000Z',
            metadata: {},
            hidden: false,
            toolCall: { id: 'call-1', name: 'deploy', arguments: {} },
          },
          result: {
            id: 'result',
            role: 'tool-result',
            content: '',
            position: 1,
            createdAt: '2026-11-01T00:00:01.000Z',
            metadata: {},
            hidden: false,
            toolResult: { callId: 'call-1', outcome: 'action_required', content: null, action },
          },
        },
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:01.000Z',
      };
    }
    // The version did not move for these optional fields (README, version history).
    expect(CURRENT_SCHEMA_VERSION).toBe(8);
    const before = conversationSchema.safeParse(stored(approvalAction));
    const after = conversationSchema.safeParse(
      stored({ ...approvalAction, irreversible: true, consequence: 'Deploys.', why: 'Asked to.' }),
    );
    expect(before.success).toBe(true);
    expect(after.success).toBe(true);
  });

  test('accepts complete approval metadata', () => {
    const parsed = toolActionSchema.safeParse(approvalAction);

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

  test('accepts early ISO years with explicit timezones without rewriting bytes', () => {
    for (const expiresAt of ['0099-09-19T12:34:56Z', '0099-09-19T12:34:56+00:00']) {
      const parsed = toolActionSchema.safeParse({ ...approvalAction, expiresAt });

      expect(parsed.success).toBe(true);
      if (parsed.success && parsed.data.type === 'approval') {
        expect(parsed.data.expiresAt).toBe(expiresAt);
      }
    }
  });

  test.each([
    ['top-level approval', { ...approvalAction, unexpected: 'x' }],
    [
      'command operation',
      {
        ...approvalAction,
        operation: { ...approvalAction.operation, unexpected: 'x' },
      },
    ],
    [
      'sandbox',
      {
        ...approvalAction,
        sandbox: { ...approvalAction.sandbox, unexpected: 'x' },
      },
    ],
  ])('rejects unknown %s fields', (_label, action) => {
    expect(toolActionSchema.safeParse(action).success).toBe(false);
  });

  test('keeps approval operation filesTouched exact optional', () => {
    const omitted = toolActionSchema.safeParse(approvalAction);
    const present = toolActionSchema.safeParse({
      ...approvalAction,
      operation: { ...approvalAction.operation, filesTouched: ['deployments/production.json'] },
    });
    const explicitUndefined = toolActionSchema.safeParse({
      ...approvalAction,
      operation: { ...approvalAction.operation, filesTouched: undefined },
    });

    expect(omitted.success).toBe(true);
    expect(present.success).toBe(true);
    expect(explicitUndefined.success).toBe(false);
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
