/**
 * COR-2097 (review round 2, revision 2026-11-16): every steering command that publishes
 * `steering.accepted` is covered by exactly one terminal event (`steering.applied`,
 * `steering.failed` with its reason, or `steering.superseded`), from exactly one process, after the
 * durable write that decides it. Two Bureau processes, A and B, share one SQLite file.
 *
 * The table is crossed from four axes, and every reachable combination is a row:
 *
 * - kind: every target admission accepts, bound to `SteeringRequestedValue['target']` by
 *   `REQUESTED_VALUES` below, so a new target is a compile error here;
 * - binding: bound to a live run, or accepted on an idle durable context with no run (only `model`,
 *   `effort` and `permission-mode` are, `steersIdleSession`; the rest answer `session-terminal`
 *   there and accept nothing, which the last test checks);
 * - ending: `ENDINGS`;
 * - where: admitted in A and the run hosted in A, or admitted in A and hosted in B.
 *
 * Unreachable rows, and why:
 *
 * - idle × `run-end`, idle × the two race endings: an idle context has no run to end, and the
 *   boundary of its next run is that run's step 0, which no tool can hold back;
 * - idle × every ending but `boundary` in A/B: an idle command has no host, so A/B differs from A/A
 *   only in where the next run that applies it is hosted, which only `boundary` reaches;
 * - `agent-identity` × the two race endings: its boundary is step 0 of a later run, likewise.
 *
 * `steering.applied` names only the session (ruling of 2026-11-16: one boundary applying two
 * configuration commands publishes one `steering.applied` covering both), so each row's session
 * holds one command a boundary can apply, and a row whose command is applied is covered by exactly
 * one `steering.applied` of its session. `steering.failed` and `steering.superseded` name the
 * command. A resume row pauses the run first (`p0`), because a resume of an unpaused run is
 * recorded applied at admission (its own rows are below); `p0` must be covered by exactly one
 * `steering.superseded`.
 *
 * `AT_HEAD` is what the probe run recorded at 269c9e381 merged with origin/main (9c99b29ad), before
 * any product change: the `ROWS` line each test logs. A row is open where it differs from the
 * required outcome.
 *
 * Who announces, after the change (the rule the rows hold the code to): a boundary, a deadline, an
 * end of a run and a later command are announced by the process whose log append committed them; a
 * session's deletion or expiry is announced by the process that drains the session's
 * `session.deleted` outbox entry and wins the conditional write that seals the log (a drainer that
 * finds the log sealed stays silent), from a fold of that log, so neither the deleter nor the
 * expirer, nor any process's memory, decides it. The log is removed only once the entry is
 * acknowledged. A process that has seen the session gone writes nothing more to the log.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { type SteeringRequestedValue, createAgent, stopWhen } from '@lostgradient/operative';
import type { Storage } from '@lostgradient/storage';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import { readSteeringLogEntries, readSteeringLogHead, sealSteeringLog } from './steering-log';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { STEERABLE_MODELS } from './testing/default-agent.test-support';
import { createVendorCatalog } from './testing/vendor-catalog.test-support';

type Kind = SteeringRequestedValue['target'];

const firstModel = STEERABLE_MODELS[1]!;
const secondModel = STEERABLE_MODELS[2]!;

/** The value each kind is steered to, and the one a later command replaces it with. */
const REQUESTED_VALUES = {
  pause: [{ target: 'pause' }, { target: 'resume' }],
  resume: [{ target: 'resume' }, { target: 'pause' }],
  'agent-identity': [
    { target: 'agent-identity', override: 'quick' },
    { target: 'agent-identity', override: 'parked' },
  ],
  route: [
    { target: 'route', override: 'primary' },
    { target: 'route', override: 'secondary' },
  ],
  model: [
    { target: 'model', override: firstModel.model, provider: firstModel.provider },
    { target: 'model', override: secondModel.model, provider: secondModel.provider },
  ],
  provider: [
    { target: 'provider', override: 'anthropic' },
    { target: 'provider', override: 'openai' },
  ],
  effort: [
    { target: 'effort', override: 'high' },
    { target: 'effort', override: 'low' },
  ],
  'permission-mode': [
    { target: 'permission-mode', override: 'read-only' },
    { target: 'permission-mode', override: 'allow-all' },
  ],
} satisfies {
  [Target in Kind]: readonly [
    Extract<SteeringRequestedValue, { target: Target }>,
    SteeringRequestedValue,
  ];
};

const KINDS = Object.keys(REQUESTED_VALUES) as Kind[];
const IDLE_KINDS: readonly Kind[] = ['model', 'effort', 'permission-mode'];
const isRunScoped = (kind: Kind) => kind === 'pause' || kind === 'resume';

const ENDINGS = {
  boundary: 'a boundary applies it',
  deadline: 'its deadline passes before the boundary',
  'run-end': 'its run ends, then A deletes the session',
  'deleted-by-admitter': 'A, which admitted it, deletes the session',
  'deleted-by-other': 'B deletes the session',
  'expired-drained-by-expirer': 'A expires the session and drains its `session.deleted` entry',
  'expired-drained-by-other': 'A expires the session, and B drains its `session.deleted` entry',
  'expired-restart-before-drain': 'A expires the session and restarts before any drain',
  'deletion-before-boundary':
    'the process not hosting the run deletes the session, and the boundary comes after the log is sealed and before it is removed',
  'boundary-before-deletion':
    'the boundary applies it, then the process not hosting the run deletes the session',
  superseded: 'a later command for the same target replaces it, admitted where the run is hosted',
} as const;
type Ending = keyof typeof ENDINGS;
type Where = 'A/A' | 'A/B';
type Binding = 'run' | 'idle';
/** `applied`, `superseded`, or `failed:<reason>`: the one terminal event that covers the command. */
type Outcome = string;

interface Row {
  readonly kind: Kind;
  readonly binding: Binding;
  readonly ending: Ending;
  readonly where: Where;
}

const SESSION_ENDINGS: ReadonlySet<Ending> = new Set([
  'deleted-by-admitter',
  'deleted-by-other',
  'expired-drained-by-expirer',
  'expired-drained-by-other',
  'expired-restart-before-drain',
  'deletion-before-boundary',
]);

/** The one terminal event the revision of 2026-11-16 requires for the row's command. */
function requiredOutcome({ kind, binding, ending }: Row): Outcome {
  if (ending === 'boundary' || ending === 'boundary-before-deletion') return 'applied';
  if (ending === 'superseded') return 'superseded';
  // Only a pause and an agent identity are held to their deadline when they apply.
  if (ending === 'deadline') {
    return kind === 'pause' || kind === 'agent-identity' ? 'failed:deadline-passed' : 'applied';
  }
  // A run's end fails what was bound to it; a session-scoped command waits for the next run, and
  // the session's deletion after it ends that.
  if (ending === 'run-end')
    return isRunScoped(kind) ? 'failed:run-terminal' : 'failed:session-terminal';
  if (SESSION_ENDINGS.has(ending)) {
    return binding === 'run' && isRunScoped(kind)
      ? 'failed:run-terminal'
      : 'failed:session-terminal';
  }
  throw new Error(`no required outcome for ${ending}`);
}

