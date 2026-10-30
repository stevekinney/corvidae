/**
 * COR-1930: the tool-source manager over an in-memory home. These pin what the host tests do not
 * reach: the remote lock, the repair of a configuration write that failed, a source that never
 * answers, credentials sealed under a key that is gone, and the routes' answer to each refusal.
 */
import type { AnswerEncryptionKeys } from '@lostgradient/bureau';
import { generateEncryptionKey } from '@lostgradient/cryptography';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  createToolSourceManager,
  ToolSourceAuditError,
  ToolSourceInputError,
  ToolSourcePartialChangeError,
  ToolSourceWriteLockedError,
  type ToolSourceAuditEntry,
  type ToolSourceManager,
} from './tool-source-manager.ts';
import { keysOf, memoryHome } from './tool-source-memory-home.test-support.ts';
import { toolSourceRoutes } from './tool-source-routes.ts';
import { petsDocument } from './tool-source-servers.test-support.ts';
import { toolSourceSecretKey } from './tool-source-vault.ts';

const petsSource = (id = 'pets') => ({
  id,
  kind: 'openapi',
  specification: { type: 'document', document: petsDocument },
  baseUrl: 'http://127.0.0.1:9/',
  authentication: { type: 'api-key', header: 'x-api-key', credential: 'key' },
});

/** The same source with a restriction added, so connecting it changes the configuration too. */
const changedPets = { ...petsSource(), allowOperations: ['listPets'] };

const closers: ToolSourceManager[] = [];

afterEach(async () => {
  for (const manager of closers.splice(0)) await manager.close();
});

async function managerOver(
  home: ReturnType<typeof memoryHome>,
  extra: {
    keys?: AnswerEncryptionKeys;
    audit?: (entry: ToolSourceAuditEntry) => Promise<void>;
    loadTimeoutMilliseconds?: number;
  } = {},
): Promise<{ manager: ToolSourceManager; audited: ToolSourceAuditEntry[] }> {
  const audited: ToolSourceAuditEntry[] = [];
  const manager = createToolSourceManager({
    bungalow: home.bungalow,
    keys: extra.keys ?? (await keysOf()),
    audit: extra.audit ?? (async (entry) => void audited.push(entry)),
    origin: () => 'http://127.0.0.1:1',
    ...(extra.loadTimeoutMilliseconds === undefined
      ? {}
      : { loadTimeoutMilliseconds: extra.loadTimeoutMilliseconds }),
  });
  closers.push(manager);
  return { manager, audited };
}

const owner = 'anonymous:local';

/** The sources the manager reports now. */
async function sourcesOf(manager: ToolSourceManager) {
  const snapshot = await manager.snapshot();
  return snapshot.sources;
}

function connect(
  manager: ToolSourceManager,
  key: string,
  id = 'pets',
  source: Record<string, unknown> = petsSource(id),
) {
  return manager.connect({
    id,
    source,
    credentials: { key },
    principal: owner,
  });
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('a remote home', () => {
  test('refuses every change with the reason deployment, and writes nothing', async () => {
    const home = memoryHome('remote');
    const { manager } = await managerOver(home);

    const connectFailure = await failureOf(connect(manager, 'k'));
    const removeFailure = await failureOf(manager.remove({ id: 'pets', principal: owner }));
    const authorizeFailure = await failureOf(manager.authorize('pets'));

    for (const failure of [connectFailure, removeFailure, authorizeFailure]) {
      expect(failure).toBeInstanceOf(ToolSourceWriteLockedError);
      expect((failure as ToolSourceWriteLockedError).reason).toBe('deployment');
    }
    expect(home.state.secrets.size).toBe(0);
    expect(home.state.configuration).toBeUndefined();
    // Reading still works, and says why a change would be refused.
    expect(await manager.snapshot()).toEqual({ sources: [], lockReason: 'deployment' });
  });

  test('answers 403 with the reason on the route', async () => {
    const { manager } = await managerOver(memoryHome('remote'));
    const routes = toolSourceRoutes(manager, () => undefined, { principal: () => owner });
    const request = Object.assign(
      new Request('http://127.0.0.1/host/tool-sources/pets', {
        method: 'PUT',
        body: JSON.stringify({ source: petsSource(), credentials: { key: 'k' } }),
      }),
      { params: { id: 'pets' } },
    );

    const response = await routes['/host/tool-sources/:id'].PUT(
      request as unknown as Bun.BunRequest<'/host/tool-sources/:id'>,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'locked', reason: 'deployment' });
  });
});

