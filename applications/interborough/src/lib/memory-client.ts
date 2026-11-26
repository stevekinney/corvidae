/**
 * The browser's view of an agent's memory: the operations `bureau.memory.list`, `search`, `get`,
 * `forget` and `correct` (COR-1546), and the governance ones (`share`, `share.revoke`, `hold`,
 * `hold.release`, `quarantine` and `export`, COR-1809), through the generated client, and the
 * faults they answer with, sorted into the few the Memory page tells apart.
 *
 * The operations serve the caller's own memory under one agent. The caller is the host's one local
 * principal and is never a parameter. Reading needs `bureau.memory:read` and changing needs
 * `bureau.memory:write`; a legal hold, releasing a quarantined memory, and listing the quarantined (`list` with `state: 'quarantined'`) need `bureau.memory:govern`. A caller without the scope is
 * answered `Forbidden` whatever it owns.
 */
import { HttpClientError } from '@lostgradient/weft';

import { bureauClient, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';
import type { CatalogOperations } from './generated/bureau-operation-client.generated.ts';

/** Where a call is sent from: an abort signal, and a `fetch` for a caller that is not a page. */
type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** A memory's kind: a fact is something true, a how-to is a way of doing something (`bureau.memory.remember`'s `kind`). */
export type MemoryKind = 'fact' | 'how-to';

/**
 * One memory as the Bureau shows it: its content, kind, class, source, writer, trust, creation
 * time, and the chat that produced it. The page words a memory by its `kind` (Fact or How-to) and
 * its `writer` (you, the agent, or the system), which the Bureau derives, and never by the class,
 * source or trust. `quarantine` says why a memory is quarantined, and is present only on a memory
 * the quarantined list returned.
 */
export type Memory = BureauOutput<'bureau.memory.get'>['memory'] & {
  /** Why it is quarantined: `at` when, `by` what held it (the checks it was written through, its owner, or a recall guardrail), and the guardrail's `detector` and `category`, `null` when its owner quarantined it. */
  readonly quarantine?: {
    readonly at: string;
    readonly by: 'admission' | 'owner' | 'recall';
    readonly detector: string | null;
    readonly category: string | null;
  };
};

/** One page of memories and the offset of the next page, or `null` on the last. */
export type MemoryPage = BureauOutput<'bureau.memory.list'>;

/**
 * How many memories a page of the list asks for. The memory page and an agent's page read the same
 * query (`queryKeys.memory.list`), so they ask for the same page size.
 */
export const MEMORY_PAGE_SIZE = 20;

/** One page of what the agent remembers of the caller's chats, newest first. */
export async function listMemories(
  agentId: string,
  page: {
    readonly limit?: number;
    readonly offset?: number;
    /** `quarantined` lists the quarantined memories instead, each with why. */
    readonly state?: 'quarantined';
  } = {},
  options?: Options,
): Promise<MemoryPage> {
  return bureauClient['bureau.memory.list']({ agentId, ...page }, options);
}

/** One search result: a memory and its score against the query. */
export type MemoryHit = BureauOutput<'bureau.memory.search'>['hits'][number];

/** The agent's memories ranked against `query`, best first. A blank `query` is refused by the Bureau. */
export async function searchMemories(
  agentId: string,
  query: string,
  page: { readonly limit?: number } = {},
  options?: Options,
): Promise<readonly MemoryHit[]> {
  const answer = await bureauClient['bureau.memory.search']({ agentId, query, ...page }, options);
  return answer.hits;
}

/**
 * One memory together with its lineage and the versions a correction replaced. The lineage is where
 * a memory came from: the run that wrote it, the memory it replaced, and the memory that replaced
 * it. The history is each version a correction replaced, the most recent first; empty for a memory
 * never corrected.
 */
export type MemoryDetail = BureauOutput<'bureau.memory.get'>;

/**
 * Where a memory came from: the run that wrote it, the memory it replaced, and the memory that
 * replaced it.
 */
export type MemoryLineage = MemoryDetail['lineage'];

/** One earlier version of a memory, the most recent first in a memory's history. */
export type MemoryHistoryEntry = MemoryDetail['history'][number];

/** One memory with its lineage. A corrected memory is read here though it is no longer listed. */
export async function getMemory(
  agentId: string,
  id: string,
  options?: Options,
  client: Pick<CatalogOperations, 'bureau.memory.get'> = bureauClient,
): Promise<MemoryDetail> {
  return client['bureau.memory.get']({ agentId, id }, options);
}

/**
 * What forgetting a memory answers: the memory's identifier, the state of its deletion, and the
 * deletion's receipt.
 */
export type ForgetResult = BureauOutput<'bureau.memory.forget'>;

/** Forgets one memory as a source deletion; the answer says whether it is gone, held, or not yet settled. */
export async function forgetMemory(
  agentId: string,
  id: string,
  options?: Options,
): Promise<ForgetResult> {
  return bureauClient['bureau.memory.forget']({ agentId, id }, options);
}

/**
 * What correcting a memory answers: the identifier of the memory it replaced and the correction.
 */
export type CorrectResult = BureauOutput<'bureau.memory.correct'>;

/** Replaces one memory with `content`; the answer is the correction, as the list shows it now. */
export async function correctMemory(
  agentId: string,
  id: string,
  content: string,
  options?: Options,
): Promise<CorrectResult> {
  return bureauClient['bureau.memory.correct']({ agentId, id, content }, options);
}

/**
 * What adding a memory answers: the memory as the list shows it now (`added`), or, for text the
 * content rules flagged, the identifier of the record stored for inspection (`held`). A held record
 * is in no list, so that identifier is the only way to forget it.
 */
export type RememberResult = BureauOutput<'bureau.memory.remember'>;

