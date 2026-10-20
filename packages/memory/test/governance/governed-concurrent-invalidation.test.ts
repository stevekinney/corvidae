/**
 * COR-1546 — a record leaves active use once. Supersession and consolidation each check that the
 * record is still in use, admit a replacement, and then stamp the record as replaced; two callers
 * that all check before either stamps used to both succeed, leaving two active replacements and a
 * record that named only the later one. The stamp is now a compare-and-swap that declines a record
 * already replaced, and the caller that loses removes the replacement it admitted.
 */
import { describe, expect, it } from 'bun:test';

import {
  authority,
  createGovernedFixture,
  principalA,
  recordIdOf,
  type GovernedBackend,
} from './governed-memory-harness';

const inspector = authority({ capabilities: ['memory:get', 'memory:list', 'memory:inspect'] });
const at = (id: string) => ({ id, collection: 'prefs' });

for (const backend of ['in-memory', 'weft'] as const satisfies readonly GovernedBackend[]) {
  describe(`concurrent invalidation on the ${backend} record storage`, () => {
    it('lets exactly one of two concurrent supersessions apply, and leaves one successor', async () => {
      const fixture = await createGovernedFixture(backend);
      const original = await recordIdOf(
        fixture.memory.write(principalA, 'The user prefers aisle seats.', {
          collection: 'prefs',
          source: 'conversation',
        }),
      );
      const supersede = (content: string) =>
        fixture.memory.forget(principalA, {
          mode: 'supersession',
          locator: at(original),
          successor: { content, collection: 'prefs', source: 'operator' },
        });

      const results = await Promise.all([
        supersede('The user prefers window seats.'),
        supersede('The user prefers the exit row.'),
      ]);

      expect(results.map((result) => result.status).toSorted()).toEqual(['applied', 'rejected']);
      const winner = results.find((result) => result.status === 'applied');
      const winnerId = String(winner?.write?.recordId);
      const loser = results.find((result) => result.status === 'rejected');
      expect(loser).toMatchObject({ reason: 'superseded' });
      // One successor is in use, and the original names it.
      const listed = await fixture.memory.list(principalA, { collection: 'prefs' });
      expect(listed.map((record) => record.id)).toEqual([winnerId]);
      const old = await fixture.memory.get(inspector, at(original));
      expect(old?.governance?.supersededBy).toBe(winnerId);
      // The loser's replacement is gone, not left as a second record.
      const everything = await fixture.memory.list(inspector, { collection: 'prefs' });
      expect(everything.map((record) => record.id).toSorted()).toEqual(
        [original, winnerId].toSorted(),
      );
    });

    it('produces one consolidated record from two concurrent consolidations over one input', async () => {
      const fixture = await createGovernedFixture(backend);
      const first = await recordIdOf(
        fixture.memory.write(principalA, 'Seat note one.', {
          collection: 'prefs',
          source: 'conversation',
        }),
      );
      const second = await recordIdOf(
        fixture.memory.write(principalA, 'Seat note two.', {
          collection: 'prefs',
          source: 'conversation',
        }),
      );
      const third = await recordIdOf(
        fixture.memory.write(principalA, 'Seat note three.', {
          collection: 'prefs',
          source: 'conversation',
        }),
      );
      const consolidate = (inputs: readonly string[], content: string) =>
        fixture.memory.forget(principalA, {
          mode: 'consolidation',
          locators: inputs.map(at),
          content,
          collection: 'prefs',
        });

      // They share `second`, and each also holds an input of its own.
      const results = await Promise.all([
        consolidate([first, second], 'Seat notes one and two.'),
        consolidate([second, third], 'Seat notes two and three.'),
      ]);

      expect(results.map((result) => result.status).toSorted()).toEqual(['applied', 'rejected']);
      const winner = results.find((result) => result.status === 'applied');
      const listed = await fixture.memory.list(principalA, { collection: 'prefs' });
      // One consolidated record, and the input only the loser held is back in use.
      const summaries = listed.filter((record) => record.source === 'derived');
      expect(summaries.map((record) => record.id)).toEqual([String(winner?.recordIds?.[0])]);
      const winnerInputs = winner?.recordIds ?? [];
      expect(winnerInputs).toHaveLength(1);
      const inUse = listed
        .filter((record) => record.source !== 'derived')
        .map((record) => record.id);
      const loserOnly = summaries[0]?.content === 'Seat notes one and two.' ? third : first;
      expect(inUse).toEqual([loserOnly]);
    });
  });
}
