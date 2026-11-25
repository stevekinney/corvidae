import { openBungalow } from '@lostgradient/bungalow';
import { expect, spyOn, test } from 'bun:test';
import * as fileSystem from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost } from './host.ts';

test('reports a home close failure without declaring its resources closed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interborough-teardown-'));
  try {
    const failure = new Error('home close failed');
    const host = await startHost({
      environment: { INTERBOROUGH_HOME: home },
      port: 0,
      log: () => {},
      openHome: async (options) => {
        const bungalow = await openBungalow(options);
        return {
          ...bungalow,
          close: () => {
            bungalow.close();
            throw failure;
          },
        };
      },
    });
    const error = await host.close().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError & { resourcesClosed: boolean }).resourcesClosed).toBe(false);
    expect((error as AggregateError).errors).toContain(failure);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('classifies an instance-record removal failure after all resources close', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interborough-teardown-'));
  try {
    const host = await startHost({
      environment: { INTERBOROUGH_HOME: home },
      port: 0,
      log: () => {},
    });
    const remove = fileSystem.rm;
    const failure = new Error('record removal failed');
    const spy = spyOn(fileSystem, 'rm').mockImplementation((path, options) => {
      if (String(path) === join(home, 'instance.json')) return Promise.reject(failure);
      return remove(path, options);
    });
    try {
      const error = await host.close().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError & { resourcesClosed: boolean }).resourcesClosed).toBe(true);
      expect((error as AggregateError).errors).toContain(failure);
      const reopened = await openBungalow({
        name: 'interborough',
        environment: { INTERBOROUGH_HOME: home },
      });
      reopened.close();
    } finally {
      spy.mockRestore();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('preserves both startup and teardown failures', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interborough-teardown-'));
  try {
    const failure = new Error('home close failed');
    const error = await startHost({
      environment: { INTERBOROUGH_HOME: home },
      workspaceAuthentication: {
        authentication: { resolveApiKeyPrincipal: async () => null },
        workspace: {
          workspaceId: 'wrong-workspace',
          resolveMembership: async () => null,
          resolveOwnerMembership: async () => null,
        },
      },
      openHome: async (options) => {
        const bungalow = await openBungalow(options);
        return {
          ...bungalow,
          close: () => {
            bungalow.close();
            throw failure;
          },
        };
      },
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AggregateError);
    const failures = (error as AggregateError).errors;
    expect(String(failures[0])).toContain('Workspace authentication requires');
    expect(failures[1]).toBeInstanceOf(AggregateError);
    expect((failures[1] as AggregateError).errors).toContain(failure);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
