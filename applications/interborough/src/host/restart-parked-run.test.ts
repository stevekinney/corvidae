import { awakeTurns } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import { HUMAN_INPUT_PROMPT, HUMAN_INPUT_SIGNAL } from './seed.ts';

const homes: string[] = [];
const hosts: Host[] = [];

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-parked-run-'));
  homes.push(home);
  return home;
}

async function start(home: string): Promise<Host> {
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    seed: false,
  });
  hosts.push(host);
  return host;
}

async function waitForReview(host: Host, runId: string) {
  for await (const _turn of awakeTurns()) {
    const review = host.bureau.reviews.list().find((candidate) => candidate.runId === runId);
    if (review !== undefined) return review;
  }
  throw new Error(`Run "${runId}" did not raise a review.`);
}

async function waitForCompleted(host: Host, runId: string): Promise<void> {
  for await (const _turn of awakeTurns()) {
    const run = await host.bureau.getDurableRun(runId);
    if (run?.status === 'completed') return;
  }
  throw new Error(`Run "${runId}" did not complete.`);
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe('a parked run across a clean host restart', () => {
  test('keeps the review and completes after the next host resolves it', async () => {
    const home = await createHome();
    const first = await start(home);
    const run = await first.bureau.createRun({
      agentName: 'request-human-input',
      message: 'Ship the release',
    });
    const firstReview = await waitForReview(first, run.id);
    expect(firstReview).toMatchObject({
      kind: 'human-wait',
      runId: run.id,
      signalName: HUMAN_INPUT_SIGNAL,
      prompt: HUMAN_INPUT_PROMPT,
    });

    await first.close();
    const second = await start(home);
    const secondReview = await waitForReview(second, run.id);
    expect(secondReview.id).toBe(firstReview.id);

    await second.bureau.reviews.resolve({
      id: secondReview.id,
      decision: 'approve',
      principal: 'anonymous:local',
      payload: { environment: 'staging' },
    });
    await waitForCompleted(second, run.id);
    expect(second.bureau.reviews.list()).toEqual([]);
  });
});
