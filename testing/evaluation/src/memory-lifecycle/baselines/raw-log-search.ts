import { computeBM25Scores } from '@lostgradient/memory';

import type { EvidenceSource } from '../scenarios';
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

interface LogEntry {
  readonly evidenceId: string;
  readonly scope: PrincipalScope;
  readonly content: string;
  readonly source: EvidenceSource;
  readonly observedAt: number;
}

function sameOwner(left: PrincipalScope, right: PrincipalScope): boolean {
  return left.tenantId === right.tenantId && left.ownerId === right.ownerId;
}

/**
 * Authorized raw-log search: the simplest memory that is still safe to share.
 * Every observation is appended, verbatim and unfiltered, to a durable log
 * under the tenant and owner it belongs to. A recall searches only the
 * owner's own entries with BM25, most relevant first and newest first among
 * equals, and keeps an entry's time and source. There is no admission, no
 * state, and no lineage: a deletion removes exactly the entries it names.
 * The log is the durable store, so a restart loses nothing.
 */
export function createRawLogSearchBaseline(options: BaselineOptions): MemoryBaselineAdapter {
  const { runtime } = options;
  const log: LogEntry[] = [];
  const owner = PRINCIPAL_SCOPES.owner;

  return {
    name: 'raw-log-search',
    revision: BASELINE_REVISIONS['raw-log-search'],
    components: [],
    observe(evidence: ObservedEvidence) {
      log.push({
        evidenceId: evidence.id,
        scope: PRINCIPAL_SCOPES[evidence.principal],
        content: evidence.content,
        source: evidence.source,
        observedAt: runtime.clock.now(),
      });
      return Promise.resolve('admitted');
    },
    forget(evidenceId: string) {
      const before = log.length;
      for (let index = log.length - 1; index >= 0; index -= 1) {
        const entry = log[index]!;
        if (entry.evidenceId === evidenceId && sameOwner(entry.scope, owner)) log.splice(index, 1);
      }
      return Promise.resolve({
        status: log.length < before ? 'completed' : 'not-found',
        receipted: false,
      });
    },
    restart: () => Promise.resolve(),
    recall({ query, limit }: RecallRequest) {
      const authorized = log.filter((entry) => sameOwner(entry.scope, owner));
      const scores = computeBM25Scores(
        query,
        authorized.map((entry) => entry.content),
      );
      const ranked = authorized
        .map((entry, index) => ({ entry, score: scores.get(index) ?? 0 }))
        .filter(({ score }) => score > 0)
        .toSorted(
          (left, right) =>
            right.score - left.score || right.entry.observedAt - left.entry.observedAt,
        );
      return Promise.resolve({
        plan: {
          strategy: 'bm25-over-raw-log',
          scope: `${owner.tenantId}/${owner.ownerId}`,
          query,
          limit,
        },
        items: ranked.slice(0, limit).map(({ entry }) => ({
          content: entry.content,
          observedAt: instantOf(entry.observedAt),
          source: entry.source,
        })),
        withheld: 0,
      });
    },
    close: () => Promise.resolve(),
  };
}
