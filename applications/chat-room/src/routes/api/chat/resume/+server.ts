import { json } from '@sveltejs/kit';
import { z } from 'zod';

import { requestContext, toolbox } from '../../../../lib/toolbox.ts';

import type { SignedPendingToolApproval } from '@corvidae/armorer';
import type { RequestHandler } from './$types';

const actionSchema = z.object({
  type: z.enum(['approval', 'input']),
  message: z.string().optional(),
  schema: z.unknown().optional(),
});

const policyPauseTierSchema = z.enum(['capability', 'registry', 'tool']);

const approvalSchema = z
  .object({
    callId: z.string(),
    toolName: z.string(),
    arguments: z.unknown(),
    action: actionSchema,
    reason: z.string().optional(),
    metadata: z.unknown().optional(),
    policyPauseTier: policyPauseTierSchema.optional(),
    satisfiedPolicyPauses: z
      .array(
        z.object({
          action: actionSchema,
          reason: z.string().optional(),
          tier: policyPauseTierSchema.optional(),
        }),
      )
      .optional(),
    approvalToken: z.string(),
  })
  .passthrough();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSignedPendingToolApproval(value: unknown): value is SignedPendingToolApproval {
  return isRecord(value) && typeof value['approvalToken'] === 'string';
}

const requestSchema = z.object({
  approval: approvalSchema,
  decision: z.enum(['approve', 'deny']),
});

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { approval, decision } = parsed.data;

  if (decision === 'deny') {
    return json({
      callId: approval.callId,
      outcome: 'error',
      content: null,
      error: {
        code: 'denied',
        category: 'permission',
        retryable: false,
        message: 'The user denied this request.',
      },
    });
  }

  if (!isSignedPendingToolApproval(approval)) {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }

  const result = await toolbox.resumeApproval(approval, { requestContext });

  return json({
    callId: result.callId,
    outcome: result.outcome,
    content: result.content,
    ...(result.action ? { action: result.action } : {}),
    ...(result.pendingApproval ? { pendingApproval: result.pendingApproval } : {}),
    ...(result.error ? { error: result.error } : {}),
  });
};
