/**
 * COR-2468: a location's storage, definition sources and description come from a table keyed by
 * its kind, so a new kind is one entry, and a kind with no entry is an error that quotes no credential.
 */
import type { Bungalow, ContentLocation, DatabaseLocation } from '@lostgradient/bungalow';
import type {
  AgentSource,
  GuardrailSource,
  ValidatorSource,
  WorkflowSource,
} from '@lostgradient/bureau/sources';
import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_CONTENT_KINDS,
  DEFAULT_DATABASE_KINDS,
  createAgentSource,
  createGuardrailSource,
  createHostStorage,
  createValidatorSource,
  createWorkflowSource,
  describeContent,
  describeDatabaseState,
  localContentDirectory,
  redactDatabase,
  type ContentKinds,
  type DatabaseKinds,
} from './locations.ts';

const CREDENTIAL = 'hunter2-the-database-password';

/** A location of a kind Bungalow does not have, built with a cast. */
const extraDatabase = {
  kind: 'extra',
  url: `extra://user:${CREDENTIAL}@host/db`,
} as unknown as DatabaseLocation;
const extraContent = { kind: 'extra', token: CREDENTIAL } as unknown as ContentLocation;

/** The message of the error `use` throws; a call that does not throw fails the test. */
function messageOf(use: () => unknown): string {
  try {
    use();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('The call did not throw.');
}

describe('the default tables', () => {
  test('hold an entry for sqlite, postgres, directory and s3, and no other', () => {
    expect(Object.keys(DEFAULT_DATABASE_KINDS).toSorted()).toEqual(['postgres', 'sqlite']);
    expect(Object.keys(DEFAULT_CONTENT_KINDS).toSorted()).toEqual(['directory', 's3']);
  });

  test('say where each kind of state lives, with no credential', () => {
    expect(
      describeDatabaseState({ kind: 'sqlite', path: '/home/interborough/database.sqlite' }),
    ).toBe('/home/interborough');
    expect(
      describeDatabaseState({ kind: 'postgres', url: `postgresql://user:${CREDENTIAL}@db/x` }),
    ).toBe('the configured Postgres database');
  });

  test('name the local directory of a directory, and none for a bucket', () => {
    expect(localContentDirectory({ kind: 'directory', path: '/home/agents' })).toBe('/home/agents');
    expect(
      localContentDirectory({ kind: 's3', bucket: 'state', prefix: 'agents/' }),
    ).toBeUndefined();
  });

  test('refuse a bucket location with no S3 client, as before', () => {
    const home = { s3Client: () => undefined } as unknown as Bungalow;
    const content = { kind: 's3', bucket: 'state', prefix: 'agents/' } as const;
    expect(() => createAgentSource(home, content, {})).toThrow('no S3 client');
    expect(() => createWorkflowSource(home, content)).toThrow('no S3 client');
  });
});

describe('a table that holds an extra kind', () => {
  test('opens the storage with the entry’s factory, given the location and the clock', () => {
    const storage = new MemoryStorage();
    const calls: unknown[] = [];
    const kinds: DatabaseKinds = {
      extra: {
        createStorage: (database, now) => {
          calls.push([database, now]);
          return storage;
        },
        redact: () => ({ kind: 'sqlite', path: '/redacted' }),
        describeState: () => 'the extra database',
      },
    };
    const clock = () => 7;

    expect(createHostStorage(extraDatabase, clock, kinds)).toBe(storage);
    expect(calls).toEqual([[extraDatabase, clock]]);
    expect(redactDatabase(extraDatabase, kinds)).toEqual({ kind: 'sqlite', path: '/redacted' });
    expect(describeDatabaseState(extraDatabase, kinds)).toBe('the extra database');
    storage[Symbol.dispose]();
  });

  test('builds the agent and workflow sources with the entry’s factories', () => {
    const agents = { kind: 'agent' } as unknown as AgentSource;
    const workflows = { kind: 'workflow' } as unknown as WorkflowSource;
    const validators = { kind: 'validator' } as unknown as ValidatorSource;
    const guardrails = { kind: 'guardrail' } as unknown as GuardrailSource;
    const received: unknown[] = [];
    const kinds: ContentKinds = {
      extra: {
        createAgentSource: (_bungalow, content, tools, directory) => {
          received.push(['agents', content, tools, directory]);
          return agents;
        },
        createWorkflowSource: (_bungalow, content, directory) => {
          received.push(['workflows', content, directory]);
          return workflows;
        },
        createValidatorSource: (_bungalow, content, directory) => {
          received.push(['validators', content, directory]);
          return validators;
        },
        createGuardrailSource: (_bungalow, content, directory) => {
          received.push(['guardrails', content, directory]);
          return guardrails;
        },
        describe: () => 'the extra content',
        localDirectory: () => '/where/it/is',
      },
    };
    const home = {} as Bungalow;
    const tools = {};

    expect(createAgentSource(home, extraContent, tools, { watch: false }, kinds)).toBe(agents);
    expect(createWorkflowSource(home, extraContent, { watch: 'poll' }, kinds)).toBe(workflows);
    expect(createValidatorSource(home, extraContent, { watch: 'poll' }, kinds)).toBe(validators);
    expect(createGuardrailSource(home, extraContent, { watch: 'poll' }, kinds)).toBe(guardrails);
    expect(received).toEqual([
      ['agents', extraContent, tools, { watch: false }],
      ['workflows', extraContent, { watch: 'poll' }],
      ['validators', extraContent, { watch: 'poll' }],
      ['guardrails', extraContent, { watch: 'poll' }],
    ]);
    expect(describeContent(extraContent, kinds)).toBe('the extra content');
    expect(localContentDirectory(extraContent, kinds)).toBe('/where/it/is');
  });
});

describe('a location whose kind has no entry', () => {
  const home = {} as Bungalow;

  test('is an error that names the kind and no credential, for each use of a database', () => {
    for (const use of [
      () => createHostStorage(extraDatabase),
      () => redactDatabase(extraDatabase),
      () => describeDatabaseState(extraDatabase),
    ]) {
      const message = messageOf(use);
      expect(message).toContain('"extra"');
      expect(message).not.toContain(CREDENTIAL);
    }
  });

  test('is an error that names the kind and no credential, for each use of content', () => {
    for (const use of [
      () => createAgentSource(home, extraContent, {}),
      () => createWorkflowSource(home, extraContent),
      () => describeContent(extraContent),
      () => localContentDirectory(extraContent),
    ]) {
      const message = messageOf(use);
      expect(message).toContain('"extra"');
      expect(message).not.toContain(CREDENTIAL);
    }
  });

  test('is never read from an inherited key of the table', () => {
    const inherited = { kind: 'toString', path: '/x' } as unknown as DatabaseLocation;
    expect(() => createHostStorage(inherited)).toThrow('"toString"');
  });

  test('an unreadable Postgres URL is still an error that quotes no part of it', () => {
    const message = messageOf(() =>
      redactDatabase({ kind: 'postgres', url: `not a url ${CREDENTIAL}` }),
    );
    expect(message).toContain('not a valid URL');
    expect(message).not.toContain(CREDENTIAL);
  });
});
