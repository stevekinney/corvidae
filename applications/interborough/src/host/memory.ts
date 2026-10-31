/**
 * The governed memory the Bureau remembers with (COR-1546): records and ledger on Bungalow's
 * database, the default policy, and the embedder registry, whose built-in hashing embedder makes
 * no network call and is the one memory starts with, so memory works on an installation that has
 * configured no model provider.
 *
 * Records, their vectors (one embedding profile at a time, COR-1898), and the governance ledger
 * share the Bureau's own `Storage` under disjoint key prefixes, so one database holds the whole
 * installation and a restart finds all three where it left them.
 *
 * What a deletion leaves behind. A forgotten record is deleted from the record storage at once,
 * and the deletion's other targets settle as the Bureau's maintenance pass runs. This host keeps no
 * cache, no managed asset bytes, and no external processor of its own, so it declares those
 * `not-retained`; its text index, summaries and export manifests have built-in handlers. It does
 * not declare `durable-snapshots`: the text a run recalled is appended to the run's conversation
 * and persisted with it, and scrubbing that is out of scope, so that target reports `pending` and
 * then `failed` at its deadline instead of claiming a deletion nothing performed.
 */

import type { PluginMemoryContributions } from '@lostgradient/bureau';
import {
  createEmbedderRegistry,
  createGovernedMemory,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMemoryVectorStore,
  createWeftMemoryRecordStorage,
  type GovernedMemory,
  type MemoryDeletionPropagation,
} from '@lostgradient/memory';
import type { Storage } from '@lostgradient/storage';

/** The policy revision the installation's memory records on every write, receipt, and event. */
export const MEMORY_POLICY_REVISION = 'interborough:1';

/** The deletion targets this host keeps nothing in. `durable-snapshots` is deliberately absent. */
export const MEMORY_DELETION_PROPAGATION: MemoryDeletionPropagation = {
  caches: 'not-retained',
  'managed-asset-bytes': 'not-retained',
  'external-processors': 'not-retained',
};

/**
 * Governed memory over `storage`, which the Bureau and the engine share. The Bureau initializes and
 * closes it. It is built once plugin setup has run (COR-1879, `BureauOptions.memory`), with what the
 * running plugins contribute: their embedders join the registry beside the built-in hashing one, and
 * their detectors run after the default poisoning detector on admission and on recall.
 */
export function createHostMemory(
  storage: Storage,
  contributions: PluginMemoryContributions,
): GovernedMemory {
  return createGovernedMemory({
    storage: createWeftMemoryRecordStorage(storage),
    ledger: createMemoryGovernanceLedger(storage),
    embedders: createEmbedderRegistry(contributions.embedders),
    vectors: createMemoryVectorStore(storage),
    policy: createMemoryGovernancePolicy({
      revision: MEMORY_POLICY_REVISION,
      admission: { contributedDetectors: contributions.detectors },
      recall: { contributedDetectors: contributions.detectors },
    }),
    propagation: MEMORY_DELETION_PROPAGATION,
  });
}