describe('a configuration write that fails', () => {
  test('puts the previous credentials back when the file was not replaced, and reports the failure', async () => {
    const home = memoryHome();
    const { manager } = await managerOver(home);
    await connect(manager, 'first-key');
    const secretBefore = home.state.secrets.get(toolSourceSecretKey('pets'));
    const configurationBefore = home.state.configuration;
    home.state.configurationFailure = 'before-replacing';

    const failure = await failureOf(connect(manager, 'second-key', 'pets', changedPets));

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ToolSourcePartialChangeError);
    expect(home.state.secrets.get(toolSourceSecretKey('pets'))).toBe(secretBefore);
    expect(home.state.configuration).toBe(configurationBefore);
  });

  test('clears the credentials a new source stored when its configuration was not written', async () => {
    const home = memoryHome();
    const { manager } = await managerOver(home);
    home.state.configurationFailure = 'before-replacing';

    await failureOf(connect(manager, 'only-key'));

    expect(home.state.secrets.get(toolSourceSecretKey('pets'))).toBe('');
    expect(await manager.snapshot()).toEqual({ sources: [] });
  });

  test('takes a write that threw after it replaced the file as done, and keeps its credentials', async () => {
    const home = memoryHome();
    const { manager, audited } = await managerOver(home);
    home.state.configurationFailure = 'after-replacing';

    const change = await connect(manager, 'kept-key');

    expect(change).toEqual({ id: 'pets', changed: true, restartRequired: true });
    expect(home.state.secrets.get(toolSourceSecretKey('pets'))).not.toBe('');
    const listed = await sourcesOf(manager);
    expect(listed.map((source) => source.id)).toEqual(['pets']);
    expect(audited.map((entry) => entry.type)).toEqual(['tool.source.connected']);
  });

  test('says the change is partial when the previous credentials cannot be put back', async () => {
    const home = memoryHome();
    const { manager } = await managerOver(home);
    await connect(manager, 'first-key');
    home.state.configurationFailure = 'before-replacing';
    // The new credentials are written, then the put-back fails.
    home.state.secretWritesBeforeFailing = home.state.secretWrites + 1;

    const failure = await failureOf(connect(manager, 'second-key', 'pets', changedPets));

    expect(failure).toBeInstanceOf(ToolSourcePartialChangeError);
    expect((failure as ToolSourcePartialChangeError).stage).toBe('credentials-not-restored');
    expect(String(failure)).not.toContain('second-key');
  });

  test('reports a change that stands but could not be audited', async () => {
    const home = memoryHome();
    const { manager } = await managerOver(home, {
      audit: async () => {
        throw new Error('the trail is down');
      },
    });

    const failure = await failureOf(connect(manager, 'a-key'));

    expect(failure).toBeInstanceOf(ToolSourceAuditError);
    const listed = await sourcesOf(manager);
    expect(listed.map((source) => source.id)).toEqual(['pets']);
  });
});

describe('a rotation of credentials alone', () => {
  test('replaces them without rewriting the configuration, so a failing write cannot undo it', async () => {
    const home = memoryHome();
    const { manager } = await managerOver(home);
    await connect(manager, 'first-key');
    const secretBefore = home.state.secrets.get(toolSourceSecretKey('pets'));
    const configurationBefore = home.state.configuration;
    home.state.configurationFailure = 'before-replacing';

    const change = await connect(manager, 'second-key');

    expect(change.changed).toBe(true);
    expect(home.state.configuration).toBe(configurationBefore);
    expect(home.state.secrets.get(toolSourceSecretKey('pets'))).not.toBe(secretBefore);
  });
});

