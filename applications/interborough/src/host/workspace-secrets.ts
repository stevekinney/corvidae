import { createHash, randomUUID } from 'node:crypto';

import {
  parseSecretReference,
  SecretProviderError,
  type Bungalow,
  type ConfigurationSnapshot,
  type ConfigurationWriteResult,
  type SecretOperationMetadata,
} from '@lostgradient/bungalow';

/** Reserved host configuration field: only committed references activate managed secrets. */
export const SECRET_BINDINGS_FIELD = 'secretBindings';

/** Storage dependencies shared by host managers and external-provider conformance fixtures. */
export type SecretHome = Pick<
  Bungalow,
  | 'workspaceId'
  | 'secretProvider'
  | 'readConfiguration'
  | 'writeConfiguration'
  | 'configurationWriteCapability'
  | 'configurationLocation'
>;

/** One credential and its complete configuration candidate, computed from the same snapshot. */
export type SecretPublication = {
  /** Stable idempotency identifier for this exact publication. */
  readonly operationId: string;
  /** Logical credential key within this workspace. */
  readonly key: string;
  /** Private value prepared before configuration activation. */
  readonly value: string;
  /** Complete candidate configuration derived from the expected revision. */
  readonly document: Readonly<Record<string, unknown>>;
  /** Opaque configuration revision, or explicit absence. */
  readonly expectedRevision: string | null;
};

/** Redacted recovery evidence; never contains values, configuration text, or backend exceptions. */
export type PendingSecretOperation = Pick<SecretOperationMetadata, 'id' | 'state'>;

/** Publication evidence without configuration text or credential values. */
export type SecretPublicationResult = ConfigurationWriteResult & {
  readonly configurationHash?: string;
};

/** A failed publication preserves whether the configuration backend definitely rejected it. */
export class SecretPublicationError extends SecretProviderError {
  /** True only when the backend guarantees this publication did not commit. */
  readonly definitelyRejected: boolean;
  constructor(outcome: Exclude<ConfigurationWriteResult['outcome'], 'committed'>) {
    super(
      outcome === 'conflict' ? 'conflict' : outcome === 'read-only' ? 'read-only' : 'unavailable',
      'The secret publication did not return a committed result. Reload before retrying.',
    );
    this.definitelyRejected = outcome !== 'unknown';
  }
}

/** Host-owned activation and recovery over a workspace-bound provider and configuration CAS. */
export type WorkspaceSecrets = {
  /** Whether both backends support conditional credential publication. */
  readonly writable: boolean;
  /** Read the exact committed binding, or the legacy value when unbound. */
  read(key: string, snapshot?: ConfigurationSnapshot): Promise<string | undefined>;
  /** Prepare and conditionally activate one immutable secret version. */
  publish(publication: SecretPublication): Promise<SecretPublicationResult>;
  /** Publish a credential while preserving the current configuration. */
  write(key: string, value: string, operationId?: string): Promise<void>;
  /** Recover operation metadata against committed bindings without replaying writes. */
  reconcile(): Promise<readonly PendingSecretOperation[]>;
  /** Return redacted operations whose outcome still needs recovery. */
  pending(): readonly PendingSecretOperation[];
};

function isDocument(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function documentOf(snapshot: ConfigurationSnapshot): Record<string, unknown> {
  let document: unknown;
  try {
    document = snapshot.text === undefined ? {} : JSON.parse(snapshot.text);
  } catch {
    throw new SecretProviderError('rejected', 'The configuration cannot bind secret versions.');
  }
  if (!isDocument(document)) {
    throw new SecretProviderError('rejected', 'The configuration must be an object.');
  }
  return document;
}

function bindingsOf(
  document: Readonly<Record<string, unknown>>,
  workspaceId: string,
): Record<string, string> {
  const candidate = document[SECRET_BINDINGS_FIELD];
  if (candidate === undefined) return {};
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new SecretProviderError('rejected', 'The secret bindings are invalid.');
  }
  const bindings: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value !== 'string' || parseSecretReference(value, workspaceId).key !== key) {
      throw new SecretProviderError('rejected', 'A secret binding is invalid.');
    }
    Object.defineProperty(bindings, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return bindings;
}

async function providerCall<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    const code = error instanceof SecretProviderError ? error.code : 'unavailable';
    throw new SecretProviderError(code, 'The secret provider could not complete the operation.');
  }
}

function assertOperation(
  operation: SecretOperationMetadata,
  input: Pick<SecretPublication, 'operationId' | 'key' | 'expectedRevision'>,
  workspaceId: string,
): void {
  const reference = parseSecretReference(operation.reference, workspaceId);
  if (
    operation.id !== input.operationId ||
    operation.workspaceId !== workspaceId ||
    operation.key !== input.key ||
    reference.key !== input.key ||
    operation.expectedRevision !== input.expectedRevision ||
    !['prepared', 'publishing', 'published', 'abandoned', 'unknown'].includes(operation.state)
  ) {
    throw new SecretProviderError('rejected', 'The provider returned an invalid secret operation.');
  }
}

