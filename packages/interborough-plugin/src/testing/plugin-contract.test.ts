import { describe, expect, test } from 'bun:test';

import { definePlugin } from '../define-plugin.ts';
import {
  checkPluginContract,
  type CreatePluginTestHost,
  type PluginTestHostListing,
} from './plugin-contract.ts';

const plugin = definePlugin({
  name: 'example',
  version: '1.0.0',
  description: 'An example plugin.',
});

/** A host double that reports `listing` and records that it was disposed. */
function hostReporting(listing: PluginTestHostListing | undefined) {
  const state = { disposed: 0 };
  const createHost: CreatePluginTestHost = async () => ({
    plugins: {
      list: async () => (listing === undefined ? [] : [listing]),
      ready: async () => {},
    },
    dispose: async () => {
      state.disposed += 1;
    },
  });
  return { createHost, state };
}

const running: PluginTestHostListing = {
  descriptor: { name: 'example' },
  status: 'running',
  problems: [],
};

describe('checkPluginContract', () => {
  test('passes a plugin the host runs without problems, and disposes the host', async () => {
    const { createHost, state } = hostReporting(running);
    expect(await checkPluginContract(plugin, { createHost })).toEqual([]);
    expect(state.disposed).toBe(1);
  });

  test('fails a plugin with an unresolved reference, naming the file and the id', async () => {
    const { createHost } = hostReporting({
      ...running,
      problems: [
        { code: 'reference-unresolved', file: 'example:triager', id: 'example:absent' },
      ] as never,
    });
    const failures = await checkPluginContract(plugin, { createHost });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.check).toBe('reports no problems');
    expect(failures[0]?.message).toContain('reference-unresolved');
    expect(failures[0]?.message).toContain('example:absent');
  });

  test('fails a plugin the host does not run', async () => {
    const { createHost } = hostReporting({ ...running, status: 'skipped' });
    const failures = await checkPluginContract(plugin, { createHost });
    expect(failures.map(({ check }) => check)).toEqual(['loads into a host and runs']);
  });

  test('fails when the host does not list the plugin', async () => {
    const { createHost } = hostReporting(undefined);
    const failures = await checkPluginContract(plugin, { createHost });
    expect(failures.map(({ check }) => check)).toEqual([
      'loads into a host and runs',
      'reports no problems',
    ]);
  });

  test('reports a host that cannot start as a failure instead of throwing', async () => {
    const createHost: CreatePluginTestHost = async () => {
      throw new Error('no storage');
    };
    const failures = await checkPluginContract(plugin, { createHost });
    expect(failures.map(({ message }) => message)).toEqual(['no storage', 'no storage']);
  });
});