function rowKey(row: Row): string {
  return `${row.ending} ${row.where} ${row.binding} ${row.kind}`;
}

const RACES: ReadonlySet<Ending> = new Set([
  'deletion-before-boundary',
  'boundary-before-deletion',
]);

function rowsFor(ending: Ending, where: Where): Row[] {
  const rows: Row[] = [];
  for (const kind of KINDS) {
    if (kind === 'agent-identity' && RACES.has(ending)) continue;
    rows.push({ kind, binding: 'run', ending, where });
  }
  const idle =
    ending === 'boundary' || (where === 'A/A' && ending !== 'run-end' && !RACES.has(ending));
  if (idle) for (const kind of IDLE_KINDS) rows.push({ kind, binding: 'idle', ending, where });
  return rows;
}

/**
 * What each row did at 9c99b29ad (269c9e381 merged with origin/main), from the probe run's `ROWS`
 * lines: the terminal events that covered the row's command. Filled from the run, never by hand.
 */
const AT_HEAD: Readonly<Record<string, readonly Outcome[]>> = {
  'boundary A/A run pause': ['applied'],
  'boundary A/A run resume': ['applied'],
  'boundary A/A run resume setup p0': ['superseded'],
  'boundary A/A run agent-identity': ['applied'],
  'boundary A/A run route': ['applied'],
  'boundary A/A run model': ['applied'],
  'boundary A/A run provider': ['applied'],
  'boundary A/A run effort': ['applied'],
  'boundary A/A run permission-mode': ['applied'],
  'boundary A/A idle model': ['applied'],
  'boundary A/A idle effort': ['applied'],
  'boundary A/A idle permission-mode': ['applied'],
  'boundary A/B run pause': ['applied'],
  'boundary A/B run resume': ['applied'],
  'boundary A/B run resume setup p0': ['superseded'],
  'boundary A/B run agent-identity': ['applied'],
  'boundary A/B run route': ['applied'],
  'boundary A/B run model': ['applied'],
  'boundary A/B run provider': ['applied'],
  'boundary A/B run effort': ['applied'],
  'boundary A/B run permission-mode': ['applied'],
  'boundary A/B idle model': ['applied'],
  'boundary A/B idle effort': ['applied'],
  'boundary A/B idle permission-mode': ['applied'],
  'deadline A/A run pause': ['failed:deadline-passed', 'applied'],
  'deadline A/A run resume': ['applied'],
  'deadline A/A run resume setup p0': ['superseded'],
  'deadline A/A run agent-identity': ['failed:deadline-passed', 'applied'],
  'deadline A/A run route': ['applied'],
  'deadline A/A run model': ['applied'],
  'deadline A/A run provider': ['applied'],
  'deadline A/A run effort': ['applied'],
  'deadline A/A run permission-mode': ['applied'],
  'deadline A/A idle model': ['applied'],
  'deadline A/A idle effort': ['applied'],
  'deadline A/A idle permission-mode': ['applied'],
  'deadline A/B run pause': ['failed:deadline-passed', 'applied'],
  'deadline A/B run resume': ['applied'],
  'deadline A/B run resume setup p0': ['superseded'],
  'deadline A/B run agent-identity': ['failed:deadline-passed', 'applied'],
  'deadline A/B run route': ['applied'],
  'deadline A/B run model': ['applied'],
  'deadline A/B run provider': ['applied'],
  'deadline A/B run effort': ['applied'],
  'deadline A/B run permission-mode': ['applied'],
  'run-end A/A run pause': ['failed:run-terminal'],
  'run-end A/A run resume': ['failed:run-terminal'],
  'run-end A/A run resume setup p0': ['superseded'],
  'run-end A/A run agent-identity': [],
  'run-end A/A run route': [],
  'run-end A/A run model': [],
  'run-end A/A run provider': [],
  'run-end A/A run effort': [],
  'run-end A/A run permission-mode': [],
  'run-end A/B run pause': ['failed:run-terminal'],
  'run-end A/B run resume': ['failed:run-terminal'],
  'run-end A/B run resume setup p0': ['superseded'],
  'run-end A/B run agent-identity': [],
  'run-end A/B run route': [],
  'run-end A/B run model': [],
  'run-end A/B run provider': [],
  'run-end A/B run effort': [],
  'run-end A/B run permission-mode': [],
  'deleted-by-admitter A/A run pause': ['failed:run-terminal'],
  'deleted-by-admitter A/A run resume': ['failed:run-terminal'],
  'deleted-by-admitter A/A run resume setup p0': ['superseded'],
  'deleted-by-admitter A/A run agent-identity': [],
  'deleted-by-admitter A/A run route': [],
  'deleted-by-admitter A/A run model': [],
  'deleted-by-admitter A/A run provider': [],
  'deleted-by-admitter A/A run effort': [],
  'deleted-by-admitter A/A run permission-mode': [],
  'deleted-by-admitter A/A idle model': [],
  'deleted-by-admitter A/A idle effort': [],
  'deleted-by-admitter A/A idle permission-mode': [],
  'deleted-by-admitter A/B run pause': ['failed:run-terminal'],
  'deleted-by-admitter A/B run resume': ['failed:run-terminal'],
  'deleted-by-admitter A/B run resume setup p0': ['superseded'],
  'deleted-by-admitter A/B run agent-identity': [],
  'deleted-by-admitter A/B run route': [],
  'deleted-by-admitter A/B run model': [],
  'deleted-by-admitter A/B run provider': [],
  'deleted-by-admitter A/B run effort': [],
  'deleted-by-admitter A/B run permission-mode': [],
  'deleted-by-other A/A run pause': ['failed:run-terminal'],
  'deleted-by-other A/A run resume': ['failed:run-terminal'],
  'deleted-by-other A/A run resume setup p0': ['superseded'],
  'deleted-by-other A/A run agent-identity': [],
  'deleted-by-other A/A run route': [],
  'deleted-by-other A/A run model': [],
  'deleted-by-other A/A run provider': [],
  'deleted-by-other A/A run effort': [],
  'deleted-by-other A/A run permission-mode': [],
  'deleted-by-other A/A idle model': [],
  'deleted-by-other A/A idle effort': [],
  'deleted-by-other A/A idle permission-mode': [],
  'deleted-by-other A/B run pause': ['failed:run-terminal'],
  'deleted-by-other A/B run resume': ['failed:run-terminal'],
  'deleted-by-other A/B run resume setup p0': ['superseded'],
  'deleted-by-other A/B run agent-identity': [],
  'deleted-by-other A/B run route': [],
  'deleted-by-other A/B run model': [],
  'deleted-by-other A/B run provider': [],
  'deleted-by-other A/B run effort': [],
  'deleted-by-other A/B run permission-mode': [],
  'expired-drained-by-expirer A/A run pause': ['failed:run-terminal'],
  'expired-drained-by-expirer A/A run resume': ['failed:run-terminal'],
  'expired-drained-by-expirer A/A run resume setup p0': ['superseded'],
  'expired-drained-by-expirer A/A run agent-identity': [],
  'expired-drained-by-expirer A/A run route': [],
  'expired-drained-by-expirer A/A run model': [],
  'expired-drained-by-expirer A/A run provider': [],
  'expired-drained-by-expirer A/A run effort': [],
  'expired-drained-by-expirer A/A run permission-mode': [],
  'expired-drained-by-expirer A/A idle model': [],
  'expired-drained-by-expirer A/A idle effort': [],
  'expired-drained-by-expirer A/A idle permission-mode': [],
  'expired-drained-by-expirer A/B run pause': ['failed:run-terminal'],
  'expired-drained-by-expirer A/B run resume': ['failed:run-terminal'],
  'expired-drained-by-expirer A/B run resume setup p0': ['superseded'],
  'expired-drained-by-expirer A/B run agent-identity': [],
  'expired-drained-by-expirer A/B run route': [],
  'expired-drained-by-expirer A/B run model': [],
  'expired-drained-by-expirer A/B run provider': [],
  'expired-drained-by-expirer A/B run effort': [],
  'expired-drained-by-expirer A/B run permission-mode': [],
  'expired-drained-by-other A/A run pause': [],
  'expired-drained-by-other A/A run resume': [],
  'expired-drained-by-other A/A run resume setup p0': ['superseded'],
  'expired-drained-by-other A/A run agent-identity': [],
  'expired-drained-by-other A/A run route': [],
  'expired-drained-by-other A/A run model': [],
  'expired-drained-by-other A/A run provider': [],
  'expired-drained-by-other A/A run effort': [],
  'expired-drained-by-other A/A run permission-mode': [],
  'expired-drained-by-other A/A idle model': [],
  'expired-drained-by-other A/A idle effort': [],
  'expired-drained-by-other A/A idle permission-mode': [],
  'expired-drained-by-other A/B run pause': [],
  'expired-drained-by-other A/B run resume': [],
  'expired-drained-by-other A/B run resume setup p0': ['superseded'],
  'expired-drained-by-other A/B run agent-identity': [],
  'expired-drained-by-other A/B run route': [],
  'expired-drained-by-other A/B run model': [],
  'expired-drained-by-other A/B run provider': [],
  'expired-drained-by-other A/B run effort': [],
  'expired-drained-by-other A/B run permission-mode': [],
  'expired-restart-before-drain A/A run pause': [],
  'expired-restart-before-drain A/A run resume': [],
  'expired-restart-before-drain A/A run resume setup p0': ['superseded'],
  'expired-restart-before-drain A/A run agent-identity': [],
  'expired-restart-before-drain A/A run route': [],
  'expired-restart-before-drain A/A run model': [],
  'expired-restart-before-drain A/A run provider': [],
  'expired-restart-before-drain A/A run effort': [],
  'expired-restart-before-drain A/A run permission-mode': [],
  'expired-restart-before-drain A/A idle model': [],
  'expired-restart-before-drain A/A idle effort': [],
  'expired-restart-before-drain A/A idle permission-mode': [],
  'expired-restart-before-drain A/B run pause': [],
  'expired-restart-before-drain A/B run resume': [],
  'expired-restart-before-drain A/B run resume setup p0': ['superseded'],
  'expired-restart-before-drain A/B run agent-identity': [],
  'expired-restart-before-drain A/B run route': [],
  'expired-restart-before-drain A/B run model': [],
  'expired-restart-before-drain A/B run provider': [],
  'expired-restart-before-drain A/B run effort': [],
  'expired-restart-before-drain A/B run permission-mode': [],
  'deletion-before-boundary A/A run pause': ['failed:run-terminal'],
  'deletion-before-boundary A/A run resume': ['failed:run-terminal'],
  'deletion-before-boundary A/A run resume setup p0': ['superseded'],
  'deletion-before-boundary A/A run route': [],
  'deletion-before-boundary A/A run model': [],
  'deletion-before-boundary A/A run provider': [],
  'deletion-before-boundary A/A run effort': [],
  'deletion-before-boundary A/A run permission-mode': [],
  'deletion-before-boundary A/B run pause': ['failed:run-terminal'],
  'deletion-before-boundary A/B run resume': ['failed:run-terminal'],
  'deletion-before-boundary A/B run resume setup p0': ['superseded'],
  'deletion-before-boundary A/B run route': [],
  'deletion-before-boundary A/B run model': [],
  'deletion-before-boundary A/B run provider': [],
  'deletion-before-boundary A/B run effort': [],
  'deletion-before-boundary A/B run permission-mode': [],
  'boundary-before-deletion A/A run pause': ['applied'],
  'boundary-before-deletion A/A run resume': ['applied'],
  'boundary-before-deletion A/A run resume setup p0': ['superseded'],
  'boundary-before-deletion A/A run route': ['applied'],
  'boundary-before-deletion A/A run model': ['applied'],
  'boundary-before-deletion A/A run provider': ['applied'],
  'boundary-before-deletion A/A run effort': ['applied'],
  'boundary-before-deletion A/A run permission-mode': ['applied'],
  'boundary-before-deletion A/B run pause': ['applied'],
  'boundary-before-deletion A/B run resume': ['applied'],
  'boundary-before-deletion A/B run resume setup p0': ['superseded'],
  'boundary-before-deletion A/B run route': ['applied'],
  'boundary-before-deletion A/B run model': ['applied'],
  'boundary-before-deletion A/B run provider': ['applied'],
  'boundary-before-deletion A/B run effort': ['applied'],
  'boundary-before-deletion A/B run permission-mode': ['applied'],
  'superseded A/A run pause': ['superseded'],
  'superseded A/A run resume': [],
  'superseded A/A run resume setup p0': ['superseded'],
  'superseded A/A run agent-identity': ['superseded'],
  'superseded A/A run route': ['superseded'],
  'superseded A/A run model': ['superseded'],
  'superseded A/A run provider': ['superseded'],
  'superseded A/A run effort': ['superseded'],
  'superseded A/A run permission-mode': ['superseded'],
  'superseded A/A idle model': ['superseded'],
  'superseded A/A idle effort': ['superseded'],
  'superseded A/A idle permission-mode': ['superseded'],
  'superseded A/B run pause': ['superseded'],
  'superseded A/B run resume': [],
  'superseded A/B run resume setup p0': ['superseded'],
  'superseded A/B run agent-identity': ['superseded'],
  'superseded A/B run route': ['superseded'],
  'superseded A/B run model': ['superseded'],
  'superseded A/B run provider': ['superseded'],
  'superseded A/B run effort': ['superseded'],
  'superseded A/B run permission-mode': ['superseded'],
};

