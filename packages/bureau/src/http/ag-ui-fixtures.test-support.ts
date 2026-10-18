/**
 * A Bureau served through `createBureauHandler`'s AG-UI mount, for the tests that
 * drive it: scripted runs (no model), requests for the four routes, and the
 * credentials of a few callers.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createScriptedGenerate,
  type ScriptedGenerate,
  type ScriptedGenerateStep,
  type StopCondition,
  stopWhen,
} from '@lostgradient/operative';
import { type AuthConfig, principalFromApiKey, type AuthorizationScope } from '@lostgradient/weft';
import { createToolbox, type Toolbox } from 'armorer';
import type { RunAgentInput } from '@ag-ui/core';

import { createBureau } from '../create-bureau.ts';
import { createSqliteStorageFixture } from '../test/storage-fixtures.ts';
import type { Bureau, BureauDiagnostic } from '../types.ts';
import type { AgUiOptions } from './ag-ui-mount.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

export const AGENT = 'assistant';

export type Handler = (request: Request) => Promise<Response>;

export type Harness = {
  readonly bureau: Bureau;
  readonly handler: Handler;
  readonly generate: ScriptedGenerate;
  /** A second handler, with a mount of its own, over the same Bureau: what another process would serve. */
  remount(agUi?: AgUiOptions): Handler;
  /**
   * Closes this Bureau and opens another over the same storage, running `script`: a
   * process restart. The returned harness owns the storage from here on.
   */
  restart(script: readonly ScriptedGenerateStep[]): Promise<Harness>;
  dispose(): Promise<void>;
};

export type HarnessOptions = {
  readonly script: readonly ScriptedGenerateStep[];
  readonly toolbox?: Toolbox;
  readonly stopWhen?: StopCondition;
  readonly humanInput?: boolean;
  /** `'sqlite'` keeps a durable event history, so terminal events carry cursors. */
  readonly storage?: 'memory' | 'sqlite';
  readonly agUi?: AgUiOptions;
  /** Serve with these credentials instead of the one anonymous local caller. */
  readonly authentication?: AuthConfig;
  /** Receives the Bureau's diagnostics. */
  readonly onDiagnostic?: (diagnostic: BureauDiagnostic) => void;
};

/** Keys the suites present, by name, with the scopes each holds. */
export const CREDENTIALS: Record<
  string,
  { subject: string; scopes: readonly AuthorizationScope[] }
> = {
  'alice-key': { subject: 'alice', scopes: [] },
  'bob-key': { subject: 'bob', scopes: [] },
  'reader-key': { subject: 'reader', scopes: ['bureau.tasks:read'] },
  'writer-key': { subject: 'writer', scopes: ['bureau.tasks:write'] },
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
): Promise<Harness> {
  const generate = createScriptedGenerate(options.script);
  const bureau = await createBureau({
    id: 'ag-ui-fixture',
    agents: { [AGENT]: createAgent({ generate, name: AGENT }) },
    generate,
    toolbox: options.toolbox ?? (createToolbox([]) as unknown as Toolbox),
    storage: fixture?.configuration ?? { type: 'memory' },
    durableExecution: true,
    sessionPersistenceRetryDelayMilliseconds: 0,
    ...(options.humanInput === true ? { humanInput: true } : {}),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    stopWhen: options.stopWhen ?? stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
  });
  const mount = (agUi: AgUiOptions | undefined): Handler =>
    createBureauHandler(bureau, {
      ...(options.authentication === undefined
        ? { unauthenticatedAccess: 'allow' as const }
        : { authentication: options.authentication }),
      publish: [AGENT],
      agUi: agUi ?? {},
    });
  let restarted = false;
  return {
    bureau: bureau as unknown as Bureau,
    handler: mount(options.agUi),
    generate,
    remount: (agUi) => mount(agUi ?? options.agUi),
    async restart(script) {
      restarted = true;
      await bureau.dispose();
      return build({ ...options, script }, fixture);
    },
    async dispose() {
      if (restarted) return;
      await bureau.dispose();
      await fixture?.dispose();
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
