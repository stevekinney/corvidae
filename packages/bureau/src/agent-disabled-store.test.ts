/**
 * COR-2429 — the disabled-agent gate's writes are fenced on what they read: of two disables at
 * once exactly one writes (and so exactly one is audited), and the other reads its record; of two
 * enables at once exactly one changes anything.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage, textValueStore } from '@lostgradient/storage';

import { agentDisabledKey, createAgentDisabledStore } from './agent-disabled-store.ts';

function storeOver() {
  const store = textValueStore(new MemoryStorage());
  let tick = 0;
  const gate = createAgentDisabledStore({
    store,
    nowISO: () => new Date(Date.UTC(2026, 10, 18, 0, 0, tick++)).toISOString(),
  });
  return { store, gate };
}

describe('the disabled-agent gate', () => {
  it('writes one record for two disables at once, and the second reads the first one’s', async () => {
    const { store, gate } = storeOver();

    const [first, second] = await Promise.all([
      gate.disable('alpha', { disabledBy: 'alice' }),
      gate.disable('alpha', { disabledBy: 'bob' }),
    ]);

    expect([first.changed, second.changed].filter(Boolean)).toHaveLength(1);
    expect(first.record).toEqual(second.record);
    expect(JSON.parse((await store.get(agentDisabledKey('alpha'))) ?? 'null')).toEqual(
      first.record,
    );
    expect(gate.isDisabled('alpha')).toBe(true);
  });

  it('keeps the first record when an agent already disabled is disabled again', async () => {
    const { gate } = storeOver();
    const first = await gate.disable('alpha', { disabledBy: 'alice' });

    const again = await gate.disable('alpha', { disabledBy: 'bob' });

    expect(first.changed).toBe(true);
    expect(again).toEqual({ record: first.record, changed: false });
  });

  it('changes something for exactly one of two enables at once, and nothing for an enabled agent', async () => {
    const { store, gate } = storeOver();
    await gate.disable('alpha', { disabledBy: 'alice' });

    const results = await Promise.all([gate.enable('alpha'), gate.enable('alpha')]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.get(agentDisabledKey('alpha'))).toBeNull();
    expect(gate.isDisabled('alpha')).toBe(false);
    expect(await gate.enable('alpha')).toBe(false);
  });
});