interface Envelope {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

const STEERING_KINDS = new Set([
  'steering.accepted',
  'steering.applied',
  'steering.rejected',
  'steering.superseded',
  'steering.failed',
]);

async function steeringEvents(bureau: Bureau): Promise<Envelope[]> {
  await bureau.internals.taskRegistry.flush();
  const found: Envelope[] = [];
  for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
    const { kind, payload } = envelope as unknown as Envelope;
    if (STEERING_KINDS.has(kind)) found.push({ kind, payload });
  }
  return found;
}

const TERMINAL = new Set(['completed', 'failed', 'canceled']);
const models = createVendorCatalog().descriptors;
type SteerRequest = Parameters<Bureau['contexts']['steer']>[1];

interface Gate {
  readonly agent: string;
  readonly entered: () => boolean;
  readonly release: () => void;
}

interface Rig {
  a: Bureau;
  b: Bureau;
  readonly gate: () => Gate;
  readonly advanceClock: (bureau: Bureau, milliseconds: number) => void;
  readonly now: (bureau: Bureau) => number;
  readonly parkLogRemoval: () => void;
  readonly unparkLogRemoval: () => void;
  readonly refuseClaims: (bureau: Bureau) => void;
  readonly restartA: () => Promise<void>;
  /** Opens one more process, its clock `offsetMilliseconds` ahead, and boots it (which drains). */
  readonly open: (offsetMilliseconds?: number) => Promise<Bureau>;
  /** Disposes a process opened with `open`, keeping what it published. */
  readonly retire: (bureau: Bureau) => Promise<void>;
  readonly events: () => Promise<Envelope[]>;
}

