/**
 * The record a running host leaves in its home (COR-2540): the address it actually bound and its
 * process identifier, in `instance.json`. A host on a free port has no address anyone could guess,
 * so the CLI run from a linked worktree reads this record to find the host that worktree runs
 * (`worktree-instance.ts`).
 *
 * The file is a hint, not a lease. It is written once the listener is bound, which is after the
 * home lock is held, so only the host that owns the home ever writes it; it is removed on a clean
 * exit, while the lock is still held, and only if it still names this process. A host that died
 * without cleaning up leaves a stale record, so a reader trusts it only while that process is alive
 * and the recorded address answers the host's status route ({@link HOST_STATUS_ROUTE}). A missing,
 * unreadable or malformed record reads as "no host".
 *
 * It is not a persisted format anything else depends on: it holds no state of the home, a reader
 * that finds one it cannot read ignores it, and deleting it loses nothing.
 *
 * @module instance-record
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { HOST_STATUS_ROUTE } from './host-status.ts';

/** The only address a host binds, and so the only host a record may name (`host.ts`). */
const LOOPBACK_ADDRESS = '127.0.0.1';

/** The file in the home that holds the record. */
export const INSTANCE_RECORD_FILE = 'instance.json';

/** What a running host records about itself. */
export type InstanceRecord = {
  /** The origin the host bound, such as `http://127.0.0.1:54312`. */
  readonly url: string;
  /** The host's process identifier. */
  readonly pid: number;
};

/** Where the record is in `home`. The writer and the reader both use this one function. */
export function instanceRecordPath(home: string): string {
  return join(home, INSTANCE_RECORD_FILE);
}

/** Record `record` in `home`: written beside the file and renamed over it, so a reader never sees half of one. */
export async function writeInstanceRecord(home: string, record: InstanceRecord): Promise<void> {
  const path = instanceRecordPath(home);
  const temporary = `${path}.${record.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** The record in `home`, or `undefined` when there is none or it is not the shape a host writes. */
export async function readInstanceRecord(home: string): Promise<InstanceRecord | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(instanceRecordPath(home), 'utf8'));
  } catch {
    // Missing, unreadable, or not JSON: no host recorded itself here.
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { url, pid }: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (typeof url !== 'string' || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  // A host binds loopback only, so a record that names anything else is not one a host wrote, and
  // is not an address a command should be pointed at.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== LOOPBACK_ADDRESS || parsed.port === '') {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { url, pid };
}

/**
 * Remove the record in `home` when it names process `pid`, so a host never removes the record of the
 * host that replaced it. A record that is already gone is not a failure.
 */
export async function removeInstanceRecord(home: string, pid: number): Promise<void> {
  const current = await readInstanceRecord(home);
  if (current?.pid !== pid) return;
  await rm(instanceRecordPath(home), { force: true });
}

/** Whether process `pid` exists: signal 0 checks without sending anything, and `EPERM` means it exists but is not ours. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * How long a status request to a recorded address may take before the record counts as stale: a
 * live host on this machine answers at once, and a process that took the port since, without
 * answering, must not hold the CLI up.
 */
const PROBE_DEADLINE_MILLISECONDS = 5_000;

const probeFetch = (input: string): Promise<Response> =>
  fetch(input, { signal: AbortSignal.timeout(PROBE_DEADLINE_MILLISECONDS) });

/** What {@link liveInstanceUrl} checks with, so a test can stand in for the operating system or the network. */
export type InstanceProbes = {
  /** Whether the process is alive. Defaults to {@link processIsAlive}. */
  readonly alive?: (pid: number) => boolean;
  /** Fetches a URL. Defaults to `fetch` under a deadline. */
  readonly fetch?: (input: string) => Promise<Response>;
};

/**
 * The address of the host `home` records, or `undefined` unless that record is readable, its
 * process is alive, and its address answers the host's status route with a success. A record that
 * fails any of these is stale, and the reader behaves as though there were none.
 */
export async function liveInstanceUrl(
  home: string,
  probes: InstanceProbes = {},
): Promise<string | undefined> {
  const record = await readInstanceRecord(home);
  if (record === undefined) return undefined;
  if (!(probes.alive ?? processIsAlive)(record.pid)) return undefined;
  try {
    const response = await (probes.fetch ?? probeFetch)(
      new URL(HOST_STATUS_ROUTE, record.url).href,
    );
    // The body is not read: an answer from the route is the evidence, and a closed port is a refusal.
    await response.body?.cancel();
    return response.ok ? new URL(record.url).origin : undefined;
  } catch {
    // Nothing is listening at the recorded address.
    return undefined;
  }
}
