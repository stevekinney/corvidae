/**
 * COR-2468: the host decides what to do from what its home says it can do, opens its home through
 * a function its caller can replace, and finds a location's storage or definitions in a table keyed
 * by kind. Every case here starts the host on a real local home, wrapped so that the home reports
 * the capabilities or the secret store the case needs.
 */
import { openBungalow, type Bungalow, type OpenBungalowOptions } from '@lostgradient/bungalow';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ANSWER_ENCRYPTION_KEY } from './answer-encryption.ts';
import {
  APPROVAL_SECRET_KEY,
  DELEGATION_SECRET_KEY,
  startHost,
  type Host,
  type HostOptions,
} from './host.ts';
import {
  DEFAULT_CONTENT_KINDS,
  DEFAULT_DATABASE_KINDS,
  type ContentKinds,
  type DatabaseKinds,
} from './locations.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** An empty build with an index, so the host starts without a built application. */
async function build(): Promise<string> {
  const directory = await scratch('interborough-capabilities-build-');
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><div id="app"></div>');
  return directory;
}

type Reported = {
  readonly capabilities?: Bungalow['capabilities'];
  /** Deployment secrets the home already holds, by key. */
  readonly secrets?: ReadonlyMap<string, string>;
  /** What the home's deployment secrets say about writing; the keys written are kept in `writes`. */
  readonly writable?: boolean;
};

/**
 * A `openHome` that opens a real local home at `root` and wraps it: its capabilities and the
 * writability of its secrets are as `reported` says, whatever its `mode` is. A write to the secrets
 * is kept in memory, never in the home.
 */
function openReporting(root: string, reported: Reported) {
  const writes: string[] = [];
  const secrets = new Map(reported.secrets);
  const received: OpenBungalowOptions[] = [];
  const openHome = async (options: OpenBungalowOptions): Promise<Bungalow> => {
    received.push(options);
    const real = await openBungalow({ ...options, environment: { INTERBOROUGH_HOME: root } });
    return {
      ...real,
      ...(reported.capabilities === undefined ? {} : { capabilities: reported.capabilities }),
      deploymentSecrets: {
        writable: reported.writable ?? real.deploymentSecrets.writable,
        read: async (key: string) => secrets.get(key) ?? (await real.deploymentSecrets.read(key)),
        write: async (key: string, value: string) => {
          writes.push(key);
          secrets.set(key, value);
        },
        location: (key: string) => real.deploymentSecrets.location(key),
      },
    };
  };
  return { openHome, writes, received, secrets };
}

async function start(options: HostOptions): Promise<Host> {
  const host = await startHost({
    port: 0,
    buildDirectory: await build(),
    log: () => undefined,
    ...options,
  });
  hosts.push(host);
  return host;
}

