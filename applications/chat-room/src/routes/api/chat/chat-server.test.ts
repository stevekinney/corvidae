import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import type { SignedPendingToolApproval, ToolExecutionResult } from '@corvidae/armorer';
import { updatePendingApproval } from '../../../lib/pending-approval.ts';
import { requestContext, toolbox } from '../../../lib/toolbox.ts';
import type { RequestEvent } from './resume/$types';
import { POST } from './resume/+server.ts';

const resumeSource = readFileSync(new URL('./resume/+server.ts', import.meta.url), 'utf8');
/**
 * The stream's lifecycle moved to `$lib/chat-run-response.ts` when the
 * server-owned route family needed the same handling and copying it was the
 * alternative. These guards follow the code rather than the file: what they
 * pin — one-shot abort, close-from-abort-but-not-cancel, the post-listener
 * re-check, disposal on every terminal path — is the same set of races
 * wherever it lives, and it is now shared by both route families rather than
 * duplicated into a second copy that could drift.
 */
const streamSource = readFileSync(
  new URL('../../../lib/chat-run-response.ts', import.meta.url),
  'utf8',
);

function createSpan(): RequestEvent['tracing']['root'] {
  const span: RequestEvent['tracing']['root'] = {
    spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 }),
    setAttribute: () => span,
    setAttributes: () => span,
    addEvent: () => span,
    addLink: () => span,
    addLinks: () => span,
    setStatus: () => span,
    updateName: () => span,
    end: () => undefined,
    isRecording: () => false,
    recordException: () => undefined,
  };
  return span;
}

function requestEvent(request: Request): RequestEvent {
  const span = createSpan();
  return {
    cookies: {
      get: () => undefined,
      getAll: () => [],
      set: () => undefined,
      delete: () => undefined,
      serialize: () => '',
    },
    fetch,
    getClientAddress: () => '127.0.0.1',
    locals: {},
    params: {},
    platform: undefined,
    request,
    route: { id: '/api/chat/resume' },
    setHeaders: () => undefined,
    url: new URL(request.url),
    isDataRequest: false,
    isSubRequest: false,
    tracing: { enabled: false, root: span, current: span },
    isRemoteRequest: false,
  };
}

