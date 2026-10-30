/**
 * COR-1934 — the command-ledger entries of a deleted chat.
 *
 * A command's receipt keeps what the command carried, so a retry can finish or replay it: a
 * `tasks.respond` claim keeps the structured answer it admitted (`TasksRespondClaim.submission`),
 * an A2A send keeps the files it admitted and their projection (`A2ASendClaim.inbound`,
 * `A2ASendResult.inbound`) and the answer a surface action was read as, and a run creation's
 * result keeps the run's summary, whose error text can quote what was said. Terminal retention
 * ends them a day after they settle; a deleted chat's go now. An entry is the chat's when any
 * string it holds, in its identity, claim or result, is one of the chat's run ids (bare, or as
 * the `task:<id>` target an A2A continuation addresses) or the chat's id.
 *
 * The fork and AG-UI resume ledgers are not reached: their entries hold ids, a model override, an
 * effort and interrupt outcomes, and no text (see `reserved-key-prefixes.ts`).
 */
import type { ConditionalTextValueStore } from '@lostgradient/storage';

import { COMMAND_LEDGER_KEY_PREFIX, purgeCommandLedgerEntries } from './command-ledger';
import { TASKS_RESPOND_LEDGER_KEY_PREFIX } from './tasks/respond-to-task';

/**
 * The key prefix of the A2A send ledger, as `http/a2a-request-handler.ts` declares it; spelled
 * here so this module does not import the request handler (`chat-ledger-purge.test.ts` holds
 * the two equal).
 */
export const A2A_SEND_LEDGER_PREFIX = 'command-ledger:a2a-send:v1';

/** The ledgers whose entries can hold a chat's content. */
export const CHAT_LEDGER_KEY_PREFIXES: readonly string[] = [
  COMMAND_LEDGER_KEY_PREFIX,
  A2A_SEND_LEDGER_PREFIX,
  TASKS_RESPOND_LEDGER_KEY_PREFIX,
];

/** Every string held anywhere in `value`. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const entry of value) yield* strings(entry);
  else if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) yield* strings(entry);
  }
}

/**
 * Deletes, from every ledger in {@link CHAT_LEDGER_KEY_PREFIXES}, the entries that name one of
 * the runs or the chat, and resolves how many went. Idempotent: it lists what is left.
 */
export async function purgeChatLedgerEntries(
  kv: ConditionalTextValueStore,
  runIds: ReadonlySet<string>,
  sessionId: string,
): Promise<number> {
  const names = new Set([sessionId, ...runIds, ...[...runIds].map((runId) => `task:${runId}`)]);
  let deleted = 0;
  for (const prefix of CHAT_LEDGER_KEY_PREFIXES) {
    deleted += await purgeCommandLedgerEntries(kv, prefix, (entry) => {
      for (const text of strings(entry)) if (names.has(text)) return true;
      return false;
    });
  }
  return deleted;
}
