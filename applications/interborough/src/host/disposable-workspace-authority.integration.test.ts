import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDisposableWorkspaceService } from '../../fixtures/disposable-workspace-service.ts';

test('verified service identities operate only their disposable namespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'disposable-authority-'));
  try {
    let failPublication = false;
    let observeReset = false;
    let resetRemovedState = false;
    const service = await createDisposableWorkspaceService(root, () => {
      if (observeReset) resetRemovedState = !existsSync(join(root, 'a', 'state.json'));
      if (failPublication) throw new Error('publication failed');
    });
    const a = await service.provision('a', true);
    const b = await service.provision('b', true, 'sentinel-b');
    const protectedOwner = await service.provision('protected', false, 'protected-sentinel');
    const reader = await service.provision('reader', true, 'reader-sentinel', false);
    expect(new Set([a.actor, b.actor, protectedOwner.actor]).size).toBe(3);
    expect(a.policyVersion).toBe('fixture-policy-v1');
    const call = (key: string, method: string, target?: string, body?: string) =>
      service.handle(
        new Request(`http://fixture.invalid/${target === undefined ? '' : `?target=${target}`}`, {
          method,
          headers: { 'x-api-key': key },
          ...(body === undefined ? {} : { body }),
        }),
      );
    const status = async (promise: Promise<Response>) => {
      const response = await promise;
      return response.status;
    };
    const json = async (promise: Promise<Response>) => {
      const response = await promise;
      return response.json();
    };
    expect(await status(call(a.key, 'POST', undefined, 'initial-a'))).toBe(200);
    expect(await status(call(a.key, 'PUT', undefined, 'written-a'))).toBe(200);
    expect(await json(call(a.key, 'GET', 'a'))).toEqual({
      state: 'written-a',
      revision: 2,
    });
    expect(existsSync(join(root, 'a', 'state.json'))).toBe(true);
    observeReset = true;
    expect(await status(call(a.key, 'DELETE', 'a'))).toBe(200);
    observeReset = false;
    expect(resetRemovedState).toBe(true);
    expect(await json(call(a.key, 'GET'))).toEqual({ state: '', revision: 3 });
    expect(await status(call(a.key, 'PUT', undefined, 'restore-on-failure'))).toBe(200);
    failPublication = true;
    expect(await throwingRejectionOf(call(a.key, 'DELETE'))).toThrow('publication failed');
    failPublication = false;
    expect(await json(call(a.key, 'GET'))).toEqual({ state: 'restore-on-failure', revision: 4 });
    const homeEntries = await readdir(join(root, 'a'));
    expect(homeEntries.filter((name) => name.startsWith('state.json.'))).toEqual([]);
    expect(await status(call(a.key, 'DELETE'))).toBe(200);
    for (const target of ['b', 'protected']) {
      for (const method of ['POST', 'PUT', 'DELETE'])
        expect(
          await status(call(a.key, method, target, method === 'DELETE' ? undefined : 'attacker')),
        ).toBe(403);
    }
    expect(await status(call(protectedOwner.key, 'PUT', undefined, 'attacker'))).toBe(403);
    expect(await status(call(protectedOwner.key, 'POST', undefined, 'attacker'))).toBe(403);
    expect(await status(call(protectedOwner.key, 'DELETE', 'protected'))).toBe(403);
    expect(await status(call('invalid', 'PUT', 'b', 'attacker'))).toBe(401);
    expect(await status(call(reader.key, 'PUT', undefined, 'attacker'))).toBe(403);
    expect(await json(call(reader.key, 'GET'))).toEqual({
      state: 'reader-sentinel',
      revision: 1,
    });
    await service.revoke(reader.key);
    expect(await status(call(reader.key, 'DELETE'))).toBe(401);
    const transient = service.issueAdditional(a.key);
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const bodyRequested = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          bodyController = controller;
        },
        pull() {
          bodyRequested.resolve();
        },
      },
      { highWaterMark: 0 },
    );
    const pending = service.handle(
      new Request('http://fixture.invalid/', {
        method: 'PUT',
        headers: { 'x-api-key': transient },
        body,
      }),
    );
    await bodyRequested.promise;
    await service.revoke(transient);
    bodyController!.enqueue(new TextEncoder().encode('late-write'));
    bodyController!.close();
    expect(await status(pending)).toBe(401);
    expect(await json(call(a.key, 'GET'))).toEqual({ state: '', revision: 5 });
    expect(await json(call(b.key, 'GET'))).toEqual({ state: 'sentinel-b', revision: 1 });
    expect(await json(call(protectedOwner.key, 'GET', 'protected'))).toEqual({
      state: 'protected-sentinel',
      revision: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
