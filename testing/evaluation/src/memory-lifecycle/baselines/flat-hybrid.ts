import {
  createMemory,
  createWeftMemoryRecordStorage,
  type Memory,
  type MemoryMetadata,
  type MemorySearchResult,
} from '@lostgradient/memory';
import { MemoryStorage } from '@lostgradient/weft';

import { createLexicalHashEmbedder } from '../embedder';
import { EVIDENCE_SOURCES, type EvidenceSource } from '../scenarios';
import {
  BASELINE_REVISIONS,
  type BaselineOptions,
  instantOf,
  type MemoryBaselineAdapter,
  type ObservedEvidence,
  PRINCIPAL_SCOPES,
  type PrincipalScope,
  type RecallRequest,
} from './adapter';

/** The flat store's own source vocabulary, as a host would map each source onto it. */
const FLAT_SOURCES: Readonly<Record<EvidenceSource, MemoryMetadata['source']>> = {
  conversation: 'auto-capture',
  'tool-result': 'tool',
  'ingested-document': 'tool',
  operator: 'manual',
};

const EVIDENCE_TAG = 'evidence:';
const SOURCE_TAG = 'source:';

/** One namespace per tenant's support agent: the flat store has no principal partition. */
function agentNamespace(scope: PrincipalScope): string {
  return `${scope.tenantId}/support-agent`;
}

const NAMESPACES = [
  ...new Set(Object.values(PRINCIPAL_SCOPES).map((scope) => agentNamespace(scope))),
];

function tagged(metadata: MemoryMetadata, prefix: string): string | undefined {
  return metadata.tags?.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

function sourceOf(result: MemorySearchResult): EvidenceSource | null {
  const source = tagged(result.metadata, SOURCE_TAG);
  return EVIDENCE_SOURCES.find((known) => known === source) ?? null;
}

interface StoredRecord {
  readonly id: string;
  readonly namespace: string;
}

/**
 * The current `@lostgradient/memory` flat hybrid store, deployed the way one
 * agent uses it: `createMemory` over durable Weft storage, the shared
 * embedder, hybrid vector and BM25 recall with the package defaults, and one
 * namespace for the tenant's support agent. The store has no principal
 * concept (`createMemory` takes none), so everyone the agent serves shares
 * that namespace; tenants have separate agents. A host maps each source onto
 * the store's own vocabulary and keeps the original in a tag, which recall
 * reports. There is no admission, no state projection, and no lineage.
 */
export function createFlatHybridBaseline(options: BaselineOptions): MemoryBaselineAdapter {
  const { runtime, envelope } = options;
  const durable = new MemoryStorage();
  const embedder = createLexicalHashEmbedder(envelope.embedder.dimension);
  const owner = agentNamespace(PRINCIPAL_SCOPES.owner);
  /** Which record holds each observation; in-process, so a restart rebuilds it from storage. */
  let records = new Map<string, StoredRecord>();
  let memory: Memory | undefined;

  async function opened(): Promise<Memory> {
    if (memory === undefined) {
      memory = createMemory({
        embedder,
        storage: createWeftMemoryRecordStorage(durable),
        namespace: owner,
        runtime,
      });
      await memory.init();
    }
    return memory;
  }

  async function rebuild(store: Memory): Promise<Map<string, StoredRecord>> {
    const rebuilt = new Map<string, StoredRecord>();
    for (const namespace of NAMESPACES) {
      for (const entry of await store.list({ namespace, limit: 10_000 })) {
        rebuilt.set(tagged(entry.metadata, EVIDENCE_TAG)!, { id: entry.id, namespace });
      }
    }
    return rebuilt;
  }

  return {
    name: 'flat-hybrid',
    revision: BASELINE_REVISIONS['flat-hybrid'],
    components: [],
    async observe(evidence: ObservedEvidence) {
      const store = await opened();
      const namespace = agentNamespace(PRINCIPAL_SCOPES[evidence.principal]);
      const entry = await store.remember(evidence.content, {
        namespace,
        source: FLAT_SOURCES[evidence.source],
        tags: [`${EVIDENCE_TAG}${evidence.id}`, `${SOURCE_TAG}${evidence.source}`],
      });
      const duplicate = [...records.values()].some((record) => record.id === entry.id);
      records.set(evidence.id, { id: entry.id, namespace });
      return duplicate ? 'duplicate' : 'admitted';
    },
    async forget(evidenceId: string) {
      const store = await opened();
      const record = records.get(evidenceId);
      if (record === undefined) return { status: 'not-found', receipted: false };
      await store.forget(record.id, record.namespace);
      records.delete(evidenceId);
      return { status: 'completed', receipted: false };
    },
    async restart() {
      await memory?.close();
      memory = undefined;
      const store = await opened();
      records = await rebuild(store);
    },
    async recall({ query, limit }: RecallRequest) {
      const store = await opened();
      const results = await store.recall(query, { namespace: owner, limit });
      return {
        plan: { strategy: 'hybrid-vector-bm25', scope: owner, query, limit },
        items: results.map((result) => ({
          content: result.content,
          observedAt: instantOf(result.createdAt),
          source: sourceOf(result),
        })),
        withheld: 0,
      };
    },
    async close() {
      await memory?.close();
      memory = undefined;
    },
  };
}