const GATES_PER_RIG = 16;

type Outbox = NonNullable<Bureau['internals']['sessionStore']>['outbox'];
type Claim = Outbox['claim'];
const originalClaims = new WeakMap<Bureau, Claim>();

/**
 * Replaces a process's outbox claim with `wrap(original)`. Precedent:
 * owner-of-record-session-history.test.ts patches `outbox.claim` the same way.
 */
function patchClaims(bureau: Bureau, wrap: (original: Claim) => Claim): void {
  const outbox = bureau.internals.sessionStore!.outbox;
  const original = originalClaims.get(bureau) ?? outbox.claim.bind(outbox);
  originalClaims.set(bureau, original);
  (outbox as { claim: Claim }).claim = wrap(original);
}

async function withRig(body: (rig: Rig) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-table-'));
  const database = createSqliteStorageFixture({ path: join(directory, 'bureau.sqlite') });
  const opened: Bureau[] = [];
  const disposed = new Set<Bureau>();
  const offsets = new Map<Bureau, { value: number }>();
  const retired: Envelope[] = [];
  const gates = Array.from({ length: GATES_PER_RIG }, () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    return { promise, release: resolve, entered: false };
  });
  let nextGate = 0;
  let parked: PromiseWithResolvers<void> | undefined;
  // Holds a steering log's removal while parked, so a late append meets a sealed, still-present log.
  const parking = (storage: Storage): Storage =>
    new Proxy(storage, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        if (property !== 'deletePrefix') return value.bind(target);
        return async (prefix: string, ...rest: unknown[]) => {
          if (prefix.includes('steering-log:') && parked !== undefined) await parked.promise;
          return Reflect.apply(value, target, [prefix, ...rest]) as unknown;
        };
      },
    });
  const open = async (offsetMilliseconds = 0) => {
    const offset = { value: offsetMilliseconds };
    const real = createDefaultRuntimeServices();
    const runtime = {
      ...real,
      clock: {
        now: () => Date.now() + offset.value,
        nowISO: () => new Date(Date.now() + offset.value).toISOString(),
      },
    };
    const gated = Object.fromEntries(
      gates.map((gate, index) => [
        `gated-${String(index)}`,
        createAgent({
          allowedCandidates: STEERABLE_MODELS,
          generate: async ({ step }) =>
            step === 0
              ? { content: '', toolCalls: [{ name: 'next', arguments: {} }] }
              : { content: 'done', toolCalls: [] },
          toolbox: createToolbox([
            createTool({
              name: 'next',
              description: 'continue',
              input: z.object({}),
              execute: async () => {
                gate.entered = true;
                await gate.promise;
                return 'ok';
              },
            }),
          ]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      ]),
    );
    const bureau = await createBureau<AgentDefinitions>({
      models: { catalog: models },
      agents: {
        ...gated,
        quick: createAgent({
          allowedCandidates: STEERABLE_MODELS,
          generate: async () => ({ content: 'done', toolCalls: [] }),
          toolbox: createToolbox([]),
        }),
        parked: createAgent({
          allowedCandidates: STEERABLE_MODELS,
          generate: ({ signal }) =>
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              });
            }),
          toolbox: createToolbox([]),
        }),
      },
      storage: parking(database.open()),
      runtime,
      durable: true,
      onDiagnostic: () => undefined,
    });
    opened.push(bureau);
    offsets.set(bureau, offset);
    return bureau;
  };
  try {
    const rig: Rig = {
      a: await open(),
      b: await open(),
      gate: () => {
        const index = nextGate;
        nextGate += 1;
        const gate = gates[index];
        if (gate === undefined) throw new Error('out of gates');
        return {
          agent: `gated-${String(index)}`,
          entered: () => gate.entered,
          release: () => gate.release(),
        };
      },
      advanceClock: (bureau, milliseconds) => {
        offsets.get(bureau)!.value += milliseconds;
      },
      now: (bureau) => Date.now() + offsets.get(bureau)!.value,
      parkLogRemoval: () => {
        parked = Promise.withResolvers<void>();
      },
      unparkLogRemoval: () => {
        parked?.resolve();
        parked = undefined;
      },
      refuseClaims: (bureau) => {
        patchClaims(bureau, () => async () => ({ claimed: false }));
      },
      restartA: async () => {
        await rig.retire(rig.a);
        rig.a = await open();
      },
      open,
      retire: async (bureau) => {
        // Read before and after: a disposed feed may replay nothing, and the longer read holds
        // what the process published while it went down as well.
        const before = await steeringEvents(bureau);
        disposed.add(bureau);
        await bureau.dispose();
        const after = await steeringEvents(bureau).catch(() => []);
        retired.push(...(after.length >= before.length ? after : before));
      },
      events: async () => {
        const live: Envelope[] = [];
        for (const bureau of opened) {
          if (!disposed.has(bureau)) live.push(...(await steeringEvents(bureau)));
        }
        return [...retired, ...live];
      },
    };
    await body(rig);
  } finally {
    parked?.resolve();
    for (const gate of gates) gate.release();
    for (const bureau of opened) if (!disposed.has(bureau)) await bureau.dispose();
    await database[Symbol.asyncDispose]();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function isTerminal(bureau: Bureau, runId: string): Promise<boolean> {
  const task = await bureau.tasks.get(runId);
  return TERMINAL.has(task?.status ?? '');
}

type Kv = NonNullable<Bureau['internals']['kv']>;

/** Whether the log of a session incarnation is gone: its head key no longer exists. */
async function logRemoved(kv: Kv, sessionId: string, incarnation: string): Promise<boolean> {
  const head = await readSteeringLogHead(kv, sessionId, incarnation);
  return head.raw === null;
}

/** Whether the log of a session incarnation is sealed. */
async function logSealed(kv: Kv, sessionId: string, incarnation: string): Promise<boolean> {
  const head = await readSteeringLogHead(kv, sessionId, incarnation);
  return head.sealed === true;
}

async function waitForTerminal(bureau: Bureau, runId: string, what: string): Promise<void> {
  await waitUntil(() => isTerminal(bureau, runId), { message: what });
}

interface Subject {
  readonly row: Row;
  readonly sessionId: string;
  readonly incarnation: string;
  readonly commandId: string;
  /** Commands the setup admitted besides the row's, with the outcome each must have. */
  readonly setup: ReadonlyMap<string, Outcome>;
  readonly host: Bureau;
  readonly run?: { readonly runId: string; readonly gate: Gate };
}

async function accept(admitter: Bureau, sessionId: string, request: SteerRequest): Promise<void> {
  const answer = await admitter.contexts.steer(sessionId, request);
  expect({ id: request.id, outcome: answer.outcome }).toEqual({
    id: request.id,
    outcome: 'accepted',
  });
}

/** Makes `host` fold the log now: a stale-revision request of its own is refused after a catch-up. */
async function foldOn(host: Bureau, sessionId: string, id: string): Promise<void> {
  const folded = await host.contexts.steer(sessionId, {
    id,
    principal: 'alice',
    expectedRevision: 0,
    requestedValue: { target: 'effort', override: 'medium' },
  });
  expect(folded.outcome).toBe('rejected');
}

async function setUp(rig: Rig, row: Row, index: number): Promise<Subject> {
  const host = row.where === 'A/A' ? rig.a : rig.b;
  const commandId = `c${String(index)}-${row.kind}`;
  const deadline =
    row.ending === 'deadline' ? new Date(rig.now(rig.a) + 5 * 60_000).toISOString() : undefined;
  const request: SteerRequest = {
    id: commandId,
    principal: 'alice',
    requestedValue: REQUESTED_VALUES[row.kind][0],
    ...(deadline === undefined ? {} : { deadline }),
  };
  const setup = new Map<string, Outcome>();
  if (row.binding === 'idle') {
    const first = await rig.a.tasks.start('quick', 'go', { principal: 'alice' });
    await waitForTerminal(rig.a, first.id, `${rowKey(row)}: the first run ended`);
    await accept(rig.a, first.contextId, request);
    const incarnation = (await rig.a.contexts.get(first.contextId))!.incarnation;
    return { row, sessionId: first.contextId, incarnation, commandId, setup, host };
  }
  const gate = rig.gate();
  const run = await host.tasks.start(gate.agent, 'go', { principal: 'alice' });
  await waitUntil(gate.entered, { message: `${rowKey(row)}: the run is in its tool` });
  if (row.kind === 'resume') {
    setup.set(`${commandId}-p0`, 'superseded');
    await accept(rig.a, run.contextId, {
      id: `${commandId}-p0`,
      principal: 'alice',
      requestedValue: { target: 'pause' },
    });
  }
  await accept(rig.a, run.contextId, request);
  if (host !== rig.a) await foldOn(host, run.contextId, `${commandId}-fold`);
  const incarnation = (await rig.a.contexts.get(run.contextId))!.incarnation;
  return {
    row,
    sessionId: run.contextId,
    incarnation,
    commandId,
    setup,
    host,
    run: { runId: run.id, gate },
  };
}

type LogOf = Pick<Subject, 'sessionId' | 'incarnation'>;

async function logHas(
  rig: Rig,
  subject: LogOf,
  predicate: (entry: { type: string; runId?: string }) => boolean,
): Promise<boolean> {
  const kv = rig.b.internals.kv!;
  const head = await readSteeringLogHead(kv, subject.sessionId, subject.incarnation);
  if (head.raw === null) return false;
  const entries = await readSteeringLogEntries(
    kv,
    subject.sessionId,
    subject.incarnation,
    0,
    head.sequence,
  );
  return entries.some((entry) => predicate(entry));
}

async function sealedOrGone(rig: Rig, subject: LogOf): Promise<boolean> {
  const head = await readSteeringLogHead(
    rig.b.internals.kv!,
    subject.sessionId,
    subject.incarnation,
  );
  return head.raw === null || head.sealed === true;
}

/** Starts the session's next run on its host and waits for it to end. */
async function nextRun(subject: Subject): Promise<void> {
  // A run on an existing context names the agent the context belongs to.
  const next = await subject.host.tasks.start(subject.run?.gate.agent ?? 'quick', 'again', {
    principal: 'alice',
    contextId: subject.sessionId,
  });
  await waitForTerminal(subject.host, next.id, `${rowKey(subject.row)}: the next run ended`);
}

/** Lets the row's run return from its tool, and waits for it to end, or to park at a pause it applied. */
async function releaseAndSettle(rig: Rig, subject: Subject): Promise<void> {
  if (subject.run === undefined) return;
  const { runId, gate } = subject.run;
  gate.release();
  await waitUntil(
    async () =>
      (await isTerminal(subject.host, runId)) ||
      (await logHas(rig, subject, (entry) => entry.type === 'applied' && entry.runId === runId)),
    { message: `${rowKey(subject.row)}: the run reached its boundary` },
  );
}

async function releaseAndEnd(subject: Subject): Promise<void> {
  if (subject.run === undefined) return;
  subject.run.gate.release();
  await waitForTerminal(subject.host, subject.run.runId, `${rowKey(subject.row)}: the run ended`);
}

async function applyAtBoundary(rig: Rig, subject: Subject): Promise<void> {
  if (subject.row.binding === 'idle' || subject.row.kind === 'agent-identity') {
    await releaseAndEnd(subject);
    await nextRun(subject);
    return;
  }
  await releaseAndSettle(rig, subject);
}

function otherThan(rig: Rig, bureau: Bureau): Bureau {
  return bureau === rig.a ? rig.b : rig.a;
}

async function outboxDrained(bureau: Bureau): Promise<boolean> {
  const pending = await bureau.internals.sessionStore!.outbox.pending();
  return pending.length === 0;
}

async function deleteThenRelease(rig: Rig, subject: Subject, deleter: Bureau): Promise<void> {
  const deleting = deleter.contexts.delete(subject.sessionId);
  await waitUntil(
    async () =>
      (await rig.b.internals.sessionStore!.load(subject.sessionId)) === undefined &&
      (await sealedOrGone(rig, subject)),
    { message: `${rowKey(subject.row)}: the deletion committed and the log was settled` },
  );
  await releaseAndEnd(subject);
  await deleting;
}

async function runEnding(rig: Rig, ending: Ending, subjects: readonly Subject[]): Promise<void> {
  switch (ending) {
    case 'boundary':
      await Promise.all(subjects.map((subject) => applyAtBoundary(rig, subject)));
      return;
    case 'deadline':
      for (const host of new Set(subjects.map((subject) => subject.host))) {
        rig.advanceClock(host, 10 * 60_000);
      }
      await Promise.all(subjects.map((subject) => applyAtBoundary(rig, subject)));
      return;
    case 'run-end':
      await Promise.all(
        subjects.map(async (subject) => {
          if (subject.run === undefined) return;
          await subject.host.tasks.cancel(subject.run.runId);
          await releaseAndEnd(subject);
          await rig.a.contexts.delete(subject.sessionId);
        }),
      );
      return;
    case 'deleted-by-admitter':
    case 'deleted-by-other':
      await Promise.all(
        subjects.map((subject) =>
          deleteThenRelease(rig, subject, ending === 'deleted-by-admitter' ? rig.a : rig.b),
        ),
      );
      return;
    case 'expired-drained-by-expirer':
    case 'expired-drained-by-other':
    case 'expired-restart-before-drain': {
      // The runs reach their boundaries only once the entries drained, so a boundary never
      // applies a command before the drain decides it, and each row has one required outcome.
      if (ending !== 'expired-drained-by-expirer') rig.refuseClaims(rig.a);
      if (ending === 'expired-drained-by-other') rig.refuseClaims(rig.b);
      const expired = await rig.a.internals.sessionStore!.cleanup({ olderThan: -60_000 });
      expect(expired).toBeGreaterThanOrEqual(subjects.length);
      let live = subjects;
      if (ending === 'expired-restart-before-drain') {
        // A's own runs go down with it.
        for (const subject of subjects) if (subject.host === rig.a) subject.run?.gate.release();
        live = subjects.filter((subject) => subject.host !== rig.a);
        await rig.restartA();
      }
      // A process that never served the sessions boots, which drains every pending entry.
      if (ending === 'expired-drained-by-other') await rig.open();
      // The expirer drains on its own: its commit triggers the drain.
      await waitUntil(() => outboxDrained(rig.b), { message: 'every expiry drained' });
      await Promise.all(live.map((subject) => releaseAndEnd(subject)));
      return;
    }
    case 'deletion-before-boundary':
      // Seal-dependent: the log still exists when the late boundary appends, so only the seal
      // refuses it. The deleter is not the host, so its parked removal holds no run of its own.
      rig.parkLogRemoval();
      {
        const deletions: Promise<unknown>[] = [];
        try {
          await Promise.all(
            subjects.map(async (subject) => {
              deletions.push(otherThan(rig, subject.host).contexts.delete(subject.sessionId));
              await waitUntil(
                () => logSealed(rig.b.internals.kv!, subject.sessionId, subject.incarnation),
                { message: `${rowKey(subject.row)}: the log was sealed` },
              );
              await releaseAndEnd(subject);
            }),
          );
        } finally {
          // The deletions finish once the log they hold back is removed.
          rig.unparkLogRemoval();
        }
        await Promise.all(deletions);
      }
      return;
    case 'boundary-before-deletion':
      await Promise.all(
        subjects.map(async (subject) => {
          if (subject.run === undefined) return;
          await releaseAndSettle(rig, subject);
          await otherThan(rig, subject.host).contexts.delete(subject.sessionId);
          await waitForTerminal(
            subject.host,
            subject.run.runId,
            `${rowKey(subject.row)}: the run ended`,
          );
        }),
      );
      return;
    case 'superseded':
      await Promise.all(
        subjects.map((subject) =>
          accept(subject.row.binding === 'idle' ? rig.b : subject.host, subject.sessionId, {
            id: `${subject.commandId}-next`,
            principal: 'alice',
            requestedValue: REQUESTED_VALUES[subject.row.kind][1],
          }),
        ),
      );
      return;
  }
}

interface Coverage {
  /** How many `steering.accepted` events name the command, across every process. */
  readonly accepted: number;
  /** The terminal events that cover it. */
  readonly terminal: Outcome[];
}

/** The terminal events each command of `subject`'s session has, its own and the setup's. */
function coverageOf(subject: Subject, events: readonly Envelope[]): Map<string, Coverage> {
  const ids = [subject.commandId, ...subject.setup.keys()];
  const coverage = new Map<string, Coverage>(ids.map((id) => [id, { accepted: 0, terminal: [] }]));
  let applied = 0;
  for (const event of events) {
    if (event.payload['sessionId'] !== subject.sessionId) continue;
    if (event.kind === 'steering.applied') {
      applied += 1;
      continue;
    }
    const found = coverage.get(String(event.payload['commandId']));
    if (found === undefined) continue;
    if (event.kind === 'steering.accepted') {
      coverage.set(String(event.payload['commandId']), { ...found, accepted: found.accepted + 1 });
    } else if (event.kind === 'steering.superseded') {
      found.terminal.push('superseded');
    } else {
      found.terminal.push(
        `${event.kind.slice('steering.'.length)}:${String(event.payload['failureReason'])}`,
      );
    }
  }
  // The session's one command a boundary can apply is the row's: setup commands never apply.
  for (let index = 0; index < applied; index += 1)
    coverage.get(subject.commandId)!.terminal.push('applied');
  return coverage;
}

interface Observed {
  readonly key: string;
  readonly accepted: number;
  readonly terminal: readonly Outcome[];
  readonly required: Outcome;
}

function observe(subjects: readonly Subject[], events: readonly Envelope[]): Observed[] {
  const observed: Observed[] = [];
  for (const subject of subjects) {
    const coverage = coverageOf(subject, events);
    for (const [commandId, { accepted, terminal }] of coverage) {
      const own = commandId === subject.commandId;
      observed.push({
        key: own
          ? rowKey(subject.row)
          : `${rowKey(subject.row)} setup ${commandId.slice(commandId.lastIndexOf('-') + 1)}`,
        accepted,
        terminal,
        required: own ? requiredOutcome(subject.row) : subject.setup.get(commandId)!,
      });
    }
  }
  return observed;
}

function failing(observed: readonly Observed[]): Observed[] {
  return observed.filter(
    (row) => row.accepted !== 1 || row.terminal.length !== 1 || row.terminal[0] !== row.required,
  );
}

async function runTable(ending: Ending, where: Where): Promise<void> {
  const rows = rowsFor(ending, where);
  await withRig(async (rig) => {
    // One at a time: a row's setup writes its session from both processes.
    const subjects: Subject[] = [];
    for (const [index, row] of rows.entries()) subjects.push(await setUp(rig, row, index));
    await runEnding(rig, ending, subjects);
    // Lets an announcement that should not come have its chance to.
    await quietFor(100);
    const observed = observe(subjects, await rig.events());
    console.log(`ROWS ${JSON.stringify(observed.map(({ key, terminal }) => [key, terminal]))}`);
    // Every row was probed: a row the table names but the probe never ran is a stale table.
    expect(observed.filter((row) => AT_HEAD[row.key] === undefined).map((row) => row.key)).toEqual(
      [],
    );
    expect(failing(observed)).toEqual([]);
  });
}

describe('every accepted steering command gets exactly one terminal outcome (COR-2097)', () => {
  for (const ending of Object.keys(ENDINGS) as Ending[]) {
    for (const where of ['A/A', 'A/B'] as const) {
      it(`${ending} (${where}): ${ENDINGS[ending]}`, async () => {
        await runTable(ending, where);
      });
    }
  }

  it('refuses, and accepts nothing of, a kind an idle context cannot take', async () => {
    await withRig(async (rig) => {
      const first = await rig.a.tasks.start('quick', 'go', { principal: 'alice' });
      await waitForTerminal(rig.a, first.id, 'the first run ended');
      for (const kind of KINDS.filter((candidate) => !IDLE_KINDS.includes(candidate))) {
        const answer = await rig.a.contexts.steer(first.contextId, {
          id: `idle-${kind}`,
          principal: 'alice',
          requestedValue: REQUESTED_VALUES[kind][0],
        });
        expect({ kind, outcome: answer.outcome }).toEqual({ kind, outcome: 'session-terminal' });
      }
      const events = await rig.events();
      expect(events.filter((event) => event.kind === 'steering.accepted')).toEqual([]);
    });
  });
});

/** An idle context on A with one accepted `effort` command, `e1`. */
async function idleWithEffort(rig: Rig): Promise<LogOf & { readonly commandId: string }> {
  const first = await rig.a.tasks.start('quick', 'go', { principal: 'alice' });
  await waitForTerminal(rig.a, first.id, 'the first run ended');
  await accept(rig.a, first.contextId, {
    id: 'e1',
    principal: 'alice',
    requestedValue: { target: 'effort', override: 'high' },
  });
  const incarnation = (await rig.a.contexts.get(first.contextId))!.incarnation;
  return { sessionId: first.contextId, incarnation, commandId: 'e1' };
}

/** The terminal events that cover `commandId` of `sessionId`, across every process. */
async function terminalOf(rig: Rig, sessionId: string, commandId: string): Promise<Outcome[]> {
  const terminal: Outcome[] = [];
  for (const event of await rig.events()) {
    if (event.payload['sessionId'] !== sessionId) continue;
    if (event.kind === 'steering.applied') terminal.push('applied');
    else if (event.payload['commandId'] !== commandId) continue;
    else if (event.kind === 'steering.superseded') terminal.push('superseded');
    else if (event.kind !== 'steering.accepted') {
      terminal.push(
        `${event.kind.slice('steering.'.length)}:${String(event.payload['failureReason'])}`,
      );
    }
  }
  return terminal;
}

/** What `bureau` published for `sessionId` from its `steering.accepted` of `commandId` on. */
async function publishedFrom(
  bureau: Bureau,
  sessionId: string,
  commandId: string,
): Promise<string[]> {
  const published = await steeringEvents(bureau);
  const events = published.filter((event) => event.payload['sessionId'] === sessionId);
  const start = events.findIndex(
    (event) => event.kind === 'steering.accepted' && event.payload['commandId'] === commandId,
  );
  return start === -1 ? [] : events.slice(start).map((event) => event.kind);
}

/** Logs an extra row's observation and checks it was probed. */
function extraRow(name: string, observed: unknown): void {
  console.log(`EXTRA ${JSON.stringify([name, observed])}`);
  expect({ name, probed: AT_HEAD_EXTRA[name] !== undefined }).toEqual({ name, probed: true });
}

/**
 * The extra rows, at 9c99b29ad, from the probe run's `EXTRA` lines. Filled from the run, never by
 * hand.
 */
const AT_HEAD_EXTRA: Readonly<Record<string, unknown>> = {
  'applied at admission': {
    'duplicate pause': { state: 'applied', admitter: ['steering.accepted'], hostApplied: 1 },
    'resume of an unpaused run': {
      state: 'applied',
      admitter: ['steering.accepted'],
      hostApplied: 0,
    },
    're-request of the value in force': {
      state: 'applied',
      admitter: ['steering.accepted'],
      hostApplied: 1,
    },
  },
  'two configuration commands, one boundary': ['steering.applied'],
  'seal winner dies before announcing': { terminal: ['failed:run-terminal'], logRemoved: true },
  'orphan sweep meets a pending entry': { keptBySweep: false, terminal: [], logRemoved: true },
  'two drainers race the same entry': { terminal: [] },
};

const OUTBOX_CLAIM_LEASE = 60_000;

describe('the extra rows of the table (COR-2097, revision 2026-11-16)', () => {
  it('a command recorded applied at admission publishes accepted, then applied, both from the admitting process', async () => {
    await withRig(async (rig) => {
      // A duplicate pause after the boundary applied the first.
      const gate = rig.gate();
      const paused = await rig.b.tasks.start(gate.agent, 'go', { principal: 'alice' });
      await waitUntil(gate.entered, { message: 'the run is in its tool' });
      await accept(rig.a, paused.contextId, {
        id: 'p1',
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      await foldOn(rig.b, paused.contextId, 'p1-fold');
      const pausedLog = {
        sessionId: paused.contextId,
        incarnation: (await rig.a.contexts.get(paused.contextId))!.incarnation,
      };
      gate.release();
      await waitUntil(
        () =>
          logHas(rig, pausedLog, (entry) => entry.type === 'applied' && entry.runId === paused.id),
        { message: 'the host applied the first pause' },
      );
      const duplicate = await rig.a.contexts.steer(paused.contextId, {
        id: 'p2',
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });

      // A resume of a run that was never paused.
      const unpausedGate = rig.gate();
      const unpaused = await rig.b.tasks.start(unpausedGate.agent, 'go', { principal: 'alice' });
      await waitUntil(unpausedGate.entered, { message: 'the second run is in its tool' });
      const resume = await rig.a.contexts.steer(unpaused.contextId, {
        id: 'r1',
        principal: 'alice',
        requestedValue: { target: 'resume' },
      });

      // A re-request of the value in force, after a run applied it.
      const idle = await idleWithEffort(rig);
      const next = await rig.b.tasks.start('quick', 'again', {
        principal: 'alice',
        contextId: idle.sessionId,
      });
      await waitForTerminal(rig.b, next.id, 'the run that applies e1 ended');
      const again = await rig.a.contexts.steer(idle.sessionId, {
        id: 'e2',
        principal: 'alice',
        requestedValue: { target: 'effort', override: 'high' },
      });
      unpausedGate.release();
      await waitForTerminal(rig.b, unpaused.id, 'the second run ended');
      await quietFor(100);

      const stateOf = (answer: typeof duplicate) =>
        answer.outcome === 'accepted' ? answer.command.state : answer.outcome;
      /** The `steering.applied` events the host published for the session: its own boundaries'. */
      const hostApplied = async (sessionId: string) => {
        const published = await steeringEvents(rig.b);
        return published.filter(
          (event) => event.kind === 'steering.applied' && event.payload['sessionId'] === sessionId,
        ).length;
      };
      const observed = {
        'duplicate pause': {
          state: stateOf(duplicate),
          admitter: await publishedFrom(rig.a, paused.contextId, 'p2'),
          hostApplied: await hostApplied(paused.contextId),
        },
        'resume of an unpaused run': {
          state: stateOf(resume),
          admitter: await publishedFrom(rig.a, unpaused.contextId, 'r1'),
          hostApplied: await hostApplied(unpaused.contextId),
        },
        're-request of the value in force': {
          state: stateOf(again),
          admitter: await publishedFrom(rig.a, idle.sessionId, 'e2'),
          hostApplied: await hostApplied(idle.sessionId),
        },
      };
      extraRow('applied at admission', observed);
      const admitter = ['steering.accepted', 'steering.applied'];
      expect(observed).toEqual({
        // The host's one is the first pause's boundary.
        'duplicate pause': { state: 'applied', admitter, hostApplied: 1 },
        'resume of an unpaused run': { state: 'applied', admitter, hostApplied: 0 },
        // The host's one is the run that applied `e1`.
        're-request of the value in force': { state: 'applied', admitter, hostApplied: 1 },
      });
    });
  });

  it('one boundary applying two configuration commands publishes one steering.applied covering both', async () => {
    await withRig(async (rig) => {
      const gate = rig.gate();
      const run = await rig.b.tasks.start(gate.agent, 'go', { principal: 'alice' });
      await waitUntil(gate.entered, { message: 'the run is in its tool' });
      await accept(rig.a, run.contextId, {
        id: 'm1',
        principal: 'alice',
        requestedValue: REQUESTED_VALUES.model[0],
      });
      await accept(rig.a, run.contextId, {
        id: 'e1',
        principal: 'alice',
        requestedValue: REQUESTED_VALUES.effort[0],
      });
      await foldOn(rig.b, run.contextId, 'm1-fold');
      gate.release();
      await waitForTerminal(rig.b, run.id, 'the run ended');
      await quietFor(100);
      const published = await rig.events();
      const observed = published
        .filter(
          (event) =>
            event.payload['sessionId'] === run.contextId &&
            event.kind !== 'steering.accepted' &&
            event.kind !== 'steering.rejected',
        )
        .map((event) => event.kind);
      extraRow('two configuration commands, one boundary', observed);
      expect(observed).toEqual(['steering.applied']);
    });
  });

  it('a seal winner that dies before it announces loses that outcome: no other process announces it (at most once)', async () => {
    await withRig(async (rig) => {
      // A pause bound to a run A hosts, and B deletes the session, so B awaits no run of its own.
      const run = await rig.a.tasks.start('parked', 'go', { principal: 'alice' });
      await waitUntil(
        async () => {
          const session = await rig.a.contexts.get(run.contextId);
          return session?.metadata['lastRunStatus'] === 'running';
        },
        { message: 'the run is live' },
      );
      await accept(rig.a, run.contextId, {
        id: 'p1',
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      const incarnation = (await rig.a.contexts.get(run.contextId))!.incarnation;
      rig.refuseClaims(rig.a);
      rig.refuseClaims(rig.b);
      await rig.b.contexts.delete(run.contextId);
      // The winner sealed the log and went down before its announcement: the entry is pending.
      const kv = rig.b.internals.kv!;
      const head = await readSteeringLogHead(kv, run.contextId, incarnation);
      await sealSteeringLog(kv, run.contextId, incarnation, head);
      // A process that never served the session boots, and drains the entry.
      await rig.open();
      await waitUntil(() => outboxDrained(rig.b), { message: 'the entry drained' });
      // The log is removed beside the drain, once the entry is acknowledged.
      await waitUntil(() => logRemoved(kv, run.contextId, incarnation), {
        message: 'the log was removed',
      });
      await quietFor(100);
      const observed = {
        terminal: await terminalOf(rig, run.contextId, 'p1'),
        logRemoved: await logRemoved(kv, run.contextId, incarnation),
      };
      extraRow('seal winner dies before announcing', observed);
      expect(observed).toEqual({ terminal: [], logRemoved: true });
    });
  });

  it('the orphan sweep keeps a log whose session.deleted entry is pending, and the drain announces from it', async () => {
    await withRig(async (rig) => {
      const idle = await idleWithEffort(rig);
      rig.refuseClaims(rig.a);
      rig.refuseClaims(rig.b);
      await rig.a.contexts.delete(idle.sessionId);
      const [entry] = await rig.b.internals.sessionStore!.outbox.pending();
      expect(entry?.kind).toBe('session.deleted');
      // Another drainer holds the entry, so a process that boots now sweeps with it pending.
      await originalClaims.get(rig.b)!(entry!.ordinal, {
        owner: 'drainer-holding-the-entry',
        until: Date.now() + OUTBOX_CLAIM_LEASE,
      });
      const sweeper = await rig.open();
      // Shutdown awaits the boot sweep.
      await rig.retire(sweeper);
      const kv = rig.b.internals.kv!;
      const keptBySweep = !(await logRemoved(kv, idle.sessionId, idle.incarnation));
      // The holder's lease lapses, and a process past it drains the entry.
      await rig.open(2 * OUTBOX_CLAIM_LEASE);
      await waitUntil(() => outboxDrained(rig.b), { message: 'the entry drained' });
      await waitUntil(() => logRemoved(kv, idle.sessionId, idle.incarnation), {
        message: 'the log was removed',
      });
      await quietFor(100);
      const observed = {
        keptBySweep,
        terminal: await terminalOf(rig, idle.sessionId, idle.commandId),
        logRemoved: await logRemoved(kv, idle.sessionId, idle.incarnation),
      };
      extraRow('orphan sweep meets a pending entry', observed);
      expect(observed).toEqual({
        keptBySweep: true,
        terminal: ['failed:session-terminal'],
        logRemoved: true,
      });
    });
  });

  it('two drainers that both claim the same entry announce it once: the seal decides', async () => {
    await withRig(async (rig) => {
      const idle = await idleWithEffort(rig);
      rig.refuseClaims(rig.a);
      rig.refuseClaims(rig.b);
      await rig.a.contexts.delete(idle.sessionId);
      const [entry] = await rig.b.internals.sessionStore!.outbox.pending();
      expect(entry?.kind).toBe('session.deleted');
      // Both drainers hold the entry at once, as a lapsed lease and its successor can.
      const both = Promise.withResolvers<void>();
      let arrived = 0;
      for (const drainer of [rig.a, rig.b]) {
        patchClaims(drainer, (original) => async (ordinal, lease) => {
          const real = await original(ordinal, lease);
          if (ordinal !== entry!.ordinal) return real;
          arrived += 1;
          if (arrived === 2) both.resolve();
          await both.promise;
          return { ...real, claimed: true };
        });
      }
      await Promise.all([rig.a.maintain(), rig.b.maintain()]);
      await waitUntil(() => outboxDrained(rig.b), { message: 'the entry drained' });
      await quietFor(100);
      const observed = { terminal: await terminalOf(rig, idle.sessionId, idle.commandId) };
      extraRow('two drainers race the same entry', observed);
      expect(observed).toEqual({ terminal: ['failed:session-terminal'] });
    });
  });
});
