/**
 * COR-1577 — a named session run survives a restart as that agent, and parks for human input the
 * way a Bureau-wide run does. Recovery reuses the catalog path's policy: an agent gone from the
 * catalog fails the run, and one whose definition moved on is warned about and resumed.
 */

import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { getMessages } from 'conversationalist';
import { z } from 'zod';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { waitForRunState } from './test';
import type { Bureau } from './types';

const databasePaths: string[] = [];
const bureaus: Bureau<AgentDefinitions>[] = [];

function nextDatabasePath(): string {
  const path = createTemporaryPath('bureau-named-agent', '.sqlite');
  databasePaths.push(path);
  return path;
}

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const path of databasePaths.splice(0)) {
    removeTemporaryPath(path);
  }
});

const next = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

async function pollUntil(check: () => boolean | Promise<boolean>, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('Condition was not met.');
}

async function assistantReplies(
  bureau: Bureau<AgentDefinitions>,
  sessionId: string,
): Promise<string[]> {
  const session = await bureau.getSession(sessionId);
  if (session === undefined) throw new Error(`Expected session "${sessionId}".`);
  return getMessages(session.conversationHistory)
    .filter((message) => message.role === 'assistant')
    .map((message) => (typeof message.content === 'string' ? message.content : ''));
}

/** A Bureau over `databasePath` whose one agent, `scribe`, answers from `generate`. */
async function bureauOver(
  databasePath: string,
  options: {
    readonly scribe?: GenerateFunction;
    readonly wide?: GenerateFunction;
    readonly revision?: number;
    readonly warnings?: string[];
  },
): Promise<Bureau<AgentDefinitions>> {
  const scribe =
    options.scribe === undefined
      ? undefined
      : createAgent({
          generate: options.scribe,
          toolbox: createToolbox([next]),
          stopWhen: stopWhen.noToolCalls(),
        });
  const bureau = await createBureau<AgentDefinitions>({
    agents:
      scribe === undefined
        ? {}
        : {
            scribe:
              options.revision === undefined
                ? scribe
                : {
                    ...scribe,
                    generationProfile: { ...scribe.generationProfile, revision: options.revision },
                  },
          },
    ...(options.wide === undefined
      ? {}
      : { generate: options.wide, toolbox: createToolbox([next]) }),
    ...(options.warnings === undefined
      ? {}
      : {
          onDiagnostic: (diagnostic) => {
            if (diagnostic.level === 'warn') options.warnings?.push(diagnostic.message);
          },
        }),
    storage: { type: 'sqlite', path: databasePath },
    durableExecution: true,
    durableOwnership: { ownership: 'none' },
    stopWhen: stopWhen.noToolCalls(),
  });
  bureaus.push(bureau);
  return bureau;
}

/** Start a `scribe` run on a Bureau whose process then "dies" parked at step 1. */
async function startRunThatDies(databasePath: string) {
  let reachedStep1 = false;
  const crashed = await bureauOver(databasePath, {
    scribe: async ({ step }) => {
      if (step === 0) {
        return { content: 'scribe step 0', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      reachedStep1 = true;
      return new Promise<never>(() => {});
    },
    wide: async () => ({ content: 'wide never answers', toolCalls: [] }),
  });
  const run = await crashed.createRun({ message: 'Recover me', agentName: 'scribe' });
  await pollUntil(() => reachedStep1);
  // The first Bureau is deliberately not disposed: a graceful shutdown would cancel the run and
  // leave nothing for the restart to recover. The afterEach hook releases it.
  return run;
}

describe('a named session run after a restart', () => {
  it('resumes with the agent’s own script, not the Bureau-wide one', async () => {
    const databasePath = nextDatabasePath();
    const run = await startRunThatDies(databasePath);
    const wideCalls: number[] = [];

    const restarted = await bureauOver(databasePath, {
      scribe: async ({ step }) => ({ content: `scribe resumed at ${step}`, toolCalls: [] }),
      wide: async ({ step }) => {
        wideCalls.push(step);
        return { content: 'wide answered', toolCalls: [] };
      },
    });
    await pollUntil(async () => {
      const session = await restarted.getSession(run.sessionId);
      return session?.metadata['lastRunStatus'] === 'completed';
    });

    expect(await assistantReplies(restarted, run.sessionId)).toEqual([
      'scribe step 0',
      'scribe resumed at 1',
    ]);
    expect(wideCalls).toEqual([]);
  });

  it('fails as the catalog path does when its agent has left the catalog', async () => {
    const databasePath = nextDatabasePath();
    const run = await startRunThatDies(databasePath);

    const restarted = await bureauOver(databasePath, {
      wide: async () => ({ content: 'wide answered', toolCalls: [] }),
    });
    await pollUntil(async () => {
      const session = await restarted.getSession(run.sessionId);
      return session?.metadata['lastRunStatus'] !== 'running';
    });

    const session = await restarted.getSession(run.sessionId);
    expect(session?.metadata['lastRunStatus']).toBe('error');
    const lastError = session?.metadata['lastError'];
    expect(typeof lastError === 'string' ? lastError : '').toContain('no longer in the catalog');
  });

  it('warns and resumes with the current definition when its revision has moved on', async () => {
    const databasePath = nextDatabasePath();
    const run = await startRunThatDies(databasePath);

    const warnings: string[] = [];
    const restarted = await bureauOver(databasePath, {
      scribe: async () => ({ content: 'scribe, revised', toolCalls: [] }),
      revision: 2,
      warnings,
    });
    await pollUntil(async () => {
      const session = await restarted.getSession(run.sessionId);
      return session?.metadata['lastRunStatus'] === 'completed';
    });

    expect(await assistantReplies(restarted, run.sessionId)).toContain('scribe, revised');
    expect(warnings.some((warning) => warning.includes('definition revision changed'))).toBe(true);
  });
});

describe('requestHumanInput on a named session run', () => {
  it('parks for a review and resumes once the review is resolved', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        asker: createAgent({
          generate: async ({ step }) =>
            step === 0
              ? {
                  content: '',
                  toolCalls: [
                    {
                      id: 'call-1',
                      name: 'requestHumanInput',
                      arguments: { signalName: 'answer', prompt: 'Which environment?' },
                    },
                  ],
                }
              : { content: 'thanks, deploying', toolCalls: [] },
          toolbox: createToolbox([]),
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    bureaus.push(bureau);

    const run = await bureau.createRun({ message: 'deploy', agentName: 'asker' });
    await pollUntil(() => bureau.listPendingReviews().some((review) => review.runId === run.id));
    const [review] = bureau.listPendingReviews();
    if (review === undefined || review.kind !== 'human-wait') throw new Error('Expected a park.');
    expect(review).toMatchObject({
      runId: run.id,
      sessionId: run.sessionId,
      agentName: 'asker',
      prompt: 'Which environment?',
    });

    await bureau.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: 'operator',
      payload: { environment: 'staging' },
    });
    await waitForRunState(bureau, run.id);

    await pollUntil(async () => {
      const replies = await assistantReplies(bureau, run.sessionId);
      return replies.includes('thanks, deploying');
    });
    expect(bureau.listPendingReviews()).toEqual([]);
  });
});
