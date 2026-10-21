/**
 * E2E-only host bootstrap. `playwright.config.ts`'s `webServer` runs this directly
 * (`bun tests/e2e/e2e-server.ts`).
 *
 * It builds the application, then starts the real host (`src/host/host.ts`) in a scratch state
 * directory on a fixed port, with the console's seeded fixtures (`fixtures/workflows.ts`,
 * append-only, read here rather than mutated) registered on the engine behind the Engine
 * console. One process serves the built application, the engine API, and a Bureau, so every
 * request acts as `anonymous:local` and the specs need no credential.
 *
 * It also registers one `RemoteWorker` under `E2E_DEPLOYMENT_NAME` so the Workers → Fleet
 * overview surface has a real deployment group to drain (flow (e)). It advertises
 * `order-processing`'s `chargeCard` activity, already registered on the engine, but nothing ever
 * dispatches a task to it, so it is present purely as fleet inventory, never doing real work. The
 * worker connects through the host's public origin, as any other worker would.
 *
 * The fixtures start workflows after the host is listening, so their lifecycle events land in the
 * fleet feed's replay buffer exactly as a workflow started after boot would.
 */
import { Engine, LongPollWorker, RemoteWorker } from '@lostgradient/weft';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { seedDynamicSources } from '../../fixtures/dynamic-sources.ts';
import { seedRefreshSources } from '../../fixtures/workflow-refresh.ts';
import { seedWorkflowRevisions } from '../../fixtures/workflow-revisions.ts';
import { seed, workflows } from '../../fixtures/workflows.ts';
import { buildApplication } from '../../scripts/build.ts';
import { fakeProvider, writeProviderHome } from '../../src/host/fake-provider.test-support.ts';
import { startHost } from '../../src/host/host.ts';
import {
  BARRIER_AGENT_NAME,
  BARRIER_SHORT_AGENT_NAME,
  createBarrier,
  createBarrierAgents,
} from './barrier-agent.ts';
import {
  E2E_BARRIER_PORT,
  E2E_BUREAU_PORT,
  E2E_CANCELLATION_GRACE_PERIOD_MS,
  E2E_DEPLOYMENT_NAME,
  E2E_JOURNEY_PORT,
  E2E_LONG_POLL_BUILD_ID,
  E2E_LONG_POLL_DEPLOYMENT_NAME,
  E2E_LONG_POLL_QUEUE,
  E2E_PORT,
  E2E_RECONNECT_GRACE_PERIOD_MS,
  E2E_TASK_OPERATION_ID,
} from './e2e-constants.ts';
import { createEchoAgents, ECHO_AGENT_NAME } from './echo-agent.ts';
import { createFireQuestionGenerate } from './fire-question.ts';
import {
  createJourneyProviderResolver,
  createRecallAgents,
  RECALL_AGENT_NAME,
} from './journey-agent.ts';
import { seedLedgerEvidence } from './ledger-evidence-seed.ts';
import { SEEDED_WORKFLOW_FILES } from './seeded-workflow-files.ts';
import {
  createTextEchoAgents,
  TEXT_ECHO_AGENT_NAME,
  TEXT_ECHO_SOLO_AGENT_NAME,
} from './text-echo-agent.ts';
import { seedVersionedRuns } from './versioned-run-seed.ts';

const scratch = await mkdtemp(join(tmpdir(), 'interborough-e2e-'));
const buildDirectory = join(scratch, 'build');
await buildApplication({ outdir: buildDirectory });

// The host's model catalog holds a model, so the agent editor can save an agent: the home names the
// `anthropic` provider with a fixture key in its secrets, and the provider path runs against a fake
// client that answers with a fixed reply. No model is called and no real key is read.
const home = join(scratch, 'home');
await mkdir(home, { recursive: true });
// Two models, so a spec can change an agent's model and save it.
await writeProviderHome(home, ['sonnet', 'claude-haiku-4-5']);
const provider = fakeProvider('This reply comes from the end-to-end provider stub.');

