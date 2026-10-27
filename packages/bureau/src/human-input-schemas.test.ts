/**
 * COR-1674 — `BureauOptions.humanInput: { inputSchemas }` is validated when the Bureau is created
 * and reaches `requestHumanInput` on every wiring path, including a run recovered after a restart.
 * The A2A end-to-end flow (form part, valid answer delivered, invalid answer refused) is in
 * `http/a2a-input-form.test.ts`.
 */
import {
  createAgent,
  type GenerateFunction,
  type HumanInputSchema,
  HumanInputSchemaError,
  stopWhen,
} from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau } from './types';

const deploySchema: HumanInputSchema = {
  type: 'object',
  properties: { environment: { type: 'string', enum: ['staging', 'production'] } },
  required: ['environment'],
  additionalProperties: false,
};

const databasePaths: string[] = [];
const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const path of databasePaths.splice(0)) removeTemporaryPath(path);
});

const next = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

describe('BureauOptions.humanInput with inputSchemas', () => {
  it('refuses a schema operative cannot accept when the Bureau is created', async () => {
    const rejected = createBureau<AgentDefinitions>({
      agents: {},
      durable: true,
      durableOwnership: { ownership: 'none' },
      humanInput: {
        inputSchemas: { deploy: { type: 'object', properties: { x: { pattern: 'a' } } } },
      },
    });

    expect(await rejectionOf(rejected)).toBeInstanceOf(HumanInputSchemaError);
  });

  it('gives a run recovered after a restart the schema on its next park', async () => {
    const databasePath = createTemporaryPath('bureau-input-schemas', '.sqlite');
    databasePaths.push(databasePath);
    const open = async (generate: GenerateFunction) => {
      const bureau = await createBureau<AgentDefinitions>({
        agents: {
          scribe: createAgent({
            generate,
            toolbox: createToolbox([next]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: { type: 'sqlite', path: databasePath },
        durable: true,
        durableOwnership: { ownership: 'none' },
        humanInput: { inputSchemas: { deploy: deploySchema } },
      });
      bureaus.push(bureau);
      return bureau;
    };

    let reachedStepOne = false;
    const crashed = await open(async ({ step }) => {
      if (step === 0) return { content: '', toolCalls: [{ name: 'next', arguments: {} }] };
      reachedStepOne = true;
      return new Promise<never>(() => {});
    });
    const run = await crashed.tasks.start('scribe', 'deploy it');
    await waitForCondition(() => reachedStepOne, 'the first Bureau never reached step 1');
    // Not disposed: a graceful shutdown would cancel the run and leave nothing to recover.

    const restarted = await open(async ({ step }) =>
      step === 0
        ? { content: '', toolCalls: [{ name: 'next', arguments: {} }] }
        : {
            content: '',
            toolCalls: [
              {
                id: 'ask-1',
                name: 'requestHumanInput',
                arguments: { signalName: 'deploy', prompt: 'Where?' },
              },
            ],
          },
    );
    await waitForCondition(
      () => restarted.reviews.list().some((review) => review.runId === run.id),
      'the recovered run never parked',
    );

    const review = restarted.reviews.list().find((candidate) => candidate.runId === run.id);
    const detail = review === undefined ? undefined : await restarted.reviews.get(review.id);
    expect(detail?.kind).toBe('human-wait');
    expect(detail?.kind === 'human-wait' ? detail.inputSchema : undefined).toEqual(deploySchema);
  });
});
