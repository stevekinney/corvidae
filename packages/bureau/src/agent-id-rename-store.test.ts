import { describe, expect, it } from 'bun:test';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';

import { agentIdRenameKey, createAgentIdRenameStore } from './agent-id-rename-store.ts';

const HASH = 'a'.repeat(64);

describe('the saved-agent identifier rename fence', () => {
  it('reserves both identifiers once and survives a fresh registry', async () => {
    const storage = textValueStore(new MemoryStorage());
    const first = createAgentIdRenameStore(storage);
    const reserved = await first.reserve({ from: 'old-id', to: 'new-id', sourceHash: HASH });
    const second = createAgentIdRenameStore(storage);

    expect(await second.get('old-id')).toEqual(reserved);
    expect(await second.get('new-id')).toEqual(reserved);
    await expect(second.reserve({ from: 'other', to: 'new-id', sourceHash: HASH })).rejects.toThrow(
      'already reserves',
    );
    expect(agentIdRenameKey('new-id')).toBe('bureau-agent-id-rename:v1:new-id');
  });

  it('advances and clears only the exact durable intent', async () => {
    const store = createAgentIdRenameStore(textValueStore(new MemoryStorage()));
    const prepared = await store.reserve({ from: 'old-id', to: 'new-id', sourceHash: HASH });
    const published = await store.advance(prepared, 'target-published');

    expect(await store.clear(prepared)).toBe(false);
    expect(await store.clear(published)).toBe(true);
    expect(await store.get('old-id')).toBeUndefined();
  });

  it('keeps completion separate while releasing the active two-name reservation', async () => {
    const store = createAgentIdRenameStore(textValueStore(new MemoryStorage()));
    const prepared = await store.reserve({ from: 'old-id', to: 'new-id', sourceHash: HASH });
    const cutover = await store.advance(prepared, 'cutover');

    expect(await store.complete(cutover)).toBe(true);
    expect(await store.get('old-id')).toBeUndefined();
    expect(await store.completed('old-id', 'new-id')).toEqual(cutover);
  });
});
