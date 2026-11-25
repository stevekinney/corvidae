import { describe, expect, it } from 'bun:test';
import { reviewedProvenanceOf } from './reviewed-provenance.ts';

describe('reviewedProvenanceOf', () => {
  it('requires the durable run marker, pinned step and call, and an authenticating policy', async () => {
    const marker = {
      agent: 'reviewed:inventory',
      tool: 'inventory:adjust@1.0.0',
      step: 0,
      result: 0,
      callId: 'reviewed-call',
    };
    const approval = { callId: marker.callId };
    const review = { kind: 'tool-approval', runId: 'run', approval } as never;
    const task = {
      taskId: 'run',
      agentName: marker.agent,
      origin: { kind: 'api', reviewedTool: marker },
    } as never;
    const steps = [
      {
        step: 0,
        toolCalls: [{ id: marker.callId, toolId: marker.tool }],
        results: [{ outcome: 'action_required', pendingApproval: approval }],
      },
    ] as never;
    const policy = { verifyReviewed: () => true } as never;
    const dependencies = { task: async () => task, steps: async () => steps, policy };
    expect(await reviewedProvenanceOf(review, dependencies)).toBe('verified');
    expect(await reviewedProvenanceOf(review, { ...dependencies, policy: undefined })).toBe(
      'unresolved',
    );
    expect(
      await reviewedProvenanceOf(review, { ...dependencies, task: async () => undefined }),
    ).toBe('unresolved');
    expect(await reviewedProvenanceOf(review, { ...dependencies, steps: async () => [] })).toBe(
      'unresolved',
    );
    expect(
      await reviewedProvenanceOf(review, {
        ...dependencies,
        policy: { verifyReviewed: () => false } as never,
      }),
    ).toBe('unresolved');
    expect(
      await reviewedProvenanceOf(review, {
        ...dependencies,
        task: async () =>
          ({ taskId: 'run', agentName: 'ordinary', origin: { kind: 'api' } }) as never,
      }),
    ).toBe('ordinary');
  });
});
