import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../test/index';
import { createMemoryAuthority } from './authority';
import { createGovernedMemory } from './governed-memory';
import { createMemoryGovernanceLedger } from './ledger';
import { createMemoryGovernancePolicy } from './policy';

function fixture() {
  const memory = createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage(),
    ledger: createMemoryGovernanceLedger(new MemoryStorage()),
    embedder: createMockEmbedder(64),
    policy: createMemoryGovernancePolicy({ revision: 'governance:list' }),
  });
  const authority = (capabilities: Parameters<typeof createMemoryAuthority>[0]['capabilities']) =>
    createMemoryAuthority({
      principal: { kind: 'user', id: 'owner-a' },
      tenantId: 'tenant-a',
      ownerId: 'owner-a',
      purpose: 'test',
      capabilities,
      policyRevision: 'authorization:1',
      projection: 'bureau',
    });
  return {
    memory,
    owner: authority(['memory:list', 'memory:get', 'memory:write']),
    inspector: authority(['memory:list', 'memory:get', 'memory:inspect']),
  };
}

describe('listing a record that was taken out of active use (COR-1546)', () => {
  it('shows the successor and not a superseded original, which get still reads', async () => {
    const { memory, owner, inspector } = fixture();
    const original = await memory.write(owner, 'The user prefers aisle seats.', {
      collection: 'agent',
      source: 'conversation',
    });
    const corrected = await memory.forget(owner, {
      mode: 'supersession',
      locator: { id: original.recordId!, collection: 'agent' },
      successor: {
        content: 'The user prefers window seats.',
        collection: 'agent',
        source: 'conversation',
      },
    });
    expect(corrected.status).toBe('applied');

    const listed = await memory.list(owner, { collection: 'agent' });
    expect(listed.map((record) => record.id)).toEqual([corrected.write!.recordId!]);
    // The original stays stored and readable by its id, which is how a client follows a correction back.
    const read = await memory.get(owner, { id: original.recordId!, collection: 'agent' });
    expect(read?.content).toBe('The user prefers aisle seats.');
    // A privileged reader lists history, as it lists a quarantined record.
    const history = await memory.list(inspector, { collection: 'agent' });
    expect(history.map((record) => record.id).toSorted()).toEqual(
      [original.recordId!, corrected.write!.recordId!].toSorted(),
    );
  });

  it('hides the inputs of a consolidation the same way', async () => {
    const { memory, owner } = fixture();
    const first = await memory.write(owner, 'Seat note one.', {
      collection: 'agent',
      source: 'conversation',
    });
    const second = await memory.write(owner, 'Seat note two.', {
      collection: 'agent',
      source: 'conversation',
    });
    const consolidated = await memory.forget(owner, {
      mode: 'consolidation',
      locators: [
        { id: first.recordId!, collection: 'agent' },
        { id: second.recordId!, collection: 'agent' },
      ],
      content: 'Seat notes one and two.',
      collection: 'agent',
    });
    expect(consolidated.status).toBe('applied');
    const listed = await memory.list(owner, { collection: 'agent' });
    expect(listed.map((record) => record.content)).toEqual(['Seat notes one and two.']);
  });
});
