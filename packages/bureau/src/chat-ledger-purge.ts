/**
 * COR-1934 — the command-ledger entries of a deleted chat.
 *
 * A command's receipt keeps what the command carried, so a retry can finish or replay it: a
 * `tasks.respond` claim keeps the structured answer it admitted (`TasksRespondClaim.submission`),
 * an A2A send keeps the files it admitted and their projection (`A2ASendClaim.inbound`,
 * `A2ASendResult.inbound`) and the answer a surface action was read as, and a run creation's
 * result keeps the run's summary, whose error text can quote what was said. Terminal retention
 * ends them a day after they settle; a deleted chat's go now. An entry is the chat's when the
 * field that says which run its command is about names one of the chat's runs (see `namesRun`).
 *
 * The fork and AG-UI resume ledgers are not reached: their entries hold ids, a model override, an
 * effort and interrupt outcomes, and no text (see `reserved-key-prefixes.ts`).
 */
import type { ConditionalTextValueStore } from '@lostgradient/storage';

import {
  COMMAND_LEDGER_KEY_PREFIX,
  type CommandLedgerEntry,
  purgeCommandLedgerEntries,
} from './command-ledger';
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

/** The string field `name` of `value`, when it is an object holding one. */
function field(value: unknown, name: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const found: unknown = Reflect.get(value, name);
  return typeof found === 'string' ? found : undefined;
}

/**
 * Whether an entry is a command on one of the runs, by the fields that say which run a command
 * is about: the identity's `target` (a `tasks.respond` names the task; an A2A continuation names
 * `task:<id>`), a run creation's claimed `runId`, and the task a send's result names. Nothing
 * else is read: a context id is reused by a recreated context, and a request id or a submitted
 * value can equal anything.
 */
function namesRun(
  entry: CommandLedgerEntry<unknown, unknown>,
  runIds: ReadonlySet<string>,
): boolean {
  const { target } = entry.identity;
  if (runIds.has(target) || (target.startsWith('task:') && runIds.has(target.slice(5))))
    return true;
  const claimed = field(entry.claim, 'runId');
  if (claimed !== undefined && runIds.has(claimed)) return true;
  const resulted = entry.state === 'completed' ? field(entry.result, 'taskId') : undefined;
  return resulted !== undefined && runIds.has(resulted);
}

/**
 * Deletes, from every ledger in {@link CHAT_LEDGER_KEY_PREFIXES}, the entries that are commands
 * on one of the runs, and resolves how many went. Idempotent: it lists what is left.
 */
export async function purgeChatLedgerEntries(
  kv: ConditionalTextValueStore,
  runIds: ReadonlySet<string>,
): Promise<number> {
  let deleted = 0;
  for (const prefix of CHAT_LEDGER_KEY_PREFIXES) {
    deleted += await purgeCommandLedgerEntries(kv, prefix, (entry) => namesRun(entry, runIds));
  }
  return deleted;
}
