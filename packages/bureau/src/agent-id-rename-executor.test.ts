import { describe, expect, it } from 'bun:test';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';

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

    expect(await executor.rename('old-id', 'new-id', HASH)).toMatchObject({
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
    expect(calls).toEqual(['rewrite', 'retire']);
  });

  it('completes a cutover whose source retired before its receipt, without recapturing it', async () => {
    const store = createAgentIdRenameStore(textValueStore(new MemoryStorage()));
    const prepared = await store.reserve({ from: 'old-id', to: 'new-id', sourceHash: HASH });
    const cutover = await store.advance(
      await store.advance(prepared, 'target-published'),
      'cutover',
    );
    const calls: string[] = [];
    const executor = createAgentIdRenameExecutor(store, {
      capture: async () => {
        throw new Error('the retired source must not be captured');
      },
      publishTarget: async () => void calls.push('publish'),
      rewriteDependents: async () => void calls.push('rewrite'),
      retireSource: async () => void calls.push('retire'),
    });

    expect(await executor.rename('old-id', 'new-id', HASH)).toEqual(cutover);
    expect(calls).toEqual(['retire']);
    expect(await executor.rename('old-id', 'new-id', HASH)).toEqual(cutover);
    expect(calls).toEqual(['retire']);
  });

  it('does not treat a differently fenced operation as a retired-source replay', async () => {
    const store = createAgentIdRenameStore(textValueStore(new MemoryStorage()));
    await store.reserve({ from: 'old-id', to: 'other-id', sourceHash: HASH });
    const executor = createAgentIdRenameExecutor(store, {
      capture: async () => {
        throw new Error('a conflicting reservation must win before capture');
      },
      publishTarget: async () => undefined,
      rewriteDependents: async () => undefined,
      retireSource: async () => undefined,
    });

    expect(await rejectionOf(executor.rename('old-id', 'new-id', HASH))).toMatchObject({
      message: expect.stringContaining('already reserves'),
    });
    expect(await rejectionOf(executor.rename('old-id', 'other-id', 'b'.repeat(64)))).toMatchObject({
      message: expect.stringContaining('already reserves'),
    });
  });
});
