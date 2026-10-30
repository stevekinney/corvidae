/**
 * Removing every durable record of one application command mailbox (WFT-84).
 *
 * A command record keeps the caller's payload inline until retention retires it, so a host that
 * must forget a resource's commands (a deleted chat, for example) cannot wait for retention.
 * This is the one place that knows every key family a mailbox owns, so a family added to
 * `createMailboxKeys` is purged here and nowhere else.
 *
 * @module core/mailbox-purge
 */

import { storageDeletePrefix } from '@lostgradient/storage';
import type { MailboxRuntime } from './mailbox-internals.ts';

/**
 * Delete the command records, delivery and listing indexes, idempotency bindings, terminal
 * retention index, sink probes and header of one mailbox, and answer how many keys went.
 *
 * The header goes last, so a purge that fails partway leaves a mailbox that a second call
 * finishes: every step lists what is left. A mailbox with nothing stored answers `0`.
 */
export async function purgeMailbox(runtime: MailboxRuntime): Promise<number> {
  const { storage, keys } = runtime;
  let deleted = 0;
  // The command records hold the payloads; the indexes name command ids and idempotency keys.
  for (const prefix of [
    keys.commandPrefix,
    keys.readyPrefix,
    keys.bySequencePrefix,
    keys.terminalPrefix,
    // The key builder with an empty component is the family's prefix.
    keys.idempotency(''),
    keys.sinkProbe(''),
  ]) {
    deleted += await storageDeletePrefix(storage, prefix);
  }
  if ((await storage.get(keys.header)) !== null) {
    await storage.delete(keys.header);
    deleted += 1;
  }
  return deleted;
}
