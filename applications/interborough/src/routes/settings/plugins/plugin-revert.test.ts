/** Revert for plugins: what puts a plugin back, and which plugins it writes. */
import { afterEach, describe, expect, test } from 'bun:test';

import { revertPlugins, runningChoices } from './plugin-revert.ts';
import {
  installFakePluginHost,
  snapshotOf,
  type FakePluginHost,
} from './plugins-host.test-support.ts';

let host: FakePluginHost | undefined;
afterEach(() => host?.restore());

describe('runningChoices', () => {
  test('puts back what the running host loaded, and removes a configuration it loaded none of', () => {
    host = installFakePluginHost([
      { name: 'linear', configuration: { teamKey: 'COR' } },
      { name: 'demo', enabled: false },
    ]);
    const [linear, demo] = snapshotOf(host).plugins;
    expect(runningChoices(linear!)).toEqual({ enabled: true, configuration: { teamKey: 'COR' } });
    expect(runningChoices(demo!)).toEqual({ enabled: false, configuration: null });
  });
});

describe('revertPlugins', () => {
  test('writes each plugin that waits for a restart back to its running choices, and no other', async () => {
    host = installFakePluginHost([
      { name: 'linear', configuration: { teamKey: 'COR' } },
      { name: 'demo', enabled: false },
      { name: 'files' },
    ]);
    host.stored['linear'] = { enabled: true, configuration: { teamKey: 'ENG' } };
    host.stored['demo'] = { enabled: true, configuration: {} };

    await revertPlugins(snapshotOf(host).plugins.filter((plugin) => plugin.restartRequired));

    const writes = host.requests.filter((request) => request.method === 'PUT');
    expect(writes.map((write) => [write.path, write.body])).toEqual([
      [
        '/host/plugins/linear',
        {
          enabled: true,
          configuration: { teamKey: 'COR' },
          operationId: expect.any(String),
          expectedRevision: expect.any(String),
        },
      ],
      [
        '/host/plugins/demo',
        {
          enabled: false,
          configuration: null,
          operationId: expect.any(String),
          expectedRevision: expect.any(String),
        },
      ],
    ]);
    expect(snapshotOf(host).plugins.some((plugin) => plugin.restartRequired)).toBe(false);
  });
});
