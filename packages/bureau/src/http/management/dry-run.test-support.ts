/**
 * Shared checks for the dry run of a destructive operation (COR-2522): a dry run writes nothing, so
 * the store holds exactly what it held before, the Bureau published no event during it, and the
 * answer is `{ dryRun: true, target, effects }`.
 */
import { expect } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';

import type { Bureau } from '../../bureau-types/facade.ts';
import {
  type Handler,
  openBureau,
  type OpenedBureau,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

/**
 * Every entry the store (or each of several stores) holds, as sorted `store:key=hex` lines, so two
 * snapshots compare with `toEqual`.
 */
export async function snapshotStorage(
  storage: Storage | readonly Storage[],
): Promise<readonly string[]> {
  const lines: string[] = [];
  const stores = 'scan' in storage ? [storage] : storage;
  for (const [index, store] of stores.entries()) {
    for await (const [key, value] of store.scan('')) {
      lines.push(`${index}:${key}=${Buffer.from(value).toString('hex')}`);
    }
  }
  return lines.toSorted();
}

/** How many checks in a row must find the store and the event count as they were. */
const CALM_CHECKS = 20;

/**
 * The store once the Bureau has finished what it was already doing: a run that has just started
 * still writes its index entries and publishes its first events, and an outbox drains, after the
 * state a test waits for. That is the Bureau's own background work, so a dry run is compared
 * against the store, and the events, once they are quiet: the store and `published` unchanged for
 * {@link CALM_CHECKS} checks in a row.
 */
export async function settledSnapshot(
  storage: Storage | readonly Storage[],
  published: readonly unknown[] = [],
): Promise<readonly string[]> {
  let latest = await snapshotStorage(storage);
  let seen = published.length;
  let calm = 0;
  await waitUntil(
    async () => {
      const next = await snapshotStorage(storage);
      const unchanged =
        next.length === latest.length &&
        next.every((line, index) => line === latest[index]) &&
        published.length === seen;
      latest = next;
      seen = published.length;
      calm = unchanged ? calm + 1 : 0;
      return calm >= CALM_CHECKS;
    },
    { message: 'the Bureau stops writing to its store and publishing events' },
  );
  return latest;
}

/** Every file under `directory` (one level), as sorted `name=text` lines. */
export async function snapshotDirectory(directory: string): Promise<readonly string[]> {
  const lines: string[] = [];
  for (const name of await readdir(directory)) {
    if (name.startsWith('.')) continue;
    lines.push(`${name}=${await readFile(join(directory, name), 'utf8')}`);
  }
  return lines.toSorted();
}

/** What a dry run is checked against: where the Bureau keeps its records. */
export type DryRunSubject = {
  readonly bureau: Pick<Bureau, 'toObservable'>;
  /** The store the Bureau writes to, or every store its records are split across. */
  readonly storage: Storage | readonly Storage[];
  /** A directory the Bureau keeps files in (agent or workflow files), when the operation reaches it. */
  readonly directory?: string | undefined;
};

/**
 * Runs `dryRun` and fails when it changed the store, wrote a file or published an event. Returns
 * what `dryRun` resolved.
 */
export async function expectNothingWritten<T>(
  subject: DryRunSubject,
  dryRun: () => Promise<T>,
): Promise<T> {
  const published: unknown[] = [];
  const subscription = subject.bureau.toObservable().subscribe((event) => published.push(event));
  const storageBefore = await settledSnapshot(subject.storage, published);
  // What the Bureau published before the dry run is not the dry run's.
  published.length = 0;
  const filesBefore =
    subject.directory === undefined ? [] : await snapshotDirectory(subject.directory);
  try {
    const answer = await dryRun();
    expect(await settledSnapshot(subject.storage, published)).toEqual(storageBefore);
    expect(
      subject.directory === undefined ? [] : await snapshotDirectory(subject.directory),
    ).toEqual(filesBefore);
    expect(published).toEqual([]);
    return answer;
  } finally {
    subscription.unsubscribe();
  }
}

/** One Bureau over a store the test can read, and what a dry run is checked against. */
export async function withBureau<T>(
  options: Parameters<typeof openBureau>[0],
  body: (opened: OpenedBureau, subject: DryRunSubject) => Promise<T>,
): Promise<T> {
  const storage = options?.storage ?? new MemoryStorage();
  const opened = await openBureau({ ...options, storage });
  try {
    return await body(opened, { bureau: opened.bureau, storage });
  } finally {
    await opened.dispose();
  }
}

/**
 * The fault the real call answers, and the dry run's: the same one, so a target the real call
 * would not find, or a caller it would refuse, learns nothing from a dry run it would not learn
 * from the call.
 */
export async function expectSameFaultAsTheRealCall(
  served: { readonly handler: Handler },
  method: string,
  params: Record<string, unknown>,
  key: string,
): Promise<void> {
  const real = await rpc(served.handler, method, params, key);
  const dry = await rpc(served.handler, method, { ...params, dryRun: true }, key);
  expect(real.error).toBeDefined();
  expect(dry.error).toEqual(real.error);
  expect(dry.result).toBeUndefined();
}

/** The answer of a dry run, narrowed: a fault or a real answer fails the test with what it was. */
export function dryRunResultOf(body: RpcBody): {
  readonly dryRun: true;
  readonly target: { readonly kind: string; readonly id: string };
  readonly effects: ReadonlyArray<{ kind: string; count: number; atLeast?: true }>;
} {
  if (body.result === undefined) {
    throw new Error(`Expected a dry run's answer, got ${JSON.stringify(body)}`);
  }
  expect(body.result['dryRun']).toBe(true);
  return body.result as ReturnType<typeof dryRunResultOf>;
}
