/**
 * COR-1439 — a long-lived process hosting a durable Bureau.
 *
 * Every starting mode creates one durable run that commits step 0 and then
 * waits inside its step-1 model call, records the run id, and announces
 * `ready`. The reference handler then owns SIGINT and SIGTERM, and the mode
 * decides how the run's model call and the shutdown policy behave:
 *
 * - `drain`: `shutdown({ policy: 'drain' })`. A run offered after admission
 *   closed is refused, then the waiting call is released so the in-flight run
 *   reaches its own terminal result.
 * - `abort`: `shutdown({ policy: 'abort' })`. The waiting call rejects on the
 *   run's abort signal.
 * - `timeout`: `shutdown({ policy: 'drain', timeoutMilliseconds })` over a call
 *   that never settles, so the bounded wait elapses with owners unresolved.
 * - `interrupt`: a drain over a call that never settles; the handler's second
 *   SIGINT is the only way out.
 *
 * `recover` is the next process: it opens the same store, lets boot recovery
 * resume the run if it is still running, and records the run's terminal
 * status and how many model calls this process made for it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { stopWhen, createAgent } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import { createBureau } from '../../create-bureau';
import type { BureauShutdownReport } from '../../types';
import { announce, fail, parseHostArguments, writeMarker } from './host-support';
import { handleShutdownSignals } from './shutdown-handler';
import type { AgentDefinitions } from '../../agent-catalog';

/** Matches `process-crash-child.ts`, so a dead holder's claim lapses quickly. */
const CLAIM_TTL_MS = 200;
const CLAIM_RENEW_MS = 50;
const SHUTDOWN_TIMEOUT_MS = 100;
const POLL_ATTEMPTS = 2000;
const POLL_DELAY_MS = 5;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed-out']);

const runtime = createDefaultRuntimeServices();
const { mode, directory } = parseHostArguments([
  'drain',
  'abort',
  'timeout',
  'interrupt',
  'recover',
]);

const stepOneReached = Promise.withResolvers<void>();
const drainRelease = Promise.withResolvers<void>();
let stepZeroCalls = 0;
let laterStepCalls = 0;

const bureau = await createBureau<AgentDefinitions>({
  agents: {
    default: createAgent({
      generate: async ({ step, signal }) => {
        if (step === 0) {
          stepZeroCalls += 1;
          return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        laterStepCalls += 1;
        if (mode === 'recover') return { content: `recovered step ${step}`, toolCalls: [] };
        stepOneReached.resolve();
        if (mode === 'drain') {
          await drainRelease.promise;
          return { content: `drained step ${step}`, toolCalls: [] };
        }
        if (mode === 'abort') {
          return new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted during generate')), {
              once: true,
            });
          });
        }
        // `timeout` and `interrupt`: a call that never settles and ignores its signal.
        return new Promise<never>(() => {});
      },
      toolbox: createToolbox([
        createTool({
          name: 'next',
          description: 'continue',
          input: z.object({}),
          execute: async () => 'ok',
        }),
      ]),
      stopWhen: stopWhen.noToolCalls(),
    }),
  },
  storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
  durable: true,
  durableOwnership: {
    ownership: 'workflow-lease',
    workflowClaimTtlMs: CLAIM_TTL_MS,
    workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
  },
});

function summarize(report: BureauShutdownReport) {
  return {
    policy: report.policy,
    unresolved: report.unresolved,
    owners: report.owners.map((owner) => ({ kind: owner.kind, outcome: owner.outcome })),
  };
}

/** A run offered once shutdown has started must be refused. */
async function offerRunAfterAdmissionClosed(): Promise<string> {
  try {
    await bureau.createRun({
      agentName: 'default',
      message: 'offered during shutdown',
      principal: 'alice',
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return fail('a run was admitted after shutdown started');
}

async function recover(): Promise<never> {
  const { runId } = JSON.parse(readFileSync(join(directory, 'bureau-started.json'), 'utf8')) as {
    runId: string;
  };
  const report = await bureau.waitForRecovery?.();
  // The previous process may have died holding the run's claim; maintenance
  // adopts it once the claim lapses.
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const durable = await bureau.getDurableRun(runId);
    if (durable?.status !== undefined && TERMINAL_STATUSES.has(durable.status)) break;
    await bureau.runDurableMaintenance();
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, POLL_DELAY_MS));
  }
  const durable = await bureau.getDurableRun(runId);
  writeMarker(directory, 'bureau-recovered', {
    recovery: report?.outcome,
    durableStatus: durable?.status,
    stepZeroCalls,
    laterStepCalls,
  });
  const shutdown = await bureau.shutdown();
  process.exit(shutdown.unresolved === 0 ? 0 : 1);
}

if (mode === 'recover') await recover();

handleShutdownSignals({
  shutdown: async () => {
    const policy = mode === 'abort' ? 'abort' : 'drain';
    const reportPromise = bureau.shutdown({
      policy,
      ...(mode === 'timeout' ? { timeoutMilliseconds: SHUTDOWN_TIMEOUT_MS } : {}),
    });
    if (mode === 'interrupt') announce('draining');
    const refusal = mode === 'drain' ? await offerRunAfterAdmissionClosed() : undefined;
    drainRelease.resolve();
    const report = await reportPromise;
    writeMarker(directory, 'bureau-shutdown', {
      report: summarize(report),
      refusal,
      runStatus: bureau.getRun(runId)?.status,
    });
    return report.unresolved === 0;
  },
});

const run = await bureau.createRun({
  agentName: 'default',
  message: 'signal shutdown run',
  principal: 'alice',
});
const runId = run.id;
await stepOneReached.promise;
writeMarker(directory, 'bureau-started', { runId });
announce('ready', { runId });
