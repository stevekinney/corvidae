import {
  ASYNCHRONOUS_DELETION_TARGETS,
  createGovernedMemory,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createWeftMemoryRecordStorage,
  type GovernedMemory,
  type GovernedMemoryRecord,
  type GovernedWriteOptions,
  type MemoryAuthority,
  type MemoryCapability,
  type MemoryClass,
  type MemoryDeletionPropagation,
  type MemoryDeletionResult,
  type MemoryWriteReceipt,
} from '@lostgradient/memory';
import { MemoryStorage } from '@lostgradient/weft';

import { createLexicalHashEmbedder } from '../embedder';
import type { EvidenceSource } from '../scenarios';
import { parseStatement } from '../statements';
import {
  type AdmissionOutcome,
  BASELINE_REVISIONS,
  baselineComponents,
  type BaselineOptions,
  type DeletionOutcome,
  instantOf,
  type MemoryBaselineAdapter,
  type ObservedEvidence,
  PRINCIPAL_SCOPES,
  type PrincipalScope,
  type RecallRequest,
  SOURCE_RANK,
} from './adapter';

/** The one collection the support agent's memory uses. */
const COLLECTION = 'support-agent';
const PRINCIPAL_CAPABILITIES: readonly MemoryCapability[] = [
  'memory:list',
  'memory:get',
  'memory:search',
  'memory:write',
  'memory:delete',
];

function authorityFor(scope: PrincipalScope): MemoryAuthority {
  return createMemoryAuthority({
    principal: { kind: 'user', id: scope.principalId },
    tenantId: scope.tenantId,
    ownerId: scope.ownerId,
    purpose: 'support-memory',
    capabilities: PRINCIPAL_CAPABILITIES,
    policyRevision: 'memory-lifecycle-authorization-1',
    projection: 'agent',
  });
}

/** The state projector's own reader: it inspects the owner's records to rebuild after a restart. */
function projectorAuthority(scope: PrincipalScope): MemoryAuthority {
  return createMemoryAuthority({
    principal: { kind: 'service', id: 'state-projector' },
    tenantId: scope.tenantId,
    ownerId: scope.ownerId,
    purpose: 'state-projection',
    capabilities: ['memory:list', 'memory:inspect'],
    policyRevision: 'memory-lifecycle-authorization-1',
    projection: 'administrative',
  });
}

/** What the adapter keeps about one stored observation. */
interface StoredEvidence {
  readonly recordId: string;
  readonly observedAt: number;
  readonly source: EvidenceSource;
}

/** The state projector's current record for one owner's slot. */
interface CurrentState {
  readonly recordId: string;
  readonly rank: number;
}

function ownerKey(scope: PrincipalScope): string {
  return `${scope.tenantId}/${scope.ownerId}`;
}

/**
 * A deletion that left its record stored reports why, straight from
 * `deletion`; one that removed it reports its other rows in COR-806's order of
 * severity. A refusal with no receipt is `failed`.
 */
export function deletionStatus(result: MemoryDeletionResult): DeletionOutcome['status'] {
  if (result.status === 'not-found') return 'not-found';
  if (result.deletion === undefined) return 'failed';
  if (result.deletion !== 'completed') return result.deletion;
  const statuses = new Set(result.receipt!.targets.map((target) => target.status));
  if (statuses.has('failed')) return 'failed';
  if (statuses.has('pending')) return 'pending';
  return statuses.has('unknown') ? 'unknown' : 'completed';
}

const EVIDENCE_METADATA = 'evidenceId';
const OBSERVED_METADATA = 'observedAt';

/**
 * The proposed lifecycle architecture: COR-41's governed memory, deployed
 * with the shared embedder and COR-806's default governance policy (the
 * poisoning detector at admission and recall, verified trust for procedures
 * and identity), every principal in its own owner partition, and receipted
 * deletion. The deployment keeps no bounded-async copies, so it declares each
 * of those targets `not-retained`. On top of that it runs three structured
 * components (all of them unless `components` names fewer, for an
 * ablation), each of which the report promotes only where, on its own
 * workload, the architecture beats raw-log search and also does better than
 * it does without that component:
 *
 * - `state-projector` keeps one current record per owner and slot: a new
 *   statement of a slot supersedes the current one unless its source ranks
 *   lower (a document never overrides what the owner said).
 * - `procedure-memory` stores procedures in the procedural class, which
 *   recall releases only at verified trust.
 * - `resource-derivation` stores assets as resource records and their
 *   derived views as canonical projections of them, so deleting an asset
 *   reaches every view derived from it.
 */
