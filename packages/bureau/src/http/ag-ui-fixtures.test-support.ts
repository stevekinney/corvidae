/**
 * A Bureau served through `createBureauHandler`'s AG-UI mount, for the tests that
 * drive it: scripted runs (no model), requests for the four routes, and the
 * credentials of a few callers.
 */
import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';
import {
  type AgentSkills,
  type BackendDescriptor,
  createAgent,
  type MediaCostEstimator,
  createScriptedGenerate,
  type GuardrailsOptions,
  type ScriptedGenerate,
  type ScriptedGenerateStep,
  type StepContext,
  type StopCondition,
  stopWhen,
  withBackendDescriptors,
} from '@lostgradient/operative';
import {
  type AuthConfig,
  createOperationHandler,
  principalFromApiKey,
  type AuthorizationScope,
} from '@lostgradient/weft';
import { type Storage, MemoryStorage } from '@lostgradient/storage';
import { createToolbox, type Toolbox } from 'armorer';
import type { RunAgentInput } from '@ag-ui/core';

import { createMemoryAssetStorage } from '../assets/storage';
import type { GovernedMemory } from '@lostgradient/memory';

import { createBureau } from '../create-bureau.ts';
import { seamStorage, type StorageSeam } from '../test/session-input-fixtures.ts';
import { createSqliteStorageFixture } from '../test/storage-fixtures.ts';
import type { Bureau, BureauDiagnostic, BureauOptions } from '../types.ts';
import {
  type AgUiAuthorization,
  type AgUiBureau,
  type AgUiOptions,
  createAgUiMount,
} from './ag-ui-mount.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { mayAccessOwnedResource } from './owner-predicate.ts';
import type { AgentDefinitions } from '../agent-catalog';

export const AGENT = 'assistant';

export type Handler = (request: Request) => Promise<Response>;

export type Harness = {
  readonly bureau: Bureau;
  readonly handler: Handler;
  readonly generate: ScriptedGenerate;
  /**
   * The seam over this Bureau's own connection to the SQLite file, under `seamStorage: true`.
   * A peer has a seam of its own over the same file.
   */
  readonly seam: StorageSeam | undefined;
  /** A second handler, with a mount of its own, over the same Bureau: what another process would serve. */
  remount(agUi?: AgUiOptions): Handler;
  /**
   * Closes this Bureau and opens another over the same storage, running `script`: a
   * process restart. The returned harness owns the storage from here on.
   */
  restart(script: readonly ScriptedGenerateStep[], agUi?: AgUiOptions): Promise<Harness>;
  /**
   * Opens a second Bureau over the same storage while this one stays open, running
   * `script`: another process on one backend. It shares nothing with this one but the
   * store, and leaves the storage to this harness to close.
   */
  peer(script: readonly ScriptedGenerateStep[], agUi?: AgUiOptions): Promise<Harness>;
  dispose(): Promise<void>;
};

export type HarnessOptions = {
  readonly script: readonly ScriptedGenerateStep[];
  readonly toolbox?: Toolbox;
  readonly stopWhen?: StopCondition;
  /** The agents' step cap, where a test needs a run to reach it (COR-1627). */
  readonly maximumSteps?: number;
  /** The agents' answer for a run that reaches its step cap. */
  readonly onMaximumSteps?: (context: StepContext) => Promise<string | void>;
  /** Further agents, each running the same script as `assistant`. */
  readonly otherAgents?: readonly string[];
  /** `'sqlite'` keeps a durable event history, so terminal events carry cursors. */
  readonly storage?: 'memory' | 'sqlite';
  readonly agUi?: AgUiOptions;
  /** The runtime the Bureau itself runs on (its clock included), where a test must move it. */
  readonly bureauRuntime?: RuntimeServices;
  /** `'manual'` keeps the Bureau from sweeping on its own timers, so state a test leaves stale stays stale. */
  readonly maintenance?: 'automatic' | 'manual';
  /** Serve with these credentials instead of the one anonymous local caller. */
  readonly authentication?: AuthConfig;
  /** Receives the Bureau's diagnostics. */
  readonly onDiagnostic?: (diagnostic: BureauDiagnostic) => void;
  /** Governed memory, shared by this Bureau and every peer of it, so a run recalls (COR-1546). */
  readonly memory?: GovernedMemory;
  /**
   * With `storage: 'sqlite'`, each Bureau opens its own connection to the file through a
   * {@link seamStorage}, exposed as `harness.seam`, so a test can hold or watch one Bureau's writes.
   */
  readonly seamStorage?: true;
  /** The guardrails the harness agents run with, such as an input detector that trips. */
  readonly guardrails?: GuardrailsOptions;
  /**
   * The durable engine's ownership posture. Two Bureaus over one store hear each other's commits
   * (a signal, a cancel, a terminal) at the claim renewal interval, so a test of them shortens it.
   */
  readonly durableOwnership?: BureauOptions['durableOwnership'];
  /**
   * The backends the scripted model describes itself as, which decide the media it accepts and
   * produces. Omitted, it carries no descriptors and so admits no media.
   */
  readonly backends?: readonly BackendDescriptor[];
  /** Costs each media part of a run, in place of the backends' own rows: an agent may supply one. */
  readonly mediaCostEstimator?: MediaCostEstimator;
  /** The skills the `default` agent may activate (COR-1628). */
  readonly skills?: AgentSkills;
};

