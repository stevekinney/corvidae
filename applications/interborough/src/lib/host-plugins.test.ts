/** The client for the host's plugin routes: what it sends, what it reads, and what it never repeats. */
import { describe, expect, test } from 'bun:test';

import {
  getPlugins,
  HOST_PLUGINS_ROUTE,
  HOST_RESTART_ROUTE,
  HostPluginError,
  type HostPluginFaultKind,
  restartHost,
  savePluginSecret,
  updatePlugin,
} from './host-plugins.ts';

const VALUE = 'tsk-test-value-that-must-never-be-repeated';

const SNAPSHOT = {
  plugins: [
    {
      descriptor: {
        name: 'linear',
        version: '0.3.0',
        description: 'Linear issues.',
        required: false,
        enabledByDefault: true,
        secrets: [{ key: 'linear-api-key', generated: false }],
      },
      source: 'folder',
      location: '/plugins/linear',
      status: 'needs-setup',
      problems: [{ code: 'secret-missing', key: 'linear-api-key', contributions: ['linear:x'] }],
      contributions: [
        {
          kind: 'tool',
          id: 'linear:create-issue',
          references: { agents: 1, schedules: 2, waitingRuns: 3 },
        },
      ],
      enabled: true,
      configuration: { teamKey: 'COR' },
      secrets: [{ key: 'linear-api-key', generated: false, set: false, location: '/secrets/key' }],
      restartRequired: false,
    },
  ],
  unloaded: [
    {
      source: 'folder',
      location: '/plugins/broken',
      status: 'skipped',
      problems: [{ code: 'load-failed', message: 'x' }],
    },
  ],
};

type Seen = { path: string; method: string | undefined; body: string | undefined };

function recording(respond: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const entry: Seen = {
      path: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    seen.push(entry);
    return respond(entry);
  };
  return { seen, fetch };
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('getPlugins', () => {
  test('asks the host and parses the plugins, what they add, and the folders that did not load', async () => {
    const { seen, fetch } = recording(() => Response.json(SNAPSHOT));
    const snapshot = await getPlugins({ fetch });
    expect(seen.map((entry) => entry.path)).toEqual([HOST_PLUGINS_ROUTE]);
    expect(snapshot.plugins[0]?.contributions[0]?.references).toEqual({
      agents: 1,
      schedules: 2,
      waitingRuns: 3,
    });
    expect(snapshot.plugins[0]?.problems[0]?.['code']).toBe('secret-missing');
    expect(snapshot.unloaded).toHaveLength(1);
    expect(snapshot.lockReason).toBeUndefined();
  });

  test('keeps a problem code it does not know', async () => {
    const changed = structuredClone(SNAPSHOT);
    changed.plugins[0]!.problems = [{ code: 'brand-new', key: 'x', contributions: [] }];
    const { fetch } = recording(() => Response.json(changed));
    const snapshot = await getPlugins({ fetch });
    expect(snapshot.plugins[0]?.problems[0]?.code).toBe('brand-new');
  });

  test('fails for a refused request and for an answer it cannot read', async () => {
    const refused = recording(() => Response.json({}, { status: 500 }));
    expect(await failureOf(getPlugins({ fetch: refused.fetch }))).toBeInstanceOf(Error);
    const unreadable = recording(() => Response.json({ plugins: 'none' }));
    expect(await failureOf(getPlugins({ fetch: unreadable.fetch }))).toBeDefined();
  });
});

describe('updatePlugin', () => {
  test('sends only the fields it is given, to the plugin’s own route', async () => {
    const { seen, fetch } = recording(() =>
      Response.json({ plugin: 'a/b', enabled: false, configuration: {}, restartRequired: true }),
    );
    const change = await updatePlugin('a/b', { enabled: false }, { fetch });
    expect(seen).toEqual([
      { path: `${HOST_PLUGINS_ROUTE}/a%2Fb`, method: 'PUT', body: '{"enabled":false}' },
    ]);
    expect(change.restartRequired).toBe(true);
  });

  test('words each refusal by its kind and field', async () => {
    const answers: [number, object, HostPluginFaultKind][] = [
      [403, { error: 'locked', reason: 'deployment', message: 'm' }, 'locked'],
      [404, { error: 'not-found', message: 'm' }, 'not-found'],
      [400, { error: 'invalid', field: 'enabled', message: 'm' }, 'invalid'],
      [500, { error: 'failed', message: 'm' }, 'failed'],
    ];
    for (const [status, body, kind] of answers) {
      const { fetch } = recording(() => Response.json(body, { status }));
      const error = await failureOf(updatePlugin('a', { enabled: true }, { fetch }));
      expect(error).toBeInstanceOf(HostPluginError);
      expect((error as HostPluginError).kind).toBe(kind);
    }
    const { fetch } = recording(() =>
      Response.json({ error: 'invalid', field: 'enabled', message: 'm' }, { status: 400 }),
    );
    expect(((await failureOf(updatePlugin('a', {}, { fetch }))) as HostPluginError).field).toBe(
      'enabled',
    );
  });

  test('is a plain failure for an answer that is not JSON', async () => {
    const { fetch } = recording(() => new Response('nope', { status: 502 }));
    const error = await failureOf(updatePlugin('a', {}, { fetch }));
    expect((error as HostPluginError).kind).toBe('failed');
  });
});

describe('savePluginSecret', () => {
  test('sends the value in the body, never the path', async () => {
    const { seen, fetch } = recording(() =>
      Response.json({ plugin: 'linear', key: 'linear-api-key', set: true }),
    );
    await savePluginSecret('linear', 'linear-api-key', VALUE, { fetch });
    expect(seen).toEqual([
      {
        path: `${HOST_PLUGINS_ROUTE}/linear/secrets/linear-api-key`,
        method: 'PUT',
        body: JSON.stringify({ value: VALUE }),
      },
    ]);
    expect(seen[0]?.path).not.toContain(VALUE);
  });

  test('replaces a message that holds the value', async () => {
    const { fetch } = recording(() =>
      Response.json(
        { error: 'invalid', field: 'value', message: `${VALUE} is no good` },
        { status: 400 },
      ),
    );
    const error = (await failureOf(
      savePluginSecret('linear', 'linear-api-key', VALUE, { fetch }),
    )) as HostPluginError;
    expect(error.message).not.toContain(VALUE);
    expect(error.kind).toBe('invalid');
  });
});

describe('restartHost', () => {
  test('posts to the restart route and accepts the 202', async () => {
    const { seen, fetch } = recording(() => Response.json({ restarting: true }, { status: 202 }));
    await restartHost({ fetch });
    expect(seen).toEqual([{ path: HOST_RESTART_ROUTE, method: 'POST', body: undefined }]);
  });

  test('fails when the host will not restart', async () => {
    const { fetch } = recording(() => Response.json({}, { status: 404 }));
    expect(await failureOf(restartHost({ fetch }))).toBeInstanceOf(HostPluginError);
  });
});
