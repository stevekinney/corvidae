/**
 * The governed memory the Bureau remembers with (COR-1546): records and ledger on Bungalow's
 * database, the default policy, and a hashing embedder that makes no network call, so memory works
 * on an installation that has configured no model provider.
 *
 * Records and the governance ledger share the Bureau's own `Storage` under disjoint key prefixes,
 * so one database holds the whole installation and a restart finds both where it left them.
 *
 * What a deletion leaves behind. A forgotten record is deleted from the record storage at once,
 * and the deletion's other targets settle as the Bureau's maintenance pass runs. This host keeps no
 * cache, no managed asset bytes, and no external processor of its own, so it declares those
 * `not-retained`; its text index, summaries and export manifests have built-in handlers. It does
 * not declare `durable-snapshots`: the text a run recalled is appended to the run's conversation
 * and persisted with it, and scrubbing that is out of scope, so that target reports `pending` and
 * then `failed` at its deadline instead of claiming a deletion nothing performed.
 */

import {
  createGovernedMemory,
  createHashingEmbedder,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createWeftMemoryRecordStorage,
  type GovernedMemory,
  type MemoryDeletionPropagation,
} from '@lostgradient/memory';
import type { Storage } from '@lostgradient/weft';

/** The policy revision the installation's memory records on every write, receipt, and event. */
export const MEMORY_POLICY_REVISION = 'interborough:1';

/** The deletion targets this host keeps nothing in. `durable-snapshots` is deliberately absent. */
export const MEMORY_DELETION_PROPAGATION: MemoryDeletionPropagation = {
  caches: 'not-retained',
  'managed-asset-bytes': 'not-retained',
  'external-processors': 'not-retained',
};

/** Governed memory over `storage`, which the Bureau and the engine share. The Bureau initializes and closes it. */
export function createHostMemory(storage: Storage): GovernedMemory {
  return createGovernedMemory({
    storage: createWeftMemoryRecordStorage(storage),
    ledger: createMemoryGovernanceLedger(storage),
    embedder: createHashingEmbedder(),
    policy: createMemoryGovernancePolicy({ revision: MEMORY_POLICY_REVISION }),
    propagation: MEMORY_DELETION_PROPAGATION,
  });
}
