import { describe, expect, test } from 'bun:test';

import { materializeToolResult } from './materialization';
import type { ToolApprovalAction, ToolApprovalResolution } from './types';

const approvalAction = {
  type: 'approval',
  message: 'Approve deployment?',
  risk: 'medium',
  operation: {
    kind: 'command',
    command: 'deploy --environment production',
    filesTouched: ['deployments/production.json'],
    argsPreview: { environment: 'production', replicas: 3 },
  },
  sandbox: {
    provider: 'codex',
    name: 'workspace-write',
    workingDir: '/workspace',
  },
  env: ['DEPLOY_ENV', 'API_TOKEN=redacted'],
  snapshotId: 'snapshot-123',
  expiresAt: '2026-09-19T12:34:56.789Z',
  editableArgs: true,
  policyVersion: 'policy:2026-09',
  idempotencyKey: 'approval:deploy:production',
} satisfies ToolApprovalAction;

describe('approval tool actions', () => {
  test('materializes every approval field as JSON-safe data', () => {
    const result = materializeToolResult({
      callId: 'call-deploy',
      outcome: 'action_required',
      content: null,
      action: approvalAction,
    });

    expect(result.action).toEqual(approvalAction);
  });

  test('keeps input actions independent from approval-only metadata', () => {
    const result = materializeToolResult({
      callId: 'call-input',
      outcome: 'action_required',
      content: null,
      action: {
        type: 'input',
        message: 'Need a value',
        schema: { type: 'object', properties: { value: { type: 'string' } } },
      },
    });

    expect(result.action).toEqual({
      type: 'input',
      message: 'Need a value',
      schema: { type: 'object', properties: { value: { type: 'string' } } },
    });
  });

  test.each([
    ['missing risk', { risk: undefined }],
    ['missing policyVersion', { policyVersion: undefined }],
    ['missing idempotencyKey', { idempotencyKey: undefined }],
    ['missing timezone', { expiresAt: '2026-09-19T12:34:56' }],
    ['invalid calendar date', { expiresAt: '2026-02-30T12:34:56Z' }],
    ['invalid offset time', { expiresAt: '2026-09-19T25:00:00-06:00' }],
  ])('rejects approval actions with %s', (_label, override) => {
    const action = { ...approvalAction, ...override };

    expect(() =>
      materializeToolResult({
        callId: 'call-deploy',
        outcome: 'action_required',
        content: null,
        action,
      }),
    ).toThrow();
  });

  test('accepts valid offset timestamps and elapsed timestamps without rewriting bytes', () => {
    const offset = '2026-09-19T12:34:56-06:00';
    const elapsed = '2020-01-01T00:00:00Z';

    expect(
      materializeToolResult({
        callId: 'call-offset',
        outcome: 'action_required',
        content: null,
        action: { ...approvalAction, expiresAt: offset },
      }).action,
    ).toMatchObject({ expiresAt: offset });
    expect(
      materializeToolResult({
        callId: 'call-elapsed',
        outcome: 'action_required',
        content: null,
        action: { ...approvalAction, expiresAt: elapsed },
      }).action,
    ).toMatchObject({ expiresAt: elapsed });
  });

  test('exports a structural approval resolution contract', () => {
    const resolution = {
      decision: 'approve_with_edits',
      editedArgs: { environment: 'staging' },
      reason: 'Use staging first',
      remember: true,
    } satisfies ToolApprovalResolution;

    expect(resolution).toEqual({
      decision: 'approve_with_edits',
      editedArgs: { environment: 'staging' },
      reason: 'Use staging first',
      remember: true,
    });
  });
});
