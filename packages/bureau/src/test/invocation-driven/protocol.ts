/**
 * COR-1437 — the shared protocol between `invocation-driven-execution.test.ts`
 * (the driver) and the invocation entry points beside this file.
 *
 * Each invocation is a fresh Bun process. It reads the driver's virtual clock
 * from the temporary directory ONCE at boot, so every claim, timer, and
 * maintenance decision it makes uses one value of "now", the way a cron or
 * queue wake-up carries one timestamp. It reports progress as prefixed JSON
 * lines on stdout. Its last line, `finished`, is written after it has shut its
 * runtime down, and from that line on it must exit on its own.
 *
 * Not a test file: the invocation entry points import it, and so does the
 * driver.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { awakeTurns } from '@lostgradient/testing/wait-until';

/** Every protocol line on an invocation's stdout starts with this. */
export const INVOCATION_LINE_PREFIX = '@@invocation ';

/** The clock value every Weft and Operative scenario starts at. */
export const VIRTUAL_START = 1_000_000;

/** The Weft workflow's durable timer. */
export const WEFT_SLEEP_MS = 60_000;

/** The duration the Operative and Bureau runs pass to `scheduleWakeup`. */
export const WAKEUP_MS = 3_600_000;

/** A small per-workflow claim TTL, so a dead holder's claim lapses on the virtual clock. */
export const CLAIM_TTL_MS = 1_000;
export const CLAIM_RENEW_MS = 250;

/**
 * Far enough past a claim's expiry for another engine to take it over: the
 * TTL plus Weft's takeover grace of two renewal intervals, plus one.
 */
export const CLAIM_TAKEOVER_ADVANCE_MS = CLAIM_TTL_MS + 2 * CLAIM_RENEW_MS + 1;

/** The one Weft workflow every Weft scenario drives. */
export const WEFT_WORKFLOW_ID = 'invocation-driven-order';
export const WEFT_WORKFLOW_INPUT = 'order-1';

/** The one Operative run the Operative scenario drives. */
export const OPERATIVE_RUN_ID = 'invocation-driven-agent-run';

const POLL_ATTEMPTS = 2000;
const POLL_DELAY_MS = 5;
const runtime = createDefaultRuntimeServices();

export function writeClock(directory: string, now: number): void {
  writeFileSync(join(directory, 'clock'), String(now), 'utf8');
}

export function readClock(directory: string): number {
  const now = Number(readFileSync(join(directory, 'clock'), 'utf8'));
  if (!Number.isFinite(now)) throw new Error(`invalid virtual clock in ${directory}`);
  return now;
}

/** The file whose existence releases an activity blocked by the invocation labelled `label`. */
export function releasePath(directory: string, label: string): string {
  return join(directory, `release-${label}`);
}

export function emit(event: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${INVOCATION_LINE_PREFIX}${JSON.stringify({ event, ...detail })}\n`);
}

/** Bounded condition poll. Fails the invocation with a message instead of hanging. */
export async function pollUntil(
  description: string,
  check: () => boolean | Promise<boolean>,
): Promise<void> {
  for await (const attempt of awakeTurns()) {
    if (await check()) return;
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, POLL_DELAY_MS));
  }
  process.stderr.write(`invocation: timed out waiting for ${description}\n`);
  process.exit(3);
}

/**
 * Called first thing inside an activity or tool. When this invocation was
 * told to block inside `name`, it announces `activity-started` and holds the
 * work open until the driver creates its release file. The driver may SIGKILL
 * it instead.
 */
export async function blockIfRequested(
  name: string,
  invocation: InvocationArguments,
): Promise<void> {
  if (invocation.blockActivity !== name) return;
  emit('activity-started', { activity: name });
  await pollUntil(`the driver to release ${name}`, () =>
    existsSync(releasePath(invocation.directory, invocation.label)),
  );
}

export interface InvocationArguments {
  readonly directory: string;
  readonly command: string;
  readonly label: string;
  /** The activity this invocation blocks inside, when the driver asked it to. */
  readonly blockActivity: string | undefined;
}

export function parseInvocationArguments(usage: string): InvocationArguments {
  const [directory, command, label, blockActivity] = process.argv.slice(2);
  if (directory === undefined || command === undefined || label === undefined) {
    process.stderr.write(`usage: ${usage} <directory> <command> <label> [block-activity]\n`);
    process.exit(2);
  }
  return { directory, command, label, blockActivity };
}