// Three workflow files, in the directory the Bureau reads at start (`26-workflows.spec.ts`): one
// that loads and is started by a schedule, one started by a signal whose one step waits for another,
// and one the Bureau cannot use. Each is written as a person would write it, by hand.
const workflowDirectory = join(home, 'workflows');
await mkdir(workflowDirectory, { recursive: true });
for (const [name, document] of Object.entries(SEEDED_WORKFLOW_FILES)) {
  await writeFile(
    join(workflowDirectory, `${name}.json`),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

// The fixtures run on an engine of their own over memory storage, as they always have. Sharing the
// Bureau's database would put two engines' timers and ownership claims on one set of keys, which
// the fixtures' own sleeps and restarts would trip over.
function createFixtureEngine() {
  return Engine.create({ workflows });
}

// The host takes any engine; the fixtures want the typed one, so it is kept as it is created.
let fixtureEngine: Awaited<ReturnType<typeof createFixtureEngine>> | undefined;
// Two agents whose first step waits until a spec releases it (`barrier-agent.ts`), published
// beside the seeded ones. Every chat case that needs a run still in progress uses them. A third,
// the echo (`echo-agent.ts`), takes an attached image and sends it back. Two more, the text echoes
// (`text-echo-agent.ts`), answer with what they were sent, so a memory spec can store a memory that
// is its own.
const barrier = createBarrier();
const host = await startHost({
  // A schedule's fire runs this, not its agent's script: it asks a question for one input.
  generate: createFireQuestionGenerate(),
  extraAgents: {
    agents: { ...createBarrierAgents(barrier), ...createEchoAgents(), ...createTextEchoAgents() },
    published: [
      BARRIER_AGENT_NAME,
      BARRIER_SHORT_AGENT_NAME,
      ECHO_AGENT_NAME,
      TEXT_ECHO_AGENT_NAME,
      TEXT_ECHO_SOLO_AGENT_NAME,
    ],
  },
  environment: { INTERBOROUGH_HOME: home },
  resolveProviderGenerate: provider.resolver,
  port: E2E_PORT,
  buildDirectory,
  createConsoleEngine: async () => {
    fixtureEngine = await createFixtureEngine();
    // One conditional-refresh source on each of three eager workflows (COR-166),
    // registered before the host listens: the refresh panel reads its sources once,
    // and the first spec loads it the moment the server answers. See
    // `fixtures/workflow-refresh.ts`'s module doc.
    await seedRefreshSources(fixtureEngine);
    return fixtureEngine;
  },
  engineServer: {
    cancellationGracePeriodMs: E2E_CANCELLATION_GRACE_PERIOD_MS,
    workerReconnectGracePeriodMs: E2E_RECONNECT_GRACE_PERIOD_MS,
  },
});
if (fixtureEngine === undefined) throw new Error('The host did not create the console engine.');
const engine = fixtureEngine;
const { server } = host;

await seed(engine);

// Second, deliberately incompatible installed-but-inactive revision of
// `order-processing` (WFT-115) — `07-activate-workflow-revision.spec.ts`
// exercises the Registry → Revisions panel's refused-activation path
// against it. See `fixtures/workflow-revisions.ts`'s module doc; a refusal
// never mutates the active pointer, so this is safe to install once and
// leave here for every spec in this suite.
await seedWorkflowRevisions(engine);

// Two `registerSource()` revisions of `invoice-reconciliation`, neither
// loaded (WFT-116/WFT-165) — `09-preload-dynamic-source.spec.ts` drives the
// Registry → Dynamic workflow sources panel against the selectable source
// list plus exact diagnostics/preload calls: preloading the loadable one moves
// it idle -> ready, and preloading the unreachable one is refused with a
// bounded failure category. Both transitions are per-`(name, revision)` and
// touch nothing any other spec asserts against, but they are NOT idempotent
// across specs the way a refused activation is: once a spec preloads the
// loadable revision it stays installed, so the spec asserts on the
// ready/failed end state rather than requiring a pristine idle one.
seedDynamicSources(engine);

const fleetWorker = new RemoteWorker({
  serverUrl: `ws://127.0.0.1:${E2E_PORT}/v1/tasks/default/stream`,
  workerId: 'e2e-fleet-worker-1',
  deploymentName: E2E_DEPLOYMENT_NAME,
  buildId: 'e2e-build-1',
  workflows: {
    'order-processing': {
      name: 'order-processing',
      activities: {
        chargeCard: async () => ({ chargeId: 'unused-e2e-fixture-worker' }),
        reserveInventory: async () => {
          throw new Error('seeded inventory outage');
        },
      },
    },
  },
});

await fleetWorker.connect();

// COR-160: one worker on the HTTP long-poll transport, so the Workers surfaces show both
// transports in one fleet. It advertises no workflow and its queue has no task, so it only
// polls and heartbeats, which is the session state the spec reads.
const longPollWorker = new LongPollWorker({
  serverUrl: `http://127.0.0.1:${E2E_PORT}`,
  deploymentName: E2E_LONG_POLL_DEPLOYMENT_NAME,
  buildId: E2E_LONG_POLL_BUILD_ID,
  queue: E2E_LONG_POLL_QUEUE,
  workflows: {},
  pollTimeout: 5_000,
  heartbeatIntervalMs: 2_000,
});
longPollWorker.start();
for (let wait = 0; wait < 200 && !longPollWorker.ready; wait += 1) await Bun.sleep(25);
if (!longPollWorker.ready) throw new Error('The E2E long-poll worker did not register.');

await server.dispatchTask({
  operationId: E2E_TASK_OPERATION_ID,
  workflowId: 'e2e-ledger-workflow',
  workflowExecutionToken: 'e2e-ledger-token',
  workflowType: 'order-processing',
  activityName: 'reserveInventory',
  input: { orderId: 'e2e-ledger-order' },
  queue: 'default',
  priority: 9,
  headers: { traceparent: '00-e2e-ledger-trace-e2e-span-01' },
  retryPolicy: {
    maxAttempts: 3,
    initialBackoff: '5m',
    backoffMultiplier: 2,
    maxBackoff: '10m',
  },
});

for (let attempt = 0; attempt < 5; attempt += 1) {
  const result = await server.getTaskResult(E2E_TASK_OPERATION_ID);
  if (result?.status === 'pending' && result.state === 'queued') break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}

// COR-124: a leased task on its second, heartbeating attempt, plus requested
// and acknowledged cancellations, all produced by a real worker against this
// server's real task ledger. See `ledger-evidence-seed.ts`.
const ledgerWorkers = await seedLedgerEvidence(server);

// COR-164: two real builds of one deployment, a pinned and an auto-upgrade workflow, and one
// finished run of each, plus a held run still bound to the first build. See `versioned-run-seed.ts`.
const versionedWorkers = await seedVersionedRuns(engine, host.url.origin);

// The second host, whose console runs on the Bureau's own engine (the default), so the schedules the
// Bureau holds are listed with the engine's (`28-schedule-owners.spec.ts`). It has a home of its own,
// because a home is locked by the host that holds it, and one workflow file whose trigger is a
// schedule, so the seeded agent run is not the only schedule it has.
const bureauHome = join(scratch, 'bureau-home');
const bureauWorkflowDirectory = join(bureauHome, 'workflows');
await mkdir(bureauWorkflowDirectory, { recursive: true });
await writeFile(
  join(bureauWorkflowDirectory, 'e2e-digest.json'),
  `${JSON.stringify(SEEDED_WORKFLOW_FILES['e2e-digest'], null, 2)}\n`,
);
const bureauHost = await startHost({
  environment: { INTERBOROUGH_HOME: bureauHome },
  port: E2E_BUREAU_PORT,
  buildDirectory,
});

// The third host, which only the journey opens (`90-journey.spec.ts`). Its console is the Bureau's
// own engine, because the journey follows an agent-authored workflow's schedule into the Workflows
// area, and it has a home, agents, and a barrier of its own, so nothing another specification
// leaves behind changes what the journey counts. Its provider resolver scripts the one agent the
// journey defines in the editor, and answers every other with the stub the main host uses.
const journeyHome = join(scratch, 'journey-home');
await mkdir(journeyHome, { recursive: true });
await writeProviderHome(journeyHome);
const journeyBarrier = createBarrier();
const journeyHost = await startHost({
  extraAgents: {
    agents: {
      ...createBarrierAgents(journeyBarrier),
      ...createEchoAgents(),
      ...createRecallAgents(),
    },
    published: [BARRIER_AGENT_NAME, BARRIER_SHORT_AGENT_NAME, ECHO_AGENT_NAME, RECALL_AGENT_NAME],
  },
  environment: { INTERBOROUGH_HOME: journeyHome },
  resolveProviderGenerate: createJourneyProviderResolver(
    fakeProvider('This reply comes from the end-to-end provider stub.').resolver,
  ),
  port: E2E_JOURNEY_PORT,
  buildDirectory,
});

// The barrier's control: the one route a spec uses to learn that a run is waiting and to let it
// go. It binds loopback only and exists in this process alone, never in the host. The journey's
// host holds its runs on a barrier of its own, under `/journey`.
const barrierControl = Bun.serve({
  hostname: '127.0.0.1',
  port: E2E_BARRIER_PORT,
  routes: {
    '/waiting': { GET: () => Response.json({ waiting: barrier.waiting() }) },
    '/release': {
      POST: () => {
        barrier.release();
        return Response.json({ released: true });
      },
    },
    '/journey/waiting': { GET: () => Response.json({ waiting: journeyBarrier.waiting() }) },
    '/journey/release': {
      POST: () => {
        journeyBarrier.release();
        return Response.json({ released: true });
      },
    },
  },
});

process.stdout.write(
  [
    `Interborough E2E host listening on ${host.url}`,
    `Interborough E2E Bureau host listening on ${bureauHost.url}`,
    `Interborough E2E journey host listening on ${journeyHost.url}`,
    `Registered E2E fleet worker under deployment "${E2E_DEPLOYMENT_NAME}"`,
    'Seeded COR-124 attempt, lease, and cancellation evidence',
    'Seeded COR-281 cross-build retry storm',
    'Seeded COR-164 pinned and auto-upgrade runs',
    'Registered dynamic workflow sources for invoice-reconciliation',
    'Registered conditional-refresh sources',
  ].join('\n') + '\n',
);

async function shutDown(): Promise<void> {
  await barrierControl.stop(true);
  for (const ledgerWorker of ledgerWorkers) ledgerWorker[Symbol.dispose]();
  for (const versionedWorker of versionedWorkers) await versionedWorker.disconnect();
  await longPollWorker.stop();
  await fleetWorker.disconnect();
  await journeyHost.close();
  await bureauHost.close();
  await host.close();
  await rm(scratch, { recursive: true, force: true });
  process.exit(0);
}

process.on('SIGINT', () => void shutDown());
process.on('SIGTERM', () => void shutDown());
