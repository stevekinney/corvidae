import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';

import { HASHING_EMBEDDER_ID } from '../embedder-registry';
import { createDeletionEngine } from './deletion';
import { settlePendingDerivations } from './derivation';
import {
  advanceSwitch,
  cancelSwitch,
  DEFAULT_SWITCH_STEP_LIMIT,
  switchEmbedder,
} from './embedding-switch';
import { createGovernanceContext } from './governance-context';
import {
  createPolicyHistory,
  expireWorkingMemory,
  readDeletionReceipt,
  readEvents,
  sweepRetention,
} from './governed-administration';
import { createGovernedEmbedding } from './governed-embedding';
import { deleteLocated, forget } from './governed-forgetting';
import type {
  CreateGovernedMemoryOptions,
  GovernedMemory,
  MemoryGovernanceNotification,
} from './governed-memory-types';
import { exportRecords, getRecord, listRecords, searchRecords } from './governed-reads';
import { recallForModel } from './governed-recall';
import {
  changeLegalHold,
  changeShare,
  promoteRecord,
  quarantineRecord,
  revokeRecord,
} from './governed-transitions';
import { admitWrite } from './governed-writes';
import { copyInlineVectors } from './profile-vectors';

/**
 * Hands `notification` to each listener registered when delivery starts, in order. A listener that
 * throws, or returns a promise that rejects, is reported and skipped over: the governed call that
 * raised the notification has already committed, and a later listener still hears it.
 */
function notifyListeners(
  listeners: ReadonlySet<(notification: MemoryGovernanceNotification) => unknown>,
  notification: MemoryGovernanceNotification,
): void {
  for (const listener of Array.from(listeners)) {
    // One removed by an earlier listener in this very delivery is not called.
    if (!listeners.has(listener)) continue;
    try {
      const outcome = listener(notification);
      if (outcome instanceof Promise) outcome.catch(reportListenerFailure);
    } catch (error) {
      reportListenerFailure(error);
    }
  }
}

function reportListenerFailure(error: unknown): void {
  console.error('[memory] A governance listener threw:', error);
}

/**
 * Creates principal-aware, governed memory: the one surface Bureau, Agent,
 * child, tool, A2A, MCP, audit, and administrative projections use. Every
 * operation takes a {@link MemoryAuthority}, is decided by the shared resource
 * predicate, and is attributed in the durable governance ledger. The record
 * storage must belong to this instance alone and must support atomic
 * `deleteMany`; governance defaults fail closed.
 */
export function createGovernedMemory(options: CreateGovernedMemoryOptions): GovernedMemory {
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const listeners = new Set<(notification: MemoryGovernanceNotification) => unknown>();
  const policies = createPolicyHistory(() => context, options.policy);
  const embedding = createGovernedEmbedding({
    registry: options.embedders,
    vectors: options.vectors,
    initialEmbedder: options.initialEmbedder ?? HASHING_EMBEDDER_ID,
  });
  const context = createGovernanceContext({
    storage: options.storage,
    ledger: options.ledger,
    embedding,
    textSearchProvider: options.textSearchProvider,
    runtime,
    propagation: options.propagation ?? {},
    policy: () => policies.current(),
    onEvent: async (notification) => {
      try {
        await options.onEvent?.(notification);
      } finally {
        // The event is in the ledger whether or not `onEvent` took it, so subscribers hear it.
        notifyListeners(listeners, notification);
      }
    },
  });
  const governance = context;
  const deletion = createDeletionEngine(governance);
  // One step of the switch at a time in this process, shared by every caller that arrives while it runs.
  let advancing: Promise<void> | undefined;

  return {
    get policyRevision() {
      return policies.current().revision;
    },
    embedding: {
      status: () => embedding.status(),
      availability: (id) => embedding.availability(id),
      switchTo: (id) => switchEmbedder(governance, id),
      cancel: () => cancelSwitch(governance),
      async advance(advanceOptions) {
        advancing ??= advanceSwitch(
          governance,
          advanceOptions?.limit ?? DEFAULT_SWITCH_STEP_LIMIT,
        ).finally(() => {
          advancing = undefined;
        });
        await advancing;
        return embedding.status();
      },
    },
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('GovernedMemory.subscribe requires a listener function.');
      }
      // A function registered twice is two registrations, each with its own unsubscribe.
      const registration = (notification: MemoryGovernanceNotification): unknown =>
        listener(notification);
      listeners.add(registration);
      return () => {
        listeners.delete(registration);
      };
    },
    async init() {
      await options.storage.init();
      await options.textSearchProvider?.init();
      // Records stored before COR-1898 held their vector inline; recall reads only the profile's.
      await copyInlineVectors(governance);
    },
    async close() {
      await options.storage.close();
      await options.textSearchProvider?.close();
    },
    write: (authority, content, writeOptions) =>
      admitWrite(governance, authority, content, writeOptions),
    get: (authority, locator) => getRecord(governance, authority, locator),
    list: (authority, listOptions) => listRecords(governance, authority, listOptions),
    search: (authority, query, searchOptions) =>
      searchRecords(governance, authority, query, searchOptions),
    recallForModel: (authority, query, recallOptions) =>
      recallForModel(governance, authority, query, recallOptions),
    promote: (authority, locator, promoteOptions) =>
      promoteRecord(governance, authority, locator, promoteOptions),
    share: (authority, locator, grantee) =>
      changeShare(governance, authority, locator, grantee, true),
    revokeShare: (authority, locator, grantee) =>
      changeShare(governance, authority, locator, grantee, false),
    export: (authority, exportOptions) => exportRecords(governance, authority, exportOptions),
    quarantine: (authority, locator, reason) =>
      quarantineRecord(governance, authority, locator, reason),
    revoke: (authority, locator, reason) => revokeRecord(governance, authority, locator, reason),
    delete: (authority, locator) => deleteLocated(governance, deletion, authority, locator),
    forget: (authority, request) => forget(governance, deletion, authority, request),
    placeLegalHold: (authority, locator) =>
      changeLegalHold(governance, deletion, authority, locator, true),
    releaseLegalHold: (authority, locator) =>
      changeLegalHold(governance, deletion, authority, locator, false),
    expireWorkingMemory: (authority, runId) =>
      expireWorkingMemory(governance, deletion, authority, runId),
    sweepRetention: (authority, sweepOptions) =>
      sweepRetention(governance, deletion, authority, sweepOptions),
    activatePolicy: (authority, policy) => policies.activate(authority, policy),
    rollbackPolicy: (authority) => policies.rollback(authority),
    async processDeletionPropagation() {
      await settlePendingDerivations(governance);
      return deletion.processOpen();
    },
    getDeletionReceipt: (authority, deletionId) =>
      readDeletionReceipt(governance, authority, deletionId),
    listEvents: (authority, filter) => readEvents(governance, authority, filter ?? {}),
  };
}