async function post(body: unknown): Promise<Response> {
  return await POST(
    requestEvent(
      new Request('http://localhost/api/chat/resume', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function hasSignedPendingApproval(result: {
  pendingApproval?: unknown;
}): result is { pendingApproval: SignedPendingToolApproval } {
  const approval = result.pendingApproval;
  return (
    typeof approval === 'object' &&
    approval !== null &&
    'approvalToken' in approval &&
    typeof approval.approvalToken === 'string'
  );
}

describe('chat stream cancellation guard', () => {
  test('registers the request signal on the same one-shot abort path cancel() uses', () => {
    expect(streamSource).toContain("options.signal.addEventListener('abort', onRequestAbort)");
    expect(streamSource).toContain("run?.abort('client cancelled')");
    expect(streamSource).toContain("run?.abort('request aborted')");
  });

  // A request-signal abort is the one path where nothing else transitions the
  // stream: `settled = true` is exactly what stops the async pump's terminal
  // branch from running, so the handler has to close the controller itself or
  // the stream never reaches a terminal state at all. `cancel()` deliberately
  // does not, because there the consumer has already torn the readable down.
  test('closes the stream from the request-abort handler but not from cancel()', () => {
    expect(streamSource).toMatch(
      /function onRequestAbort\(\): void \{[\s\S]*?run\?\.abort\('request aborted'\);[\s\S]*?closeStream\?\.\(\);[\s\S]*?\n\s*\}/,
    );
    expect(streamSource).toMatch(
      /cancel\(\) \{\s+settled = true;\s+run\?\.abort\('client cancelled'\);\s+\}/,
    );
  });

  // The window between the two guards spans `startChatRun`, which opens a
  // billed provider request — so an abort lost in it costs money as well as
  // leaving the stream open.
  test('re-checks the signal after attaching the listener, without returning', () => {
    expect(streamSource).toMatch(
      /options\.signal\.addEventListener\('abort', onRequestAbort\);[\s\S]*?if \(options\.signal\.aborted\) onRequestAbort\(\);/,
    );
    // The absence of a `return` is the load-bearing half. Returning here
    // would skip the pump, and with it the `finally` that removes the
    // listener and disposes the run — trading a lost abort for a leaked one.
    const recheck = streamSource.slice(
      streamSource.indexOf('if (options.signal.aborted) onRequestAbort();'),
    );
    expect(recheck.slice(0, recheck.indexOf('void (async'))).not.toContain('return;');
  });

  test('guards the abort handler as a one-shot', () => {
    expect(streamSource).toMatch(/function onRequestAbort\(\): void \{\s+if \(settled\) return;/);
  });

  test('removes the request-signal listener and disposes the run on every terminal path', () => {
    expect(streamSource).toMatch(
      /options\.signal\.removeEventListener\('abort', onRequestAbort\);/,
    );
    expect(streamSource).toMatch(/try \{\s+activeRun\[Symbol\.dispose\]\(\);\s+\} catch \{/);
  });

  // A single generic `expect(streamSource).toContain('if (settled) return;')` would
  // still pass with `enqueueFrame`'s guard alone, even if the terminal guard
  // before `controller.close()` or the catch-path guard before
  // `controller.error()` were deleted — reintroducing the double-settlement
  // race these guards exist to prevent. Each transition's own guard is
  // asserted by name below instead.
  test('guards the terminal close() transition behind its own settled check', () => {
    expect(streamSource).toMatch(
      /if \(settled\) return;\s+settled = true;\s+\/\/ Every settled run/,
    );
  });

  test('closes the stream for every settled run, failed ones included', () => {
    // This used to error the stream on failure, which destroys the
    // connection serving the response body — so the terminal `run.error`
    // frame went out with it and the browser saw `ERR_EMPTY_RESPONSE`. The
    // frame IS the outcome; the body is complete once it is written.
    expect(streamSource).toMatch(
      /settled = true;\s+\/\/ Every settled run[\s\S]*?controller\.close\(\);/,
    );
  });

  test('no longer tears the connection down to report a failure', () => {
    // The only surviving `controller.error` is the catch path, where
    // nothing was written and the client would otherwise hang.
    // Statements only: the comment above that catch path explains why the
    // old failure branch was removed, and naming it there must not count
    // as calling it.
    const errorCalls = streamSource.match(/^\s*controller\.error\(/gm) ?? [];
    expect(errorCalls).toHaveLength(1);
    expect(streamSource).not.toContain('controller.error(new Error(envelope.error.message));');
  });

  test('guards the catch-path controller.error() behind its own settled check', () => {
    expect(streamSource).toMatch(
      /catch \(cause\) \{\s+if \(!settled\) \{\s+settled = true;\s+controller\.error\(cause\);\s+\}\s+\}/,
    );
  });
});

describe('chat approval continuation response', () => {
  test('accepts the unified resolution endpoint contract', () => {
    expect(resumeSource).toContain(
      "import { toolActionSchema } from '@corvidae/conversationalist';",
    );
    expect(resumeSource).toContain('resolutionSchema');
    expect(resumeSource).toContain(
      'toolbox.resolveApproval(approval, resolution, { requestContext })',
    );
    expect(resumeSource).not.toContain("decision: z.enum(['approve', 'deny'])");
    expect(resumeSource).not.toContain("if (decision === 'deny')");
  });

  test('forwards the complete approval and resolution unchanged', async () => {
    const approval = {
      callId: 'call-1',
      toolName: 'remember_note',
      arguments: { text: 'before' },
      action: {
        type: 'approval' as const,
        message: 'Save this note?',
        risk: 'high' as const,
        operation: { kind: 'other' as const },
        sandbox: { provider: 'bun', name: 'chat', workingDir: '/tmp/chat' },
        env: ['A=1'],
        snapshotId: 'snapshot-1',
        expiresAt: '2099-01-02T03:04:05Z',
        editableArgs: true,
        policyVersion: 'policy-1',
        idempotencyKey: 'idempotency-1',
      },
      metadata: { signed: true },
      satisfiedPolicyPauses: [
        {
          action: {
            type: 'approval' as const,
            risk: 'low' as const,
            operation: { kind: 'other' as const },
            policyVersion: 'policy-1',
            idempotencyKey: 'nested-1',
          },
          reason: 'already satisfied',
          tier: 'registry' as const,
        },
      ],
      approvalToken: 'token-1',
    } satisfies SignedPendingToolApproval;
    const resolution = {
      decision: 'approve_with_edits' as const,
      editedArgs: { text: 'after' },
      reason: 'updated note',
      remember: true,
    };
    const result: ToolExecutionResult = {
      callId: approval.callId,
      outcome: 'action_required',
      content: null,
      toolCallId: approval.callId,
      toolName: approval.toolName,
      result: undefined,
      action: approval.action,
      pendingApproval: { ...approval, approvalToken: 'token-2' },
    };
    const resolveApproval = spyOn(toolbox, 'resolveApproval').mockResolvedValue(result);

    try {
      const response = await post({ approval, resolution });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        callId: result.callId,
        outcome: result.outcome,
        content: result.content,
        action: result.action,
        pendingApproval: result.pendingApproval,
      });
      expect(resolveApproval).toHaveBeenCalledWith(approval, resolution, {
        requestContext: expect.any(Object),
      });
    } finally {
      resolveApproval.mockRestore();
    }
  });

  test('rejects legacy and malformed resolution bodies before the toolbox', async () => {
    const approval = {
      callId: 'call-malformed',
      toolName: 'remember_note',
      arguments: { text: 'before' },
      action: {
        type: 'approval' as const,
        risk: 'high' as const,
        operation: { kind: 'other' as const },
        policyVersion: 'policy-1',
        idempotencyKey: 'malformed-1',
      },
      approvalToken: 'token-malformed',
    } satisfies SignedPendingToolApproval;
    const resolveApproval = spyOn(toolbox, 'resolveApproval');
    try {
      for (const body of [
        { approval, decision: 'deny' },
        { approval, resolution: { decision: 'deny' } },
      ]) {
        const response = await post(body);
        expect(response.status).toBe(400);
      }
      expect(resolveApproval).not.toHaveBeenCalled();
    } finally {
      resolveApproval.mockRestore();
    }
  });

  test('forwards negative decisions without fabricating a denial result', async () => {
    const approval = {
      callId: 'call-negative',
      toolName: 'remember_note',
      arguments: { text: 'before' },
      action: {
        type: 'approval' as const,
        risk: 'high' as const,
        operation: { kind: 'other' as const },
        policyVersion: 'policy-1',
        idempotencyKey: 'negative-1',
      },
      approvalToken: 'token-negative',
    } satisfies SignedPendingToolApproval;
    const resolveApproval = spyOn(toolbox, 'resolveApproval').mockImplementation(
      async (_approval, resolution): Promise<ToolExecutionResult> => ({
        callId: approval.callId,
        outcome: 'error',
        content: null,
        toolCallId: approval.callId,
        toolName: approval.toolName,
        result: undefined,
        error: {
          code: resolution.decision === 'cancel' ? 'CANCELLED' : 'denied',
          category: resolution.decision === 'cancel' ? 'cancelled' : 'permission',
          retryable: false,
          message: resolution.reason ?? 'authoritative result',
        },
      }),
    );

    try {
      for (const decision of ['deny', 'cancel'] as const) {
        const resolution = { decision, reason: `${decision} reason`, remember: false };
        const response = await post({ approval, resolution });
        expect(await response.json()).toMatchObject({
          callId: approval.callId,
          outcome: 'error',
          error: {
            code: decision === 'cancel' ? 'CANCELLED' : 'denied',
            message: resolution.reason,
          },
        });
      }
      expect(resolveApproval).toHaveBeenCalledTimes(2);
      expect(resolveApproval.mock.calls.map((call) => call[1])).toEqual([
        { decision: 'deny', reason: 'deny reason', remember: false },
        { decision: 'cancel', reason: 'cancel reason', remember: false },
      ]);
    } finally {
      resolveApproval.mockRestore();
    }
  });

  test('resolves real signed approvals for every decision and rejects tampering', async () => {
    async function pendingApproval(callId: string): Promise<SignedPendingToolApproval> {
      const result = await toolbox.execute(
        { id: callId, name: 'remember_note', arguments: { text: 'before' } },
        { requestContext },
      );
      expect(result.outcome).toBe('action_required');
      if (!hasSignedPendingApproval(result)) throw new Error('Expected a signed pending approval.');
      return result.pendingApproval;
    }

    const approved = await post({
      approval: await pendingApproval('endpoint-approve'),
      resolution: { decision: 'approve', remember: false },
    });
    const approvedBody = await approved.json();
    expect(approvedBody.outcome).toBe('success');

    const editedApproval = await pendingApproval('endpoint-edited');
    const edited = await post({
      approval: editedApproval,
      resolution: { decision: 'approve_with_edits', editedArgs: { text: 'after' }, remember: true },
    });
    const editedBody = await edited.json();
    expect(editedBody.outcome).toBe('action_required');

    const denied = await post({
      approval: await pendingApproval('endpoint-deny'),
      resolution: { decision: 'deny', reason: 'no', remember: false },
    });
    const deniedBody = await denied.json();
    expect(deniedBody.error).toMatchObject({ code: 'denied' });

    const cancelled = await post({
      approval: await pendingApproval('endpoint-cancel'),
      resolution: { decision: 'cancel', reason: 'stop', remember: false },
    });
    const cancelledBody = await cancelled.json();
    expect(cancelledBody.error).toMatchObject({ code: 'CANCELLED' });

    const tampered = await pendingApproval('endpoint-tampered');
    tampered.approvalToken = `${tampered.approvalToken}tampered`;
    await expect(
      post({ approval: tampered, resolution: { decision: 'approve', remember: false } }),
    ).rejects.toThrow();
  });

  test('forwards another pending approval stage to the client', () => {
    expect(resumeSource).toContain('...(result.action ? { action: result.action } : {})');
    expect(resumeSource).toContain(
      '...(result.pendingApproval ? { pendingApproval: result.pendingApproval } : {})',
    );
  });

  test('retains and replaces a pending approval returned by resume', () => {
    const pendingApprovals = new Map<string, SignedPendingToolApproval>();
    const first = {
      callId: 'call',
      toolName: 'remember_note',
      arguments: {},
      action: {
        type: 'approval' as const,
        risk: 'high' as const,
        operation: { kind: 'other' as const },
        policyVersion: 'policy-1',
        idempotencyKey: 'first-1',
      },
      approvalToken: 'first',
    } satisfies SignedPendingToolApproval;
    const second = {
      callId: 'call',
      toolName: 'remember_note',
      arguments: {},
      action: {
        type: 'approval' as const,
        risk: 'high' as const,
        operation: { kind: 'other' as const },
        policyVersion: 'policy-1',
        idempotencyKey: 'second-1',
      },
      approvalToken: 'second',
    } satisfies SignedPendingToolApproval;

    updatePendingApproval(pendingApprovals, {
      callId: 'call',
      outcome: 'action_required',
      content: null,
      pendingApproval: first,
    });
    updatePendingApproval(pendingApprovals, {
      callId: 'call',
      outcome: 'action_required',
      content: null,
      pendingApproval: second,
    });

    expect(pendingApprovals.get('call')).toBe(second);

    updatePendingApproval(pendingApprovals, {
      callId: 'call',
      outcome: 'success',
      content: null,
    });
    expect(pendingApprovals.has('call')).toBe(false);
  });
});