describe('a request the caller changes while it waits', () => {
  test('is stored as it was when it was made', async () => {
    const home = memoryHome();
    const { manager } = await managerOver(home);
    const source = {
      ...petsSource(),
      specification: {
        type: 'document',
        document: structuredClone<Record<string, unknown>>(petsDocument),
      },
    };

    const pending = manager.connect({
      id: 'pets',
      source,
      credentials: { key: 'k' },
      principal: owner,
    });
    // The caller reuses its object before the change has been written.
    source.specification.document['paths'] = {};
    await pending;

    expect(home.state.configuration).toContain('listPets');
  });
});

describe('a request the host cannot use', () => {
  test('is refused before anything is written', async () => {
    const home = memoryHome();
    const { manager } = await managerOver(home);
    const attempt = (request: Parameters<ToolSourceManager['connect']>[0]) =>
      failureOf(manager.connect(request));

    const results = await Promise.all([
      // The addressed id and the description's id disagree.
      attempt({ id: 'other', source: petsSource(), credentials: { key: 'k' }, principal: owner }),
      // The id cannot name a Bungalow secret.
      attempt({ id: 'Pets_1', source: petsSource('Pets_1'), credentials: {}, principal: owner }),
      // A credential the description does not name.
      attempt({ id: 'pets', source: petsSource(), credentials: { extra: 'x' }, principal: owner }),
      // A credential the description names, with no value anywhere.
      attempt({ id: 'pets', source: petsSource(), principal: owner }),
      // A value with a control character.
      attempt({ id: 'pets', source: petsSource(), credentials: { key: 'a\nb' }, principal: owner }),
      // A description Armorer refuses.
      attempt({
        id: 'pets',
        source: { ...petsSource(), extra: 1 },
        credentials: { key: 'k' },
        principal: owner,
      }),
    ]);

    for (const result of results) expect(result).toBeInstanceOf(ToolSourceInputError);
    expect(results.map((result) => (result as ToolSourceInputError).field)).toEqual([
      'source.id',
      'id',
      'credentials.extra',
      'credentials.key',
      'credentials.key',
      'source',
    ]);
    expect(home.state.secrets.size).toBe(0);
    expect(home.state.configuration).toBeUndefined();
  });

  test('keeps the stored credential when a source is connected again without one', async () => {
    const home = memoryHome();
    const { manager } = await managerOver(home);
    await connect(manager, 'first-key');
    const stored = home.state.secrets.get(toolSourceSecretKey('pets'));

    const again = await manager.connect({
      id: 'pets',
      source: { ...petsSource(), allowOperations: ['listPets'] },
      principal: owner,
    });

    expect(again.changed).toBe(true);
    const after = JSON.parse(home.state.secrets.get(toolSourceSecretKey('pets')) ?? '{}') as {
      credentials: { key: unknown };
    };
    expect(after.credentials.key).toBeDefined();
    expect(home.state.secrets.get(toolSourceSecretKey('pets'))).not.toBe(stored);
  });
});