/** Keys the suites present, by name, with the scopes each holds. */
export const CREDENTIALS: Record<
  string,
  { subject: string; scopes: readonly AuthorizationScope[] }
> = {
  'alice-key': { subject: 'alice', scopes: [] },
  'bob-key': { subject: 'bob', scopes: [] },
  /** The same owner as `alice-key`, holding the scope an asset reference in a chat start needs. */
  'alice-assets-key': { subject: 'alice', scopes: ['bureau.assets:read'] },
  'reader-key': { subject: 'reader', scopes: ['bureau.tasks:read'] },
  'writer-key': { subject: 'writer', scopes: ['bureau.tasks:write'] },
  'writer-reader-key': {
    subject: 'writer-reader',
    scopes: ['bureau.tasks:read', 'bureau.tasks:write'],
  },
  'operator-key': { subject: 'operator', scopes: [...BUREAU_SCOPES] },
};

export const authentication: AuthConfig = {
  auditSink: () => undefined,
  resolveApiKeyPrincipal: async (key) => {
    const credential = CREDENTIALS[key];
    return credential === undefined
      ? null
      : principalFromApiKey({ subject: credential.subject, scopes: [...credential.scopes] });
  },
};

export function as(key: string): Record<string, string> {
  return { 'X-API-Key': key };
}

/** What `openHarness` keeps so a restarted Bureau opens over the same storage. */
type StorageFixture = ReturnType<typeof createSqliteStorageFixture>;

