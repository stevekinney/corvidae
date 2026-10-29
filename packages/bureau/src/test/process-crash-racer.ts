/**
 * COR-1390 — one of the two racing successors in `process-crash-recovery.test.ts`. The test boots
 * one racer in its own process and the other in `process-crash-child.ts` (`race-recover`), so no
 * process holds two handles on the store a crashed child left behind (COR-1795). Both build the
 * Bureau here, so the two racers differ only in the process they run in.
 */
import { stopWhen, createAgent } from '@lostgradient/operative';
import type { Storage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import { createBureau } from '../create-bureau';
import type { AgentDefinitions } from '../agent-catalog';
import type { Bureau } from '../types';
import { CLAIM_RENEW_MS, CLAIM_TTL_MS } from './process-crash-work-integrity-fixtures';

/** The file the child racer writes once its store is open. */
export const RACER_READY_FILE = 'racer-ready';
/** The file the parent writes to start both racers together. */
export const RACER_GO_FILE = 'racer-go';
/** The file the child racer writes its {@link RacerReport} to. */
export const RACER_REPORT_FILE = 'racer.json';

/** A racing successor and how often its agent was asked to run each step. */
export interface Racer {
  readonly bureau: Bureau;
  readonly stepsAtOrAfterOne: () => number;
  readonly stepZeroCalls: () => number;
}

/** What a racer observed once the recovered run settled, as the child reports it. */
export interface RacerReport {
  readonly recoveryOutcome: string | undefined;
  readonly perRunFailures: readonly unknown[] | undefined;
  /** The racer itself ran the run to completion, rather than observing its peer's commit. */
  readonly completedLocally: boolean;
  readonly durableStatus: string | undefined;
  readonly stepsAtOrAfterOne: number;
  readonly stepZeroCalls: number;
}

function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

/** Boots a durable Bureau under `workflow-lease` ownership that counts its agent's step calls. */
export async function startRacer(storage: Storage): Promise<Racer> {
  let stepsAtOrAfterOne = 0;
  let stepZeroCalls = 0;
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async ({ step }) => {
          if (step === 0) stepZeroCalls += 1;
          else stepsAtOrAfterOne += 1;
          return { content: `recovered step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage,
    durable: true,
    durableOwnership: {
      ownership: 'workflow-lease',
      workflowClaimTtlMs: CLAIM_TTL_MS,
      workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
    },
  });
  return {
    bureau,
    stepsAtOrAfterOne: () => stepsAtOrAfterOne,
    stepZeroCalls: () => stepZeroCalls,
  };
}

/**
 * Recovers, waits for the run to settle durably, whichever racer ran it, and reports what this
 * racer saw. The peer may be another process, which this Bureau hears nothing from, so the wait
 * reads the durable record rather than waiting for an announcement. The racer that ran the
 * interrupted step is the one that completes the run locally, so it alone also waits for that.
 */
export async function settleRacer(racer: Racer, runId: string): Promise<RacerReport> {
  const report = await racer.bureau.recovery();
  const durableStatus = async (): Promise<string | undefined> => {
    const durable = await racer.bureau.tasks.workflow(runId);
    return durable?.status;
  };
  await waitUntil(async () => (await durableStatus()) === 'completed', {
    message: `the recovered run ${runId} to complete durably`,
  });
  // Weft's own result waiter: it settles after the durable commit, for the loser too.
  await racer.bureau.tasks.wait(runId);
  if (racer.stepsAtOrAfterOne() > 0) {
    await waitUntil(() => racer.bureau.tasks.detail(runId)?.status === 'completed', {
      message: `the racer that ran ${runId} to complete it locally`,
    });
  }
  return {
    recoveryOutcome: report?.outcome,
    perRunFailures: report?.perRunFailures,
    completedLocally: racer.bureau.tasks.detail(runId)?.status === 'completed',
    durableStatus: await durableStatus(),
    stepsAtOrAfterOne: racer.stepsAtOrAfterOne(),
    stepZeroCalls: racer.stepZeroCalls(),
  };
}
