import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import { permissionModeOfLineage } from './chat-permission-lineage';

/** A lineage of `parents` (child to parent) and the `modes` of the runs a chat holds. */
const lineageOf = (parents: Record<string, string>, modes: Record<string, 'read-only'>) => ({
  parentOf: async (runId: string) => parents[runId],
  modeOf: async (runId: string) => modes[runId],
});

describe('permissionModeOfLineage (COR-1955)', () => {
  it('reads the mode of a run that is not a child from the run itself', async () => {
    expect(await permissionModeOfLineage('chat', lineageOf({}, { chat: 'read-only' }))).toBe(
      'read-only',
    );
  });

  it('reads the mode of the root for a child and for a grandchild', async () => {
    const lineage = lineageOf({ grandchild: 'child', child: 'chat' }, { chat: 'read-only' });
    expect(await permissionModeOfLineage('child', lineage)).toBe('read-only');
    expect(await permissionModeOfLineage('grandchild', lineage)).toBe('read-only');
  });

  it('has no mode for a child whose root belongs to no chat', async () => {
    expect(
      await permissionModeOfLineage('child', lineageOf({ child: 'root' }, {})),
    ).toBeUndefined();
  });

  it('rejects, which the approval hook counts as read-only, when a parent cannot be read', async () => {
    const failure = new Error('topology store is down');
    const lineage = {
      parentOf: async () => {
        throw failure;
      },
      modeOf: async () => 'read-only' as const,
    };
    expect(await rejectionOf(permissionModeOfLineage('child', lineage))).toBe(failure);
  });

  it('rejects for a chain that loops, and for one with no end', async () => {
    const loops = lineageOf({ a: 'b', b: 'a' }, {});
    expect(String(await rejectionOf(permissionModeOfLineage('a', loops)))).toContain(
      'do not end at a root',
    );
    const endless = {
      parentOf: async (runId: string) => `${runId}x`,
      modeOf: async () => undefined,
    };
    expect(String(await rejectionOf(permissionModeOfLineage('a', endless)))).toContain(
      'do not end at a root',
    );
  });
});