async function build(
  options: HarnessOptions,
  fixture: StorageFixture | undefined,
  ownsStorage = true,
): Promise<Harness> {
  const generate = createScriptedGenerate(options.script);
  // Under `seamStorage`, this Bureau's own connection to the file, which Bureau does not close.
  let real: Storage | undefined;
  let seam: StorageSeam | undefined;
  if (options.seamStorage === true && fixture !== undefined) {
    real = fixture.open();
    seam = seamStorage(real);
  }
  if (options.backends !== undefined) withBackendDescriptors(generate, options.backends);
  const bureau = await createBureau<AgentDefinitions>({
    id: 'ag-ui-fixture',
    agents: {
      ...Object.fromEntries(
        [AGENT, ...(options.otherAgents ?? [])].map((name) => [
          name,
          // A run in a session takes its stop condition and its toolbox from the agent that
          // owns it (COR-1577), not from the Bureau, so the agent carries the ones the test chose.
          createAgent({
            generate,
            name,
            ...(options.toolbox === undefined ? {} : { toolbox: options.toolbox }),
            ...(options.guardrails === undefined ? {} : { guardrails: options.guardrails }),
            ...(options.skills === undefined ? {} : { skills: options.skills }),
            ...(options.mediaCostEstimator === undefined
              ? {}
              : { mediaCostEstimator: options.mediaCostEstimator }),
            stopWhen:
              options.stopWhen ?? stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
            ...(options.maximumSteps === undefined ? {} : { maximumSteps: options.maximumSteps }),
            ...(options.onMaximumSteps === undefined
              ? {}
              : { onMaximumSteps: options.onMaximumSteps }),
          }),
        ]),
      ),
      default: createAgent({
        generate,
        toolbox: options.toolbox ?? (createToolbox([]) as unknown as Toolbox),
        ...(options.skills === undefined ? {} : { skills: options.skills }),
        stopWhen:
          options.stopWhen ?? stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
      }),
    },
    storage: seam?.storage ?? fixture?.storage ?? new MemoryStorage(),
    durable: true,
    // The handler serves the asset operations and the content route, so it needs the service.
    assets: { storage: createMemoryAssetStorage() },
    ...(options.bureauRuntime === undefined ? {} : { runtime: options.bureauRuntime }),
    ...(options.maintenance === undefined ? {} : { maintenance: options.maintenance }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    ...(options.durableOwnership === undefined
      ? {}
      : { durableOwnership: options.durableOwnership }),
  });
  const mount = (agUi: AgUiOptions | undefined): Handler =>
    createBureauHandler(bureau, {
      ...(options.authentication === undefined
        ? { unauthenticatedAccess: 'allow' as const }
        : { authentication: options.authentication }),
      agUi: agUi ?? {},
    });
  let restarted = false;
  return {
    bureau: bureau,
    handler: mount(options.agUi),
    generate,
    seam,
    remount: (agUi) => mount(agUi ?? options.agUi),
    async restart(script, agUi) {
      restarted = true;
      await bureau.dispose();
      real?.[Symbol.dispose]();
      return build({ ...options, script, ...(agUi === undefined ? {} : { agUi }) }, fixture);
    },
    peer: (script, agUi) =>
      build({ ...options, script, ...(agUi === undefined ? {} : { agUi }) }, fixture, false),
    async dispose() {
      if (restarted) return;
      await bureau.dispose();
      real?.[Symbol.dispose]();
      if (ownsStorage) await fixture?.dispose();
    },
  };
}

export async function openHarness(options: HarnessOptions): Promise<Harness> {
  const fixture =
    options.storage === 'sqlite'
      ? createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() })
      : undefined;
  return build(options, fixture);
}

export function runAgentInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: 'thread-1',
    runId: 'client-run-1',
    messages: [{ id: 'user-1', role: 'user', content: 'hello' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    ...overrides,
  };
}

export function startRequest(
  input: RunAgentInput,
  headers: Record<string, string> = {},
  agent = AGENT,
  prefix = '/ag-ui',
): Request {
  return new Request(`http://localhost${prefix}/agents/${agent}/run`, {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(input),
  });
}

export function attachThreadRequest(
  threadId: string,
  headers: Record<string, string> = {},
  prefix = '/ag-ui',
): Request {
  return new Request(`http://localhost${prefix}/threads/${encodeURIComponent(threadId)}/run`, {
    headers: { Accept: 'text/event-stream', ...headers },
  });
}

export function attachRunRequest(
  runId: string,
  headers: Record<string, string> = {},
  prefix = '/ag-ui',
): Request {
  return new Request(`http://localhost${prefix}/runs/${encodeURIComponent(runId)}`, {
    headers: { Accept: 'text/event-stream', ...headers },
  });
}

export function cancelRequest(
  runId: string,
  headers: Record<string, string> = {},
  prefix = '/ag-ui',
): Request {
  return new Request(`http://localhost${prefix}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers,
  });
}

/**
 * A handler over `bureau`, authenticating alice, whose authorization says every owner of record is
 * alice's: what the owner-of-record read said before a thread was recreated under another owner,
 * so a test can hand the mount a Bureau whose own records are another's.
 */
export function aliceHandlerOver(bureau: AgUiBureau): Handler {
  const authorization: AgUiAuthorization = {
    mayAccess: mayAccessOwnedResource,
    ownerOf: async () => 'api-key:alice',
  };
  const mount = createAgUiMount(bureau, authorization, ['assistant'], {});
  return createOperationHandler({
    operations: [],
    host: {} as never,
    authenticate: async () => ({
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'alice', scopes: [] }),
    }),
    mounts: [mount],
  });
}