async function failureOf(options: HostOptions): Promise<Error> {
  const failure = await startHost({
    port: 0,
    buildDirectory: await build(),
    log: () => undefined,
    ...options,
  }).then(
    (host) => {
      hosts.push(host);
      return undefined;
    },
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  return failure as Error;
}

describe('the home the host opens', () => {
  test('is the one openHome resolves, opened with the options the host passes to openBungalow', async () => {
    const root = await scratch('interborough-capabilities-home-');
    const elsewhere = await scratch('interborough-capabilities-ignored-');
    const { openHome, received } = openReporting(root, {});

    const host = await start({ environment: { INTERBOROUGH_HOME: elsewhere }, openHome });

    expect(received).toHaveLength(1);
    expect(received[0]?.name).toBe('interborough');
    expect(received[0]?.environment?.['INTERBOROUGH_HOME']).toBe(elsewhere);
    expect(typeof received[0]?.databaseWorkspaceClaim).toBe('function');
    expect(host.database).toEqual({ kind: 'sqlite', path: join(root, 'database.sqlite') });
    expect(await Bun.file(join(elsewhere, 'database.sqlite')).exists()).toBe(false);
  });
});

const REMOTE_SHAPED = { sharedBetweenInstances: true, personalMachine: false } as const;
const LOCAL_SHAPED = { sharedBetweenInstances: false, personalMachine: true } as const;
const SECRET_KEYS = [APPROVAL_SECRET_KEY, DELEGATION_SECRET_KEY, ANSWER_ENCRYPTION_KEY] as const;

describe('the secrets the host generates', () => {
  test('are generated and written when the deployment secrets are writable, whatever the capabilities', async () => {
    const root = await scratch('interborough-capabilities-home-');
    const { openHome, writes, secrets } = openReporting(root, {
      capabilities: REMOTE_SHAPED,
      writable: true,
    });

    await start({ environment: { INTERBOROUGH_HOME: root }, openHome });

    expect([...writes].toSorted()).toEqual([...SECRET_KEYS].toSorted());
    for (const key of SECRET_KEYS) expect(secrets.get(key)).toBeString();
  });

  for (const missing of SECRET_KEYS) {
    test(`${missing} is a refusal naming its location when the store is not writable, whatever the capabilities`, async () => {
      const root = await scratch('interborough-capabilities-home-');
      // The host reads the approval secret, then the delegation secret, then the answer key, so
      // the secrets before `missing` are present and `missing` is the first one the host lacks.
      const earlier = SECRET_KEYS.slice(0, SECRET_KEYS.indexOf(missing));
      const { openHome, writes } = openReporting(root, {
        capabilities: LOCAL_SHAPED,
        writable: false,
        secrets: new Map(earlier.map((key) => [key, 'a-secret-that-is-already-set'])),
      });
      const location = await openBungalow({
        name: 'interborough',
        environment: { INTERBOROUGH_HOME: root },
      }).then((home) => {
        const text = home.deploymentSecrets.location(missing);
        home.close();
        return text;
      });

      const failure = await failureOf({ environment: { INTERBOROUGH_HOME: root }, openHome });

      expect(failure.message).toContain(`${location} is not set. Remote mode needs it`);
      expect(writes).toEqual([]);
    });
  }
});

describe('the settings the host holds', () => {
  test('are held when the home is shared between instances, and only then', async () => {
    const shared = await scratch('interborough-capabilities-home-');
    const sharedHost = await start({
      environment: { INTERBOROUGH_HOME: shared },
      openHome: openReporting(shared, { capabilities: REMOTE_SHAPED, writable: true }).openHome,
    });
    const alone = await scratch('interborough-capabilities-home-');
    const aloneHost = await start({
      environment: { INTERBOROUGH_HOME: alone },
      openHome: openReporting(alone, {
        capabilities: { sharedBetweenInstances: false, personalMachine: false },
        writable: true,
      }).openHome,
    });

    const lockedKey = 'durableOwnership.ownership';
    const sharedSnapshot = await sharedHost.bureau.settings.get();
    const aloneSnapshot = await aloneHost.bureau.settings.get();
    expect(sharedSnapshot.keys[lockedKey]?.locked).toBe(true);
    expect(aloneSnapshot.keys[lockedKey]?.locked).toBe(false);
  });
});

describe('the tables the host is given', () => {
  test('the database table decides the storage, and what the host reports of where the state lives', async () => {
    const root = await scratch('interborough-capabilities-home-');
    const calls: string[] = [];
    const sqlite = DEFAULT_DATABASE_KINDS['sqlite']!;
    const databaseKinds: DatabaseKinds = {
      sqlite: {
        createStorage: (database, now) => {
          calls.push('createStorage');
          return sqlite.createStorage(database, now);
        },
        redact: (database) => {
          calls.push('redact');
          return sqlite.redact(database);
        },
        describeState: () => 'a table entry that says where the state lives',
      },
    };

    const host = await start({ environment: { INTERBOROUGH_HOME: root }, databaseKinds });

    expect(calls).toContain('createStorage');
    expect(calls).toContain('redact');
    expect(host.stateDescription).toBe('a table entry that says where the state lives');
    expect(host.database).toEqual({ kind: 'sqlite', path: join(root, 'database.sqlite') });
  });

  test('the default tables say where a local home lives', async () => {
    const root = await scratch('interborough-capabilities-home-');

    const host = await start({ environment: { INTERBOROUGH_HOME: root } });

    expect(host.stateDescription).toBe(dirname(join(root, 'database.sqlite')));
  });

  test('the content table decides the agent and workflow sources and the plugin folder', async () => {
    const root = await scratch('interborough-capabilities-home-');
    const calls: string[] = [];
    const directory = DEFAULT_CONTENT_KINDS['directory']!;
    const contentKinds: ContentKinds = {
      directory: {
        ...directory,
        createAgentSource: (bungalow, content, tools, options) => {
          calls.push('agents');
          return directory.createAgentSource(bungalow, content, tools, options);
        },
        createWorkflowSource: (bungalow, content, options) => {
          calls.push('workflows');
          return directory.createWorkflowSource(bungalow, content, options);
        },
        localDirectory: (content) => {
          calls.push('localDirectory');
          return directory.localDirectory(content);
        },
        describe: (content) => {
          calls.push('describe');
          return directory.describe(content);
        },
      },
    };

    const host = await start({ environment: { INTERBOROUGH_HOME: root }, contentKinds });
    const response = await fetch(new URL('/host/paths', host.url));
    const paths = (await response.json()) as { agentDirectory: string };

    expect(calls).toEqual(expect.arrayContaining(['agents', 'workflows', 'localDirectory']));
    expect(calls).toContain('describe');
    expect(paths.agentDirectory).toBe(join(root, 'agents'));
  });
});