describe('boot', () => {
  test('reports a source that never answers as its own standing, with nothing in the catalog', async () => {
    const silent = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      // Never answers; the request ends when the server stops.
      fetch: () => new Promise<Response>(() => undefined),
    });
    try {
      const home = memoryHome();
      const keys = await keysOf();
      const first = await managerOver(home, { keys });
      await first.manager.connect({
        id: 'silent',
        source: {
          id: 'silent',
          kind: 'mcp',
          transport: { type: 'http', url: `http://127.0.0.1:${silent.port}/` },
        },
        principal: owner,
      });

      // load-proof: the server never answers, so the source times out at any load; this home holds no other source to be slowed.
      const second = await managerOver(home, { keys, loadTimeoutMilliseconds: 50 });
      await second.manager.start();

      const [standing] = await sourcesOf(second.manager);
      expect(standing).toMatchObject({
        id: 'silent',
        state: 'failed',
        message: 'The source did not answer in time.',
      });
      expect(Object.keys(second.manager.tools())).toEqual([]);
    } finally {
      await silent.stop(true);
    }
  });

  test('reads credentials sealed under a retired key, and reports them unreadable once the key is gone', async () => {
    const home = memoryHome();
    const retired = await generateEncryptionKey();
    const first = await managerOver(home, { keys: { current: retired } });
    await connect(first.manager, 'k');
    const rotated = await generateEncryptionKey();

    const withRetired = await managerOver(home, {
      keys: {
        current: rotated,
        retired: (keyId) => (keyId === retired.keyId ? retired : undefined),
      },
    });
    await withRetired.manager.start();
    const without = await managerOver(home, { keys: { current: rotated } });
    await without.manager.start();

    const [revived] = await sourcesOf(withRetired.manager);
    expect(revived?.state).toBe('loaded');
    const [lost] = await sourcesOf(without.manager);
    expect(lost?.state).toBe('failed');
    expect(lost?.message).toContain('cannot be read');
    expect(Object.keys(without.manager.tools())).toEqual([]);
  });

  test('does not read a record copied from another source’s secret', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const { manager } = await managerOver(home, { keys });
    await connect(manager, 'k', 'pets');
    await connect(manager, 'k', 'other');
    // The attacker-controlled copy: another source's secret, in place of this one's.
    home.state.secrets.set(
      toolSourceSecretKey('other'),
      home.state.secrets.get(toolSourceSecretKey('pets')) ?? '',
    );

    const restarted = await managerOver(home, { keys });
    await restarted.manager.start();

    const listed = await sourcesOf(restarted.manager);
    const standings = new Map(listed.map((source) => [source.id, source.state]));
    expect(standings.get('pets')).toBe('loaded');
    expect(standings.get('other')).toBe('failed');
  });
});

describe('a local command that is edited', () => {
  const shell = (extra: Record<string, unknown>) => ({
    id: 'shell',
    kind: 'mcp',
    transport: {
      type: 'stdio',
      command: 'bun',
      args: ['run', 'server.ts'],
      env: { GITHUB_HOST: 'github.com', LEVEL: 'info' },
      credentialEnv: { TOKEN: 'tok', OTHER: 'other' },
      ...extra,
    },
  });
  const connectShell = (
    manager: ToolSourceManager,
    source: Record<string, unknown>,
    credentials?: Record<string, string>,
  ) =>
    manager.connect({
      id: 'shell',
      source,
      principal: owner,
      ...(credentials ? { credentials } : {}),
    });

  async function connectedFirst() {
    const home = memoryHome();
    const { manager } = await managerOver(home);
    await connectShell(manager, shell({}), { tok: 'secret', other: 'other-secret' });
    return manager;
  }

  test('keeps its credentials when only the order of its environment keys changes', async () => {
    const manager = await connectedFirst();

    const again = await connectShell(
      manager,
      shell({
        env: { LEVEL: 'info', GITHUB_HOST: 'github.com' },
        credentialEnv: { OTHER: 'other', TOKEN: 'tok' },
      }),
    );

    expect(again.id).toBe('shell');
  });

  test('drops its credentials when only an environment value changes', async () => {
    const manager = await connectedFirst();

    const refused = await failureOf(
      connectShell(manager, shell({ env: { GITHUB_HOST: 'evil.example', LEVEL: 'info' } })),
    );

    expect(refused).toBeInstanceOf(ToolSourceInputError);
  });

  test('drops its credentials when only the credential environment changes, unless new ones arrive', async () => {
    const manager = await connectedFirst();
    const moved = shell({ credentialEnv: { TOKEN: 'other', OTHER: 'tok' } });

    expect(await failureOf(connectShell(manager, moved))).toBeInstanceOf(ToolSourceInputError);
    const supplied = await connectShell(manager, moved, { tok: 'fresh', other: 'fresh-other' });
    expect(supplied.changed).toBe(true);
  });
});
