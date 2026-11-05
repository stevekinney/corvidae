import {
  parseSecretReference,
  type ConfigurationWriteCondition,
  type ConfigurationWriteResult,
  type PrepareSecretInput,
  type SecretOperationMetadata,
  type SecretOperationState,
  type SecretOperationTransition,
  type SecretProvider,
} from '@lostgradient/bungalow';
/**
 * A home that holds its configuration and secrets in memory and fails the way a test says, for the
 * tool-source manager tests (COR-1930).
 */
import type { AnswerEncryptionKeys } from '@lostgradient/bureau';
import { generateEncryptionKey } from '@lostgradient/cryptography';

/** How a configuration write fails. */
export type Failure = 'none' | 'before-replacing' | 'after-replacing' | 'unknown-before-replacing';

export function fixtureSecretProvider(
  workspaceId: string,
  state: {
    readonly secrets: Map<string, string>;
    readonly versions?: Map<string, string>;
    secretWrites?: number;
    secretWritesBeforeFailing?: number;
  },
  writable: boolean,
): SecretProvider {
  const versions = state.versions ?? new Map<string, string>();
  const operations = new Map<string, SecretOperationMetadata>();
  const reference = (key: string, version: string) => {
    const serialized = `bungalow-secret-v1.${Buffer.from(JSON.stringify([workspaceId, key, version])).toString('base64url')}`;
    return { serialized, workspaceId, key, version };
  };
  const operation = (
    input: PrepareSecretInput,
    version: string,
    current: SecretOperationState = 'prepared',
  ) => ({
    id: input.operationId,
    workspaceId,
    key: input.key,
    reference: reference(input.key, version),
    expectedRevision: input.expectedRevision,
    state: current,
  });
  return {
    workspaceId,
    capabilities: { read: true, prepare: writable, transitions: writable },
    readLegacy: async (key) => state.secrets.get(key),
    readVersion: async (value) => {
      const parsed = parseSecretReference(value, workspaceId);
      const secret = versions.get(parsed.version);
      if (secret === undefined) throw new Error('missing fixture version');
      return secret;
    },
    prepare: async (input) => {
      if (state.secretWrites !== undefined) state.secretWrites += 1;
      if (
        state.secretWritesBeforeFailing !== undefined &&
        state.secretWrites !== undefined &&
        state.secretWrites > state.secretWritesBeforeFailing
      )
        throw new Error('secret disk full');
      const existing = operations.get(input.operationId);
      if (existing !== undefined) {
        const previous = versions.get(existing.reference.version);
        if (
          existing.key !== input.key ||
          existing.expectedRevision !== input.expectedRevision ||
          previous !== input.value
        ) {
          throw new Error('fixture operation conflict');
        }
        return existing;
      }
      if (!writable) throw new Error('fixture provider is read-only');
      const version = `version-${operations.size + 1}`;
      versions.set(version, input.value);
      const created = operation(input, version);
      operations.set(input.operationId, created);
      return created;
    },
    getOperation: async (id) => operations.get(id),
    listOperations: async () => [...operations.values()],
    transitionOperation: async (id, transition: SecretOperationTransition) => {
      const current = operations.get(id);
      if (current === undefined || current.state !== transition.from)
        throw new Error('fixture transition conflict');
      const next = { ...current, state: transition.to };
      operations.set(id, next);
      return next;
    },
    reclaim: async (value) => {
      const parsed = parseSecretReference(value, workspaceId);
      const owner = [...operations.values()].find(
        (entry) => entry.reference.version === parsed.version,
      );
      if (owner !== undefined && owner.state !== 'abandoned')
        throw new Error('fixture version is still referenced');
      versions.delete(parsed.version);
    },
  };
}

/** A home that holds its configuration and secrets in memory and fails the way a test says. */
export function memoryHome(mode: 'local' | 'remote' = 'local') {
  const state = {
    configuration: undefined as string | undefined,
    secrets: new Map<string, string>(),
    versions: new Map<string, string>(),
    configurationFailure: 'none' as Failure,
    secretWritesBeforeFailing: Number.POSITIVE_INFINITY,
    secretWrites: 0,
  };
  const workspaceId = 'fixture-workspace';
  const bungalow = {
    mode,
    workspaceId,
    secretProvider: fixtureSecretProvider(workspaceId, state, mode === 'local'),
    configurationWriteCapability: mode === 'local' ? ('writable' as const) : ('read-only' as const),
    configurationLocation: '/home/configuration.json',
    readConfiguration: async () => ({
      text: state.configuration,
      revision: state.configuration === undefined ? null : Bun.hash(state.configuration).toString(),
    }),
    writeConfiguration: async (
      text: string,
      condition: ConfigurationWriteCondition,
    ): Promise<ConfigurationWriteResult> => {
      if (
        condition.expectedRevision !==
        (state.configuration === undefined ? null : Bun.hash(state.configuration).toString())
      )
        return { outcome: 'conflict' };
      if (state.configurationFailure === 'before-replacing') return { outcome: 'unavailable' };
      if (state.configurationFailure === 'unknown-before-replacing') return { outcome: 'unknown' };
      state.configuration = text;
      if (state.configurationFailure === 'after-replacing') return { outcome: 'unknown' };
      return { outcome: 'committed' };
    },
    deploymentSecrets: {
      read: async (key: string) => state.secrets.get(key),
      write: async (key: string, value: string) => {
        state.secretWrites += 1;
        if (state.secretWrites > state.secretWritesBeforeFailing)
          throw new Error('secret disk full');
        state.secrets.set(key, value);
      },
      location: (key: string) => `/home/secrets/${key}`,
    },
  };
  return { state, bungalow };
}

export async function keysOf(): Promise<AnswerEncryptionKeys> {
  return { current: await generateEncryptionKey() };
}

/** Resolve the exact committed fixture version; never substitute a prepared or legacy value. */
export function activeFixtureSecret(home: ReturnType<typeof memoryHome>, key: string) {
  const document = JSON.parse(home.state.configuration ?? '{}') as {
    secretBindings?: Record<string, string>;
  };
  const binding = document.secretBindings?.[key];
  if (binding === undefined) throw new Error('Expected a published fixture secret binding');
  const reference = parseSecretReference(binding, home.bungalow.workspaceId);
  if (reference.key !== key) throw new Error('Wrong fixture secret key');
  const value = home.state.versions.get(reference.version);
  if (value === undefined) throw new Error('Missing active fixture version');
  return { reference, value };
}
