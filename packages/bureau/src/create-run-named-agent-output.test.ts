/**
 * COR-1577 — a named agent's structured-output contract (`output`, `schemaRetries`,
 * `schemaRetryMessage`) holds on a session run exactly as it does on `bureau.run()`, on a fresh
 * start and after a restart. These are agent-owned options; the class is covered by
 * `session-agent-options.test.ts`.
 */

import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { waitForTaskState } from './test';
import { withResolvedOptions } from './testing/named-agent.test-support';
import type { Bureau } from './types';

const bureaus: Bureau<AgentDefinitions>[] = [];
const databasePaths: string[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const path of databasePaths.splice(0)) {
    removeTemporaryPath(path);
  }
});

const answerSchema = z.object({ answer: z.string() });
const RETRY_MESSAGE = 'Reply with JSON that has an "answer" string.';

/** Malformed first, then valid: an agent that honors the contract calls this twice. */
function malformedThenValid(calls: number[]): GenerateFunction {
  return async ({ step }) => {
    calls.push(step);
    return calls.length === 1
      ? { content: 'not json at all', toolCalls: [] }
      : { content: '{"answer":"42"}', toolCalls: [] };
  };
}

function structuredAgent(generate: GenerateFunction) {
  return withResolvedOptions(
    createAgent({
      generate,
      toolbox: createToolbox([]),
      output: answerSchema,
      stopWhen: stopWhen.noToolCalls(),
    }),
    { schemaRetries: 1, schemaRetryMessage: () => RETRY_MESSAGE },
  );
}

async function pollUntil(check: () => boolean | Promise<boolean>, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('Condition was not met.');
}

describe('a named agent’s structured output on a session run', () => {
  it('is retried as bureau.run() retries it, with the agent’s own retry message', async () => {
    const viaRun: number[] = [];
    const viaSession: number[] = [];
    const messages: string[] = [];
    const sessionGenerate: GenerateFunction = async (context) => {
      messages.push(JSON.stringify(context.conversation.current));
      return malformedThenValid(viaSession)(context);
    };
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        viaRun: structuredAgent(malformedThenValid(viaRun)),
        viaSession: structuredAgent(sessionGenerate),
      },
      storage: { type: 'memory' },
      durable: false,
    });
    bureaus.push(bureau);

    const direct = await bureau.run('viaRun', 'question').result();
    const run = await bureau.createRun({ message: 'question', agentName: 'viaSession' });
    await waitForTaskState(bureau, run.id);

    // The same contract: one retry, then the valid answer.
    expect(viaRun).toHaveLength(2);
    expect(direct.finishReason).not.toBe('error');
    expect(viaSession).toHaveLength(2);
    expect(messages.at(-1)).toContain('Reply with JSON');
    expect(bureau.tasks.detail(run.id)?.status).toBe('completed');
  });
});

describe('a named agent’s structured output after a restart', () => {
  it('is still enforced when the run resumes', async () => {
    const databasePath = createTemporaryPath('bureau-named-output', '.sqlite');
    databasePaths.push(databasePath);
    const next = createTool({
      name: 'next',
      description: 'continue',
      input: z.object({}),
      execute: async () => 'ok',
    });
    let reachedStep1 = false;
    const crashed = await createBureau<AgentDefinitions>({
      agents: {
        scribe: createAgent({
          generate: async ({ step }) => {
            if (step === 0) {
              return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            reachedStep1 = true;
            return new Promise<never>(() => {});
          },
          toolbox: createToolbox([next]),
          output: answerSchema,
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'sqlite', path: databasePath },
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(crashed);
    const run = await crashed.createRun({ message: 'go', agentName: 'scribe' });
    await pollUntil(() => reachedStep1);
    // Left running on purpose: a graceful shutdown would cancel the run and leave nothing to resume.

    const resumedSteps: number[] = [];
    const restarted = await createBureau<AgentDefinitions>({
      agents: {
        scribe: withResolvedOptions(
          createAgent({
            generate: async ({ step }) => {
              resumedSteps.push(step);
              return resumedSteps.length === 1
                ? { content: 'not json at all', toolCalls: [] }
                : { content: '{"answer":"42"}', toolCalls: [] };
            },
            toolbox: createToolbox([next]),
            output: answerSchema,
            stopWhen: stopWhen.noToolCalls(),
          }),
          { schemaRetries: 1, schemaRetryMessage: () => RETRY_MESSAGE },
        ),
      },
      storage: { type: 'sqlite', path: databasePath },
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(restarted);
    await pollUntil(async () => {
      const session = await restarted.contexts.get(run.sessionId);
      return session?.metadata['lastRunStatus'] === 'completed';
    });

    // The malformed first answer was retried, so the contract survived the restart.
    expect(resumedSteps).toHaveLength(2);
  });
});
