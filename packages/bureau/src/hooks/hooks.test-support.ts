/**
 * Fixtures for the hooks tests (COR-1939): a scripted receiver that stands in for the endpoint a
 * hook POSTs to, a Bureau composed with hooks over injected `fetch`, clock and sleep, and the waits
 * that observe a delivery's record rather than a timer.
 */
import { generateEncryptionKey, type EncryptionKey } from '@lostgradient/cryptography';
import { createAgent } from '@lostgradient/operative';
import type { Storage } from '@lostgradient/storage';
import { createToolbox } from 'armorer';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createBureau } from '../create-bureau.ts';
import { waitForCondition } from '../test';
import type { Bureau, BureauOptions } from '../types.ts';
import type { HookDelivery, HookDeliveryStatus } from './hook-types.ts';

/** One request the scripted receiver saw. */
export type ReceivedCall = {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
  readonly redirect: RequestRedirect | undefined;
  readonly signal: AbortSignal | undefined;
};

/** Decides how the receiver answers its `index`th call (0-based). */
export type ReceiverScript = (call: ReceivedCall, index: number) => Response | Promise<Response>;

/** A `fetch` that records every call and answers by `script` (200 `ok` by default). */
export function createReceiver(script: ReceiverScript = () => new Response('ok')) {
  const calls: ReceivedCall[] = [];
  const receiverFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: ReceivedCall = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
      redirect: init?.redirect,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return script(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetch: receiverFetch };
}

/** A response that never arrives; the request fails when its signal aborts, as a real one does. */
export function hangUntilAborted(call: ReceivedCall): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
    if (call.signal?.aborted === true) abort();
    else call.signal?.addEventListener('abort', abort, { once: true });
  });
}

/** A clock a test moves by hand. */
export function createClock(start = 1_800_000_000_000) {
  const clock = { milliseconds: start };
  return { clock, now: () => clock.milliseconds };
}

/** A sleep that waits until the test releases it, and records how long each wait asked for. */
export function createManualSleep() {
  const requested: number[] = [];
  const pending: Array<() => void> = [];
  return {
    requested,
    sleep: (milliseconds: number) =>
      new Promise<void>((resolve) => {
        requested.push(milliseconds);
        pending.push(resolve);
      }),
    /** Lets every wait that is open now finish. */
    release(): void {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

/** The signing secret most tests use: unique, so a scan for it finds nothing else. */
export const SIGNING_SECRET = 'whsec-corvidae-test-9f3a6c1e0b27d845';

/** A key to seal secrets with, made once per test file. */
export function newEncryptionKey(): Promise<EncryptionKey> {
  return generateEncryptionKey();
}

export type OpenedHooksBureau = {
  readonly bureau: Bureau;
  dispose(): Promise<void>;
};

/** What {@link openHooksBureau} takes beyond the storage and the receiver. */
export type OpenHooksBureauOptions = {
  readonly storage: Storage;
  readonly fetch: typeof fetch;
  readonly key: EncryptionKey;
  readonly now?: () => number;
  readonly maxAttempts?: number;
  readonly hooks?: NonNullable<BureauOptions['hooks']>;
  readonly onDiagnostic?: BureauOptions['onDiagnostic'];
  readonly withoutKey?: boolean;
  readonly retention?: BureauOptions['retention'];
  /** Replaces the instant backoff wait, for a test that holds a wait open. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

/** A Bureau with one agent that answers at once, hooks on, and delivery over the injected `fetch`. */
export async function openHooksBureau(options: OpenHooksBureauOptions): Promise<OpenedHooksBureau> {
  const bureau = await createBureau<AgentDefinitions>({
    id: 'hooks-bureau',
    agents: {
      default: createAgent({
        generate: async () => ({ content: 'done', toolCalls: [] }),
        toolbox: createToolbox([]),
      }),
    },
    storage: options.storage,
    durable: true,
    durableOwnership: { ownership: 'none' },
    ...(options.withoutKey === true ? {} : { answerEncryption: { current: options.key } }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    ...(options.retention === undefined ? {} : { retention: options.retention }),
    hooks: options.hooks ?? {},
    webhooks: {
      targets: [],
      fetch: options.fetch,
      // Backoff waits are not what these tests measure; the delivery's record is.
      sleep: options.sleep ?? (() => Promise.resolve()),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    },
  });
  return { bureau, dispose: () => bureau.dispose() };
}

/** The deliveries of `hookId`, oldest first. */
export async function deliveriesOf(bureau: Bureau, hookId: string): Promise<HookDelivery[]> {
  const newestFirst = await bureau.hooks!.deliveries(hookId);
  return newestFirst.toReversed();
}

/** Waits until `hookId` has `count` deliveries and none of them is still pending. */
export async function waitForSettledDeliveries(
  bureau: Bureau,
  hookId: string,
  count: number,
): Promise<HookDelivery[]> {
  await waitForCondition(async () => {
    const deliveries = await deliveriesOf(bureau, hookId);
    return deliveries.length >= count && deliveries.every((d) => d.status !== 'pending');
  }, `hook ${hookId} never settled ${count} deliveries`);
  return deliveriesOf(bureau, hookId);
}

/** Waits until a delivery of `hookId` has `status`. */
export async function waitForStatus(
  bureau: Bureau,
  hookId: string,
  status: HookDeliveryStatus,
): Promise<HookDelivery> {
  let found: HookDelivery | undefined;
  await waitForCondition(async () => {
    const deliveries = await deliveriesOf(bureau, hookId);
    found = deliveries.find((d) => d.status === status);
    return found !== undefined;
  }, `hook ${hookId} never had a ${status} delivery`);
  return found!;
}

/** Starts a task, which publishes `run.registered` and `run.settled`. */
export async function fireRunEvents(bureau: Bureau, principal = 'api-key:alice'): Promise<void> {
  await bureau.tasks.start('default', 'hello', { principal });
}
