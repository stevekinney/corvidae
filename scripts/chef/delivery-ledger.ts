// The delivery ledger: one line per delivered head, appended by `deliver.ts` for a branch merge and a
// pull request merge alike, and read by `worktree.ts stale` to tell a worktree whose commits are
// delivered from one holding work nothing has landed. A squash or direct merge leaves the worker's
// tip outside the default branch's history, so the ledger is the record that the tip was delivered.
//
// The file is `<main checkout>/tmp/chef/delivered-heads.log` (ignored state, never inside a
// worktree). Each line is tab-separated:
//   <ISO time>\t<branch:name | pr:number>\t<40-character head>\t<merge commit, or - when unknown>

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LedgerEntry {
  /** The pull request number, for a pull request delivery. */
  pr?: number | undefined;
  /** The remote branch, for a branch delivery. */
  branch?: string | undefined;
  head: string;
  mergeCommit: string | null;
  time?: Date | undefined;
}

export function ledgerPath(checkout: string): string {
  return join(checkout, 'tmp', 'chef', 'delivered-heads.log');
}

/** The ledger line for `entry`, without its newline. */
export function ledgerLine(entry: LedgerEntry): string {
  if (!/^[0-9a-f]{40}$/.test(entry.head))
    throw new Error(`"${entry.head}" is not a full commit SHA.`);
  const subject = entry.pr !== undefined ? `pr:${entry.pr}` : `branch:${entry.branch ?? ''}`;
  if (/[\t\n\r]/.test(subject)) throw new Error('A ledger subject holds no tab or line break.');
  return [
    (entry.time ?? new Date()).toISOString(),
    subject,
    entry.head,
    entry.mergeCommit ?? '-',
  ].join('\t');
}

export function recordDelivery(checkout: string, entry: LedgerEntry): void {
  const path = ledgerPath(checkout);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${ledgerLine(entry)}\n`);
}

/** Every delivered head in the ledger; a missing file or a malformed line gives nothing. */
export function readLedgerHeads(checkout: string): Set<string> {
  const path = ledgerPath(checkout);
  const heads = new Set<string>();
  if (!existsSync(path)) return heads;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const head = line.split('\t')[2];
    if (head !== undefined && /^[0-9a-f]{40}$/.test(head)) heads.add(head);
  }
  return heads;
}
