/**
 * What the chat specs share: sessions seeded through the AG-UI mount (the way a client other than
 * the page would start one), and the barrier the specs hold a run on (`barrier-agent.ts`), so no
 * case waits on a clock.
 */
import type { APIRequestContext } from '@playwright/test';

import { E2E_BARRIER_URL, E2E_BASE_URL } from './e2e-constants.ts';
import { expect } from './fixtures.ts';

const AG_UI = `${E2E_BASE_URL}/bureau/ag-ui`;

/** A thread identifier no other case uses. */
export function newThreadId(label: string): string {
  return `e2e-${label}-${crypto.randomUUID()}`;
}

function runInput(threadId: string, message: string, extra: Record<string, unknown> = {}) {
  return {
    threadId,
    runId: `run-${crypto.randomUUID()}`,
    messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: message }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    ...extra,
  };
}

/**
 * Starts a run and reads its stream to the end; the session exists afterwards. `origin` is the host
 * the run starts on: the main host unless a spec names another.
 */
export async function runToEnd(
  request: APIRequestContext,
  agent: string,
  threadId: string,
  message: string,
  extra: Record<string, unknown> = {},
  origin: string = E2E_BASE_URL,
): Promise<string> {
  const response = await request.post(`${origin}/bureau/ag-ui/agents/${agent}/run`, {
    headers: { accept: 'text/event-stream' },
    data: runInput(threadId, message, extra),
  });
  expect(response.status()).toBe(200);
  return response.text();
}

/** A run left going: its stream is open and the caller reads nothing, so the run waits where it is. */
export async function startRun(
  agent: string,
  threadId: string,
  message: string,
): Promise<AbortController> {
  const controller = new AbortController();
  const response = await fetch(`${AG_UI}/agents/${agent}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(runInput(threadId, message)),
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  return controller;
}

/** The interrupt a settled stream ended on. */
export function interruptIdOf(stream: string): string {
  const match = /"interrupts":\[\{"id":"([^"]+)"/.exec(stream);
  if (match?.[1] === undefined) throw new Error('The stream ended on no interrupt.');
  return match[1];
}

/** Resolves the approval a tool-runner session is waiting on, as another client would. */
export async function approveThroughMount(
  request: APIRequestContext,
  threadId: string,
  stream: string,
): Promise<string> {
  return runToEnd(request, 'tool-runner', threadId, 'Refund order-1001', {
    messages: [],
    resume: [
      { interruptId: interruptIdOf(stream), status: 'resolved', payload: { decision: 'approve' } },
    ],
  });
}

export async function waitingOnBarrier(request: APIRequestContext): Promise<number> {
  const response = await request.get(`${E2E_BARRIER_URL}/waiting`);
  return ((await response.json()) as { waiting: number }).waiting;
}

/** Waits until `count` runs are held at the barrier. */
export async function expectWaiting(request: APIRequestContext, count: number): Promise<void> {
  await expect.poll(() => waitingOnBarrier(request)).toBe(count);
}

export async function releaseBarrier(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${E2E_BARRIER_URL}/release`);
  expect(response.ok()).toBe(true);
}