export function createLifecycleBaseline(options: BaselineOptions): MemoryBaselineAdapter {
  const { runtime, envelope } = options;
  const running = baselineComponents('lifecycle', options.components);
  const components = new Set(running);
  const durable = new MemoryStorage();
  const embedder = createLexicalHashEmbedder(envelope.embedder.dimension);
  const policy = createMemoryGovernancePolicy({ revision: 'memory-lifecycle-governance-1' });
  const propagation: MemoryDeletionPropagation = Object.fromEntries(
    ASYNCHRONOUS_DELETION_TARGETS.map((target) => [target, 'not-retained' as const]),
  );
  const owner = PRINCIPAL_SCOPES.owner;
  const ownerAuthority = authorityFor(owner);
  let memory: GovernedMemory | undefined;
  /** In-process indexes; a restart rebuilds both from storage. */
  let stored = new Map<string, StoredEvidence>();
  let current = new Map<string, CurrentState>();

  async function opened(): Promise<GovernedMemory> {
    if (memory === undefined) {
      memory = createGovernedMemory({
        storage: createWeftMemoryRecordStorage(durable),
        ledger: createMemoryGovernanceLedger(durable),
        embedder,
        policy,
        propagation,
        runtime,
      });
      await memory.init();
    }
    return memory;
  }

  function memoryClassOf(evidence: ObservedEvidence): MemoryClass {
    if (evidence.kind === 'procedure') {
      return components.has('procedure-memory') ? 'procedural' : 'semantic';
    }
    if (evidence.kind === 'fact') return 'semantic';
    return components.has('resource-derivation') ? 'resource' : 'episodic';
  }

  function writeOptions(evidence: ObservedEvidence): GovernedWriteOptions {
    const asset = evidence.derivedFrom === undefined ? undefined : stored.get(evidence.derivedFrom);
    const observedAt = runtime.clock.now();
    return {
      collection: COLLECTION,
      source: evidence.source,
      memoryClass: memoryClassOf(evidence),
      eventAt: observedAt,
      metadata: { [EVIDENCE_METADATA]: evidence.id, [OBSERVED_METADATA]: observedAt },
      ...(components.has('resource-derivation') && asset !== undefined
        ? {
            derivedFrom: {
              kind: 'canonical-projection',
              sources: [{ id: asset.recordId, collection: COLLECTION }],
            },
          }
        : {}),
    };
  }

  /** Writes through the state projector: supersede the slot's current record, or write alongside it. */
  async function project(
    store: GovernedMemory,
    authority: MemoryAuthority,
    evidence: ObservedEvidence,
    write: GovernedWriteOptions,
  ): Promise<MemoryWriteReceipt> {
    const statement = components.has('state-projector')
      ? parseStatement(evidence.content)
      : undefined;
    if (statement === undefined) return store.write(authority, evidence.content, write);
    const key = `${ownerKey(PRINCIPAL_SCOPES[evidence.principal])}|${statement.slot}`;
    const rank = SOURCE_RANK[evidence.source];
    const previous = current.get(key);
    const supersedes = previous !== undefined && previous.rank <= rank;
    // A current record a deletion has since removed has nothing left to supersede.
    const superseded = supersedes
      ? await store.forget(authority, {
          mode: 'supersession',
          locator: { id: previous.recordId, collection: COLLECTION },
          successor: { content: evidence.content, ...write },
        })
      : undefined;
    const receipt = superseded?.write ?? (await store.write(authority, evidence.content, write));
    if (receipt.status === 'admitted' && (previous === undefined || supersedes)) {
      current.set(key, { recordId: receipt.recordId!, rank });
    }
    return receipt;
  }

  async function rebuild(store: GovernedMemory): Promise<void> {
    stored = new Map();
    current = new Map();
    const scopes = new Map(
      Object.values(PRINCIPAL_SCOPES).map((scope) => [ownerKey(scope), scope]),
    );
    for (const [key, scope] of scopes) {
      const records = await store.list(projectorAuthority(scope), {
        collection: COLLECTION,
        limit: 10_000,
      });
      for (const record of records.toReversed()) remember(key, record);
    }
  }

  function remember(key: string, record: GovernedMemoryRecord): void {
    const governance = record.governance!;
    stored.set(String(record.metadata[EVIDENCE_METADATA]), {
      recordId: record.id,
      observedAt: Number(record.metadata[OBSERVED_METADATA]),
      source: record.source as EvidenceSource,
    });
    const statement = parseStatement(record.content);
    const live = governance.state === 'active' && governance.invalidatedAt === undefined;
    if (!components.has('state-projector') || statement === undefined || !live) return;
    const slot = `${key}|${statement.slot}`;
    const rank = SOURCE_RANK[record.source as EvidenceSource];
    if ((current.get(slot)?.rank ?? Number.NEGATIVE_INFINITY) <= rank) {
      current.set(slot, { recordId: record.id, rank });
    }
  }

  return {
    name: 'lifecycle',
    revision: BASELINE_REVISIONS.lifecycle,
    components: running,
    async observe(evidence: ObservedEvidence): Promise<AdmissionOutcome> {
      const store = await opened();
      const authority = authorityFor(PRINCIPAL_SCOPES[evidence.principal]);
      const write = writeOptions(evidence);
      const receipt = await project(store, authority, evidence, write);
      if (receipt.recordId !== undefined) {
        stored.set(evidence.id, {
          recordId: receipt.recordId,
          observedAt: write.eventAt!,
          source: evidence.source,
        });
      }
      return receipt.status;
    },
    async forget(evidenceId: string): Promise<DeletionOutcome> {
      const store = await opened();
      const record = stored.get(evidenceId);
      if (record === undefined) return { status: 'not-found', receipted: false };
      const result = await store.delete(ownerAuthority, {
        id: record.recordId,
        collection: COLLECTION,
      });
      return { status: deletionStatus(result), receipted: result.receipt !== undefined };
    },
    async restart() {
      await memory?.close();
      memory = undefined;
      const store = await opened();
      await store.processDeletionPropagation();
      await rebuild(store);
    },
    async recall({ query, limit }: RecallRequest) {
      const store = await opened();
      const bundle = await store.recallForModel(ownerAuthority, query, {
        collection: COLLECTION,
        limit,
      });
      const byRecord = new Map([...stored.values()].map((entry) => [entry.recordId, entry]));
      return {
        plan: {
          strategy: 'governed-recall-for-model',
          scope: ownerKey(owner),
          query,
          limit,
        },
        // Every record recall can return was stored through `observe`, or rebuilt after a restart.
        items: bundle.evidence.map((evidence) => ({
          content: evidence.content,
          observedAt: instantOf(byRecord.get(evidence.id)!.observedAt),
          source: evidence.source as EvidenceSource,
        })),
        withheld: bundle.withheld,
      };
    },
    async close() {
      await memory?.close();
      memory = undefined;
    },
  };
}