/** Create one host's secret resolver; provider storage, rather than this object, arbitrates races. */
export function createWorkspaceSecrets(home: SecretHome): WorkspaceSecrets {
  const provider = home.secretProvider;
  const workspaceId = home.workspaceId;
  if (provider.workspaceId !== workspaceId) {
    throw new SecretProviderError('rejected', 'The secret provider belongs to another workspace.');
  }
  const writable =
    provider.capabilities.prepare &&
    provider.capabilities.transitions &&
    home.configurationWriteCapability === 'writable';
  let pending: readonly PendingSecretOperation[] = [];

  const active = async (operation: SecretOperationMetadata): Promise<boolean> => {
    const bindings = bindingsOf(documentOf(await home.readConfiguration()), workspaceId);
    const reference = parseSecretReference(operation.reference, workspaceId);
    return bindings[reference.key] === reference.serialized;
  };

  async function reconcileOperation(operation: SecretOperationMetadata): Promise<boolean> {
    if (operation.state === 'published') return true;
    if (operation.state === 'abandoned' || operation.state === 'prepared') return false;
    if (await active(operation)) {
      // Configuration is authoritative even if the provider cannot acknowledge publication.
      try {
        await provider.transitionOperation(operation.id, {
          from: operation.state,
          to: 'published',
        });
      } catch {
        pending = [
          ...pending.filter((item) => item.id !== operation.id),
          { id: operation.id, state: operation.state },
        ];
      }
      return true;
    }
    if (operation.state === 'publishing') {
      try {
        await provider.transitionOperation(operation.id, { from: 'publishing', to: 'unknown' });
      } catch {
        // Another caller or a failed acknowledgement cannot justify retrying publication.
      }
    }
    return false;
  }

  const manager: WorkspaceSecrets = {
    writable,
    async read(key, snapshot) {
      const bindings = bindingsOf(
        documentOf(snapshot ?? (await home.readConfiguration())),
        workspaceId,
      );
      const reference = Object.hasOwn(bindings, key) ? bindings[key] : undefined;
      return providerCall(() =>
        reference === undefined ? provider.readLegacy(key) : provider.readVersion(reference),
      );
    },
    async publish(input) {
      // Caller-owned mutable inputs are captured before preparation can suspend.
      const { operationId, key, value, expectedRevision } = input;
      const document: Record<string, unknown> = structuredClone(input.document);
      const bindings = bindingsOf(document, workspaceId);
      if (!writable) return { outcome: 'read-only' };
      let operation = structuredClone(
        await providerCall(() => provider.prepare({ operationId, key, value, expectedRevision })),
      );
      assertOperation(operation, { operationId, key, expectedRevision }, workspaceId);
      if (operation.state === 'abandoned') return { outcome: 'conflict' };
      if (operation.state !== 'prepared') {
        return { outcome: (await reconcileOperation(operation)) ? 'committed' : 'unknown' };
      }
      try {
        operation = structuredClone(
          await provider.transitionOperation(operationId, { from: 'prepared', to: 'publishing' }),
        );
        assertOperation(operation, { operationId, key, expectedRevision }, workspaceId);
        if (operation.state !== 'publishing')
          throw new SecretProviderError('rejected', 'The publication claim is invalid.');
      } catch {
        const standing = await providerCall(() => provider.getOperation(operationId));
        if (standing?.state === 'abandoned') return { outcome: 'conflict' };
        if (standing !== undefined && (await reconcileOperation(standing)))
          return { outcome: 'committed' };
        return { outcome: 'unknown' };
      }
      document[SECRET_BINDINGS_FIELD] = { ...bindings, [key]: operation.reference.serialized };
      const committedText = `${JSON.stringify(document, null, 2)}\n`;
      const configurationHash = createHash('sha256').update(committedText).digest('hex');
      let result: ConfigurationWriteResult;
      try {
        result = await home.writeConfiguration(committedText, {
          expectedRevision,
        });
      } catch {
        result = { outcome: 'unknown' };
      }
      const next =
        result.outcome === 'committed'
          ? 'published'
          : result.outcome === 'conflict' ||
              result.outcome === 'read-only' ||
              result.outcome === 'unsupported' ||
              result.outcome === 'unavailable'
            ? 'abandoned'
            : 'unknown';
      try {
        await provider.transitionOperation(operationId, { from: 'publishing', to: next });
      } catch {
        // Exact committed bindings still activate; unresolved metadata is recovery evidence.
        pending = [
          ...pending.filter((item) => item.id !== operationId),
          { id: operationId, state: 'publishing' },
        ];
      }
      if (next === 'unknown') {
        if (await reconcileOperation({ ...operation, state: 'unknown' }))
          return { outcome: 'committed', configurationHash };
        pending = [
          ...pending.filter((item) => item.id !== operationId),
          { id: operationId, state: 'unknown' },
        ];
        return { outcome: 'unknown' };
      }
      return result.outcome === 'committed' ? { ...result, configurationHash } : result;
    },
    async write(key, value, operationId = randomUUID()) {
      const snapshot = await home.readConfiguration();
      const result = await manager.publish({
        operationId,
        key,
        value,
        document: documentOf(snapshot),
        expectedRevision: snapshot.revision,
      });
      if (result.outcome !== 'committed') {
        throw new SecretPublicationError(result.outcome);
      }
    },
    async reconcile() {
      const unresolved: PendingSecretOperation[] = [];
      pending = [];
      for (const operation of await providerCall(() => provider.listOperations())) {
        if (operation.state === 'published') continue;
        if (operation.state === 'prepared') {
          try {
            await provider.transitionOperation(operation.id, { from: 'prepared', to: 'abandoned' });
          } catch {
            unresolved.push({ id: operation.id, state: operation.state });
            continue;
          }
        } else if (operation.state !== 'abandoned') {
          try {
            if (await reconcileOperation(operation)) continue;
          } catch {
            // An unavailable read is never evidence of a failed publication.
          }
          unresolved.push({ id: operation.id, state: 'unknown' });
          continue;
        }
        if (!(await active(operation)))
          await providerCall(() => provider.reclaim(operation.reference));
      }
      pending = [
        ...new Map(
          [...pending, ...unresolved].map((operation) => [operation.id, operation]),
        ).values(),
      ];
      return manager.pending();
    },
    pending: () => pending.map((operation) => ({ ...operation })),
  };
  return manager;
}
