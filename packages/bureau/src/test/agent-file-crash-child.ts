/**
 * COR-1524 — the child half of the agent file crash test.
 *
 * Usage: `bun agent-file-crash-child.ts <storagePath> <agentDirectory> <markerPath>`
 *
 * Stands up a durable Bureau over an agent directory that holds `gone.md` and `edited.md`, starts
 * a `bureau.run` run and a session run of each, lets every one commit step 0 (a tool call) and park
 * in step 1, writes the marker, and kills itself with SIGKILL. The parent then deletes one file,
 * rewrites the other, and boots a Bureau over the same store.
 *
 * Not a test file: it is spawned by `agent-file-crash.test.ts`.
 */
import { writeFileSync } from 'node:fs';

import { stopWhen } from '@lostgradient/operative';

import { createBureau } from '../create-bureau';
import { lookupTool } from '../testing/agent-file-fixtures.test-support';
import { CLAIM_RENEW_MS, CLAIM_TTL_MS } from './process-crash-work-integrity-fixtures';

const [storagePath, agentDirectory, markerPath] = process.argv.slice(2);
if (storagePath === undefined || agentDirectory === undefined || markerPath === undefined) {
  process.stderr.write(
    'usage: agent-file-crash-child <storagePath> <agentDirectory> <markerPath>\n',
  );
  process.exit(2);
}

const RUNS_EXPECTED = 4;
let parked = 0;

const bureau = await createBureau({
  agents: {},
  agentDirectory,
  agentTools: { 'lookup-order': lookupTool },
  resolveAgentGenerate:
    () =>
    async ({ step }) => {
      if (step === 0) {
        return { content: 'step 0', toolCalls: [{ name: 'lookup-order', arguments: {} }] };
      }
      // Step 0's checkpoint has committed once step 1 is requested.
      parked += 1;
      return new Promise<never>(() => {});
    },
  stopWhen: stopWhen.noToolCalls(),
  storage: { type: 'sqlite', path: storagePath },
  durableExecution: true,
  durableOwnership: {
    ownership: 'workflow-lease',
    workflowClaimTtlMs: CLAIM_TTL_MS,
    workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
  },
});

const runs: Array<{ name: string; kind: 'catalog' | 'session'; runId: string }> = [];
for (const name of ['gone', 'edited']) {
  const catalog = bureau.run(name, 'crash harness');
  runs.push({ name, kind: 'catalog', runId: catalog.id });
  const session = await bureau.createRun({ message: 'crash harness', agentName: name });
  runs.push({ name, kind: 'session', runId: session.id });
}

for (let attempt = 0; parked < RUNS_EXPECTED; attempt += 1) {
  if (attempt > 4000) {
    process.stderr.write(`child: only ${parked} of ${RUNS_EXPECTED} runs reached step 1\n`);
    process.exit(3);
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

// Written synchronously so it is on disk before the kill. No `dispose()`, deliberately.
writeFileSync(markerPath, JSON.stringify({ runs }), 'utf8');
process.kill(process.pid, 'SIGKILL');
