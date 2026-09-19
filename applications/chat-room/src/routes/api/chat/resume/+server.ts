import { toolActionSchema } from '@corvidae/conversationalist';
import { json } from '@sveltejs/kit';
import { z } from 'zod';

import { requestContext, toolbox } from '../../../../lib/toolbox.ts';

import type { SignedPendingToolApproval } from '@corvidae/armorer';
import type { RequestHandler } from './$types';

const policyPauseTierSchema = z.enum(['capability', 'registry', 'tool']);

const approvalSchema = z
  .object({
    callId: z.string(),
    toolName: z.string(),
    arguments: z.unknown(),
    action: toolActionSchema,
    reason: z.string().optional(),
    metadata: z.unknown().optional(),
    policyPauseTier: policyPauseTierSchema.optional(),
    satisfiedPolicyPauses: z
      .array(
        z.object({
          action: toolActionSchema,
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

const resolutionSchema = z.object({
  decision: z.enum(['approve', 'approve_with_edits', 'deny', 'cancel']),
  editedArgs: z.unknown().optional(),
  reason: z.string().optional(),
  remember: z.boolean(),
});

const requestSchema = z.object({
  approval: approvalSchema,
  resolution: resolutionSchema,
});

export async function handleResumeRequest(request: Request): Promise<Response> {
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

  const { approval, resolution } = parsed.data;

  if (!isSignedPendingToolApproval(approval)) {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }

  const result = await toolbox.resolveApproval(approval, resolution, { requestContext });

  return json({
    callId: result.callId,
    outcome: result.outcome,
    content: result.content,
    ...(result.action ? { action: result.action } : {}),
    ...(result.pendingApproval ? { pendingApproval: result.pendingApproval } : {}),
    ...(result.error ? { error: result.error } : {}),
  });
}

export const POST: RequestHandler = async ({ request }) => handleResumeRequest(request);
