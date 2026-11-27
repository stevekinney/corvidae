import { describe, expect, it } from 'bun:test';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';

import { createAgentIdRenameExecutor } from './agent-id-rename-executor.ts';
import { createAgentIdRenameStore } from './agent-id-rename-store.ts';

const HASH = 'a'.repeat(64);

describe('saved-agent identifier executor', () => {
  it('publishes, rewrites, retires, and then replays the durable receipt', async () => {
    const calls: string[] = [];
    const executor = createAgentIdRenameExecutor(
      createAgentIdRenameStore(textValueStore(new MemoryStorage())),
      {
        capture: async () => void calls.push('capture'),
        publishTarget: async () => void calls.push('publish'),
        rewriteDependents: async () => void calls.push('rewrite'),
        retireSource: async () => void calls.push('retire'),
      },
    );

    await expect(executor.rename('old-id', 'new-id', HASH)).resolves.toMatchObject({
      from: 'old-id',
      to: 'new-id',
      phase: 'cutover',
    });
    expect(calls).toEqual(['capture', 'publish', 'rewrite', 'retire']);
    await executor.rename('old-id', 'new-id', HASH);
    expect(calls).toEqual(['capture', 'publish', 'rewrite', 'retire']);
  });

  it('resumes after target publication without publishing it twice', async () => {
    const store = createAgentIdRenameStore(textValueStore(new MemoryStorage()));
    const prepared = await store.reserve({ from: 'old-id', to: 'new-id', sourceHash: HASH });
    await store.advance(prepared, 'target-published');
    const calls: string[] = [];
    const executor = createAgentIdRenameExecutor(store, {
      capture: async () => void calls.push('capture'),
      publishTarget: async () => void calls.push('publish'),
      rewriteDependents: async () => void calls.push('rewrite'),
      retireSource: async () => void calls.push('retire'),
    });

    await executor.rename('old-id', 'new-id', HASH);
    expect(calls).toEqual(['capture', 'rewrite', 'retire']);
  });
});