/**
 * Adds a memory in the caller's own words, as a fact or a how-to. Asking twice adds it twice: the
 * call has no key.
 */
export async function rememberMemory(
  agentId: string,
  content: string,
  kind: MemoryKind,
  options?: Options,
): Promise<RememberResult> {
  return bureauClient['bureau.memory.remember']({ agentId, content, kind }, options);
}

/** What sharing or withdrawing a share answers: whether anything changed, and for whom. */
export type ShareResult = BureauOutput<'bureau.memory.share'>;

/**
 * Lets another owner read one memory (`granted`), or withdraws that access (`revoked`). Doing
 * either twice is not an error: `changed` says whether this call did anything.
 */
export async function changeMemoryShare(
  agentId: string,
  id: string,
  granteeOwnerId: string,
  change: 'granted' | 'revoked',
  options?: Options,
): Promise<ShareResult> {
  const params = { agentId, id, granteeOwnerId };
  return change === 'granted'
    ? bureauClient['bureau.memory.share'](params, options)
    : bureauClient['bureau.memory.share.revoke'](params, options);
}

/** What placing or lifting a legal hold answers: whether anything changed, and the hold's state now. */
export type HoldResult = BureauOutput<'bureau.memory.hold'>;

/** Places a legal hold on one memory (`place`), or lifts it (`release`). */
export async function changeLegalHold(
  agentId: string,
  id: string,
  change: 'place' | 'release',
  options?: Options,
): Promise<HoldResult> {
  const params = { agentId, id };
  return change === 'place'
    ? bureauClient['bureau.memory.hold'](params, options)
    : bureauClient['bureau.memory.hold.release'](params, options);
}

/** What quarantining a memory answers: whether it changed, and how many records it reached. */
export type QuarantineResult = BureauOutput<'bureau.memory.quarantine'>;

/**
 * Takes one memory, and what was derived from it, out of use. {@link releaseQuarantine} is the way
 * back for the memory itself, never for what was derived from it.
 */
export async function quarantineMemory(
  agentId: string,
  id: string,
  reason: string,
  options?: Options,
): Promise<QuarantineResult> {
  return bureauClient['bureau.memory.quarantine']({ agentId, id, reason }, options);
}

/** What releasing a quarantined memory answers: whether it changed, which is `false` for one already in use. */
export type ReleaseResult = BureauOutput<'bureau.memory.quarantine.release'>;

/**
 * Returns one quarantined memory to use, when the checks a new memory passes pass it again. A
 * memory the checks hold, or one that cannot be released, is refused as a `not-released` fault.
 */
export async function releaseQuarantine(
  agentId: string,
  id: string,
  options?: Options,
): Promise<ReleaseResult> {
  return bureauClient['bureau.memory.quarantine.release']({ agentId, id }, options);
}

/**
 * What exporting an agent's memories answers: the manifest's identifier, the name to save the
 * file under (such as `tool-runner-memories.json`), and every memory with its history.
 */
export type MemoryExport = BureauOutput<'bureau.memory.export'>;

/** Exports every memory the caller has of the agent, which records the export in the ledger. */
export async function exportMemories(agentId: string, options?: Options): Promise<MemoryExport> {
  return bureauClient['bureau.memory.export']({ agentId }, options);
}

/** Why a quarantined memory was not released: the reasons the server names, as `memory-<reason>`. */
export const MEMORY_RELEASE_REFUSALS = [
  'verification-failed',
  'derived-record',
  'deletion-pending',
  'superseded',
  'tampered',
] as const;

/** One of {@link MEMORY_RELEASE_REFUSALS}. */
export type MemoryReleaseRefusal = (typeof MEMORY_RELEASE_REFUSALS)[number];

/** What a thrown memory operation came to, sorted into what the page words. */
export type MemoryFault =
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not-found' }
  /** The memory was already corrected. */
  | { readonly kind: 'superseded' }
  /** Governed memory did not admit the correction. */
  | { readonly kind: 'successor-not-admitted' }
  /** Governed memory did not admit a new memory, so nothing was stored. */
  | { readonly kind: 'not-admitted' }
  /** A memory was shared with its own owner, or with no one. */
  | { readonly kind: 'invalid-grantee' }
  /** A quarantined memory was not released, for one of the reasons the server names. */
  | { readonly kind: 'not-released'; readonly reason: MemoryReleaseRefusal }
  /** Any other failure, with the status the server answered it with when it answered. */
  | { readonly kind: 'other'; readonly message: string; readonly status?: number };

/** Sorts a thrown fault into the {@link MemoryFault} the Memory page shows. */
export function memoryFaultOf(error: unknown): MemoryFault {
  if (!(error instanceof HttpClientError)) {
    return {
      kind: 'other',
      message: error instanceof Error ? error.message : 'The server did not answer.',
    };
  }
  const data = error.data;
  switch (data?.['weftCode']) {
    case 'Forbidden':
      return { kind: 'forbidden' };
    case 'NotFound':
      return { kind: 'not-found' };
    case 'Conflict':
      return data['reason'] === 'memory-superseded'
        ? { kind: 'superseded' }
        : { kind: 'other', message: error.message, status: error.status };
    case 'Unprocessable':
      if (data['reason'] === 'memory-successor-not-admitted') {
        return { kind: 'successor-not-admitted' };
      }
      if (data['reason'] === 'memory-not-admitted') return { kind: 'not-admitted' };
      for (const reason of MEMORY_RELEASE_REFUSALS) {
        if (data['reason'] === `memory-${reason}`) return { kind: 'not-released', reason };
      }
      return data['reason'] === 'memory-invalid-grantee'
        ? { kind: 'invalid-grantee' }
        : { kind: 'other', message: error.message, status: error.status };
    default:
      return { kind: 'other', message: error.message, status: error.status };
  }
}
