import { type ManualRuntimeServices, createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage } from '@lostgradient/storage';

import { createWeftMemoryRecordStorage } from '../../src/create-weft-memory-record-storage';
import {
  type MemoryAuthority,
  type MemoryCapability,
  type MemoryPrincipalKind,
  type MemoryProjection,
  createMemoryAuthority,
} from '../../src/governance/authority';
import { createGovernedMemory } from '../../src/governance/governed-memory';
import type {
  CreateGovernedMemoryOptions,
  GovernedMemory,
  MemoryDeletionResult,
  MemoryGovernanceNotification,
  MemoryWriteReceipt,
} from '../../src/governance/governed-memory-types';
import {
  type MemoryGovernanceLedger,
  createMemoryGovernanceLedger,
} from '../../src/governance/ledger';
import type { MemoryDeletionReceipt } from '../../src/governance/ledger-types';
import {
  type CreateMemoryGovernancePolicyInput,
  createMemoryGovernancePolicy,
} from '../../src/governance/policy';
import type { MemoryRecordStorage } from '../../src/memory-record-storage';
import { createMemoryVectorStore } from '../../src/memory-vector-store';
import {
  createInMemoryMemoryRecordStorage,
  createMockEmbedder,
  createTestEmbedders,
} from '../../src/test/index';

export const ORIGIN = '2026-01-01T00:00:00.000Z';
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export const OPERATION_CAPABILITIES: readonly MemoryCapability[] = [
  'memory:list',
  'memory:get',
  'memory:search',
  'memory:write',
  'memory:promote',
  'memory:share',
  'memory:export',
  'memory:quarantine',
  'memory:revoke',
  'memory:delete',
];

export type GovernedBackend = 'in-memory' | 'weft';

export interface GovernedFixture {
  readonly backend: GovernedBackend;
  readonly runtime: ManualRuntimeServices;
  readonly memory: GovernedMemory;
  readonly ledger: MemoryGovernanceLedger;
  readonly storage: MemoryRecordStorage;
  /** The durable Weft storage the ledger (and, on the Weft backend, the records) live in. */
  readonly durable: MemoryStorage;
  readonly notifications: MemoryGovernanceNotification[];
  /** A new governed memory over the same durable state, as a restarted process would build. */
  restart(overrides?: Partial<CreateGovernedMemoryOptions>): GovernedMemory;
}

export interface FixtureOptions {
  readonly policy?: Omit<CreateMemoryGovernancePolicyInput, 'revision'> & { revision?: string };
  readonly governed?: Partial<Omit<CreateGovernedMemoryOptions, 'storage' | 'ledger' | 'runtime'>>;
}

export async function createGovernedFixture(
  backend: GovernedBackend,
  options: FixtureOptions = {},
): Promise<GovernedFixture> {
  const runtime = createManualRuntimeServices({
    origin: ORIGIN,
    identifierSeed: `governed-${backend}`,
  });
  const durable = new MemoryStorage();
  const storage =
    backend === 'weft'
      ? createWeftMemoryRecordStorage(durable, { runtime })
      : createInMemoryMemoryRecordStorage({ now: () => runtime.clock.now() });
  const ledger = createMemoryGovernanceLedger(durable);
  const notifications: MemoryGovernanceNotification[] = [];
  const policy = createMemoryGovernancePolicy({ revision: 'governance:1', ...options.policy });
  // Over the durable storage, so a restarted memory finds the vectors the first one wrote.
  const vectors = createMemoryVectorStore(durable);
  const build = (overrides: Partial<CreateGovernedMemoryOptions> = {}) =>
    createGovernedMemory({
      storage,
      ledger,
      ...createTestEmbedders(createMockEmbedder(64), 64),
      vectors,
      policy,
      runtime,
      propagation: {
        caches: 'not-retained',
        'managed-asset-bytes': 'not-retained',
        'durable-snapshots': 'not-retained',
        'external-processors': 'not-retained',
      },
      onEvent: (notification) => {
        notifications.push(notification);
      },
      ...options.governed,
      ...overrides,
    });
  const memory = build();
  await memory.init();
  return { backend, runtime, memory, ledger, storage, durable, notifications, restart: build };
}

export function authority(
  overrides: {
    tenantId?: string;
    ownerId?: string;
    kind?: MemoryPrincipalKind;
    principalId?: string;
    capabilities?: readonly MemoryCapability[];
    projection?: MemoryProjection;
  } = {},
): MemoryAuthority {
  const ownerId = overrides.ownerId ?? 'owner-a';
  return createMemoryAuthority({
    principal: {
      kind: overrides.kind ?? 'user',
      id: overrides.principalId ?? `${ownerId}:principal`,
    },
    tenantId: overrides.tenantId ?? 'tenant-a',
    ownerId,
    purpose: 'contract-test',
    capabilities: overrides.capabilities ?? OPERATION_CAPABILITIES,
    policyRevision: 'authorization:1',
    projection: overrides.projection ?? 'bureau',
  });
}

/** Owner A and owner B in tenant A, and an owner with A's id in tenant B. */
export const principalA = authority();
export const principalB = authority({ ownerId: 'owner-b' });
export const tenantBPrincipal = authority({ tenantId: 'tenant-b' });

export const governancePrincipal = authority({
  ownerId: 'governance-office',
  kind: 'governance',
  principalId: 'governance:counsel',
  capabilities: [
    ...OPERATION_CAPABILITIES,
    'memory:legal-hold',
    'memory:inspect',
    'memory:retention',
  ],
  projection: 'administrative',
});

/**
 * The platform's policy administrator: the only principal that may change the
 * instance-wide governance policy every tenant runs under.
 */
export const platformGovernance = authority({
  tenantId: 'platform',
  ownerId: 'platform-governance',
  kind: 'governance',
  principalId: 'governance:platform',
  capabilities: ['memory:policy', 'memory:inspect'],
  projection: 'administrative',
});

export const retentionService = authority({
  ownerId: 'retention',
  kind: 'service',
  principalId: 'service:retention',
  capabilities: ['memory:delete', 'memory:retention'],
  projection: 'administrative',
});

/**
 * An authority assembled around validation: `parent`'s chain extended by an
 * actor that merely declares `kind`. Governed memory must grant it nothing its
 * delegation chain does not.
 */
export function forgeActor(parent: MemoryAuthority, kind: MemoryPrincipalKind): MemoryAuthority {
  const principal = { kind, id: `forged:${kind}` };
  return {
    ...parent,
    principal,
    delegationChain: [...parent.delegationChain, { principal, capabilities: parent.capabilities }],
  };
}

/** The id a write stored, failing the test when the write stored nothing. */
export async function recordIdOf(pending: Promise<MemoryWriteReceipt>): Promise<string> {
  const receipt = await pending;
  if (receipt.recordId === undefined) throw new Error(`The write was ${receipt.status}.`);
  return receipt.recordId;
}

/** The receipt a deletion produced, failing the test when it produced none. */
export async function receiptOf(
  pending: Promise<MemoryDeletionResult>,
): Promise<MemoryDeletionReceipt> {
  const result = await pending;
  if (result.receipt === undefined) throw new Error(`The deletion was ${result.status}.`);
  return result.receipt;
}
