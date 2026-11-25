import { describe, expect, it } from 'bun:test';

import { viewReview, type Review } from './model.ts';

const approval: Review = {
  id: 'r1',
  runId: 'run-1',
  kind: 'tool-approval',
  status: 'pending',
  agentName: 'worker',
  requestedAt: 0,
  round: 0,
  approval: {
    toolName: 'shell',
    arguments: { cmd: 'rm -rf build' },
    reason: 'writes outside the sandbox',
    action: {
      type: 'approval',
      risk: 'high',
      expiresAt: '2026-01-01T00:10:00.000Z',
      operation: { kind: 'command', command: 'rm -rf build' },
    },
  },
};

describe('the pending-review model', () => {
  it('shows the refund amount and reconciliation status without claiming settlement', () => {
    const view = viewReview(
      {
        ...approval,
        effect: {
          kind: 'refund',
          orderId: 'order-1',
          cents: 4200,
          currency: 'USD',
          status: 'needs-reconciliation',
        },
      },
      0,
    );
    expect(view.detail).toContain('$42.00 for order order-1. Needs reconciliation.');
    expect(view.detail.join(' ')).not.toContain('Refunded');
  });
  it('shows what a reviewer decides on and offers a decision while it is pending', () => {
    const view = viewReview(approval, Date.parse('2026-01-01T00:00:00Z'));
    expect(view.title).toBe('worker asks to run shell');
    expect(view.detail).toContain('Risk: high');
    expect(view.detail).toContain('Command: rm -rf build');
    expect(view.decidable).toBe(true);
    expect(view.expired).toBe(false);
  });

  it('offers no decision once the approval expired, or the review is not pending', () => {
    const later = Date.parse('2026-01-01T00:10:00Z');
    expect(viewReview(approval, later)).toMatchObject({ expired: true, decidable: false });
    expect(viewReview({ ...approval, status: 'canceled' }, 0).decidable).toBe(false);
    expect(viewReview({ ...approval, status: 'superseded' }, 0).decidable).toBe(false);
  });

  it('truncates a long argument preview and tolerates a human wait', () => {
    const long = viewReview(
      { ...approval, approval: { toolName: 'x', arguments: { a: 'y'.repeat(1000) } } },
      0,
    );
    expect(long.detail.at(-1)).toContain('(truncated)');
    const wait = viewReview(
      {
        id: 'w',
        runId: 'r',
        kind: 'human-wait',
        status: 'pending',
        requestedAt: 0,
        signalName: 'go',
        prompt: 'Proceed?',
      },
      0,
    );
    expect(wait.title).toBe('agent is waiting for go');
    expect(wait.detail).toContain('Proceed?');
  });

  it('shows every path and the whole patch before a decision', () => {
    const patch = viewReview(
      {
        ...approval,
        approval: {
          toolName: 'apply_patch',
          arguments: {},
          action: {
            type: 'approval',
            risk: 'high',
            operation: {
              kind: 'patch',
              diff: `--- a\n+++ b\n${'+line\n'.repeat(500)}`,
              filesTouched: ['a.ts', 'b.ts'],
            },
          },
        },
      },
      0,
    );
    expect(patch.detail).toContain('Files: a.ts, b.ts');
    expect(patch.detail.find((line) => line.startsWith('Patch:'))).toHaveLength(
      'Patch:\n'.length + `--- a\n+++ b\n${'+line\n'.repeat(500)}`.length,
    );
  });

  it('never offers a decision on a human wait, which needs an answer', () => {
    const wait = viewReview(
      { id: 'w', runId: 'r', kind: 'human-wait', status: 'pending', requestedAt: 0 },
      0,
    );
    expect(wait.decidable).toBe(false);
  });
});
