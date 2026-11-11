import type { RuntimeServices } from '@lostgradient/lifecycle';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type {
  DurableRunDeps,
  RequestHumanInputContext,
  ScheduleWakeupContext,
  RequestHumanInputInput,
  ScheduleWakeupInput,
  AgentSession,
  JSONValue,
  HumanInputSchema,
} from '@lostgradient/operative';
import {
  createRequestHumanInputTool,
  createScheduleWakeupTool,
  SESSION_OWNER_METADATA_KEY,
} from '@lostgradient/operative';
import { createDecideToolbox } from './decisions/decide-tool';
import { humanInputEnabled, humanInputSchemasOf } from './human-input-option';
import type { TaskToolGrant } from './task-registry';
import { withChatPermissionStanding } from './tool-approval';
import { withAddedTools, withToolboxLayer } from './toolbox-additions';
import {
  createToolbox,
  createTool,
  type ToolRequestContext,
  readRunWorkspaceAuthority,
  type AnyToolbox,
  type ToolCallInput,
  type ToolboxExecuteOptions,
} from 'armorer';
import { SCHEDULER_ACTOR } from './owner-of-record';
import { isPlainAuthorityRecord } from './session-authority';
import { ownEntry } from './own-entry';
import type {
  BureauToolbox,
  HumanWaitEventDispatcher,
  RuntimeCompositionOptions,
  WireDurableOptInToolsOptions,
} from './runtime-composition-types';

export function createHumanWaitContext(
  servicesRef: { current?: DurableRunDeps },
  runId: string,
): RequestHumanInputContext {
  return {
    get pendingHumanWait() {
      return servicesRef.current?.pendingHumanWait;
    },
    set pendingHumanWait(value) {
      if (servicesRef.current) {
        servicesRef.current.pendingHumanWait = value;
      }
    },
    // COR-1578 — read-only: a wakeup already requested in this step refuses a human-input request.
    get pendingWakeup() {
      return servicesRef.current?.pendingWakeup;
    },
    get pendingChildWait() {
      return servicesRef.current?.pendingChildWait;
    },
    runId,
    // Only ever constructed inside the `options.humanInput && runtime.durable`
    // guard below, so this context always backs a real durable run
    // (AB-41 / AB-43 — the durability signal threaded into the tool's context).
    durable: true,
  };
}
/**
 * AB-201 — the `scheduleWakeup` analog of {@link createHumanWaitContext}: forwards
 * reads/writes onto the run's REAL `ctx.services` object (via the same
 * `servicesRef` capture) rather than spreading it, so the tool's `pendingWakeup`
 * writes land where the durable `agentRun` workflow actually reads them.
 * `ScheduleWakeupContext` carries no `runId` field (unlike
 * `RequestHumanInputContext`), so this takes only the shared `servicesRef`. It also forwards a
 * read-only view of the human-wait slot, so a wakeup request made after a human-input request in the
 * same step is refused (COR-1578).
 */
export function createWakeupContext(servicesRef: {
  current?: DurableRunDeps;
}): ScheduleWakeupContext {
  return {
    get pendingWakeup() {
      return servicesRef.current?.pendingWakeup;
    },
    set pendingWakeup(value) {
      if (servicesRef.current) {
        servicesRef.current.pendingWakeup = value;
      }
    },
    // COR-1578 — read-only: a human-input request already made in this step refuses a wakeup.
    get pendingHumanWait() {
      return servicesRef.current?.pendingHumanWait;
    },
    get pendingChildWait() {
      return servicesRef.current?.pendingChildWait;
    },
    // Only ever constructed inside the `options.wakeup && runtime.durable`
    // guard (below, in `createBureau`'s run composition — same placement as
    // `createHumanWaitContext`'s own guard), so this context always backs a
    // real durable run (AB-41 / AB-43 — the durability signal threaded into
    // the tool's context).
    durable: true,
  };
}
/**
 * Type guard, not a cast: `DurableRunDeps.emitter`'s own `EventDispatcher`
 * type declares only `dispatch`, never the DOM-style `dispatchEvent` every
 * real emitter (a `CompletableEventTarget`) also carries — see
 * `buildRunDepsFromSession`'s lazy `humanInputEmitter` forwarder.
 */
export function hasDispatchEvent(value: unknown): value is HumanWaitEventDispatcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { dispatchEvent?: unknown }).dispatchEvent === 'function'
  );
}
/**
 * AB-336 — the ONE place both the fresh-dispatch (`createRunFromRequest`)
 * and recovery (`buildRunDepsFromSession`) paths wire `requestHumanInput`/
 * `scheduleWakeup` into a run's toolbox, per the repository's No Duplicated
 * Code rule. Root cause this closes: `buildRunDepsFromSession` used to
 * return `runRuntime.toolbox` bare — the opt-in durable-park tools existed
 * ONLY on the fresh path. A run recovered mid-step whose replay reached a
 * `requestHumanInput` call found no such tool: armorer settled the call
 * with a tool-not-found error result, `pendingHumanWait` never got set, the
 * durable park never fired, and the step loop simply continued to the next
 * step — the exact "looped instead of parking" symptom this issue names,
 * observable only on a RECOVERED run whose replay reaches the call (a run
 * killed AFTER the call's step already committed is a different case,
 * covered by `create-bureau.ts`'s `reconstructHumanWaitReviewIfParked`).
 *
 * `servicesRef` is supplied by the caller, not created here: the tools'
 * mutable `pendingHumanWait`/`pendingWakeup` slots must be the EXACT
 * `ctx.services` object Weft hands back, and each caller has a different
 * point at which that object becomes available (a later `onServices` hook
 * for a fresh run; the object under construction, synchronously, for a
 * recovered one) — see each call site's own comment.
 */
export function wireDurableOptInTools(
  baseToolbox: BureauToolbox,
  servicesRef: { current?: DurableRunDeps },
  options: WireDurableOptInToolsOptions,
): BureauToolbox {
  let toolbox = baseToolbox;

  if (options.humanInput) {
    const humanWaitContext = createHumanWaitContext(servicesRef, options.runId);
    const rawHumanInputTool = createRequestHumanInputTool({
      context: humanWaitContext,
      ...(options.inputSchemas ? { inputSchemas: options.inputSchemas } : {}),
      ...(options.humanInputEmitter ? { emitter: options.humanInputEmitter } : {}),
    });
    const humanInputToolbox = createToolbox([
      createTool({
        ...rawHumanInputTool,
        // armorer's `execute` contract is async; the raw tool factory's
        // `execute` is synchronous (it only mutates `context` and returns a
        // plain result), so wrap it rather than changing its public shape.
        // Must stay `async` so a synchronous throw from `execute` is
        // converted into a rejected Promise instead of escaping
        // synchronously (Copilot review PRRT_kwDORvupsc6P7_8H) — awaiting
        // `Promise.resolve(...)` (a genuine thenable) keeps both
        // require-await and await-thenable satisfied.
        //
        // COR-1947: it only asks a person, so no permission mode stands in front of it.
        execute: withChatPermissionStanding(
          async (input: RequestHumanInputInput) =>
            await Promise.resolve(rawHumanInputTool.execute(input)),
          'outside-the-mode',
        ),
      }),
    ]);
    toolbox = withAddedTools(toolbox, humanInputToolbox);
  }

  if (options.decide !== undefined) {
    toolbox = withAddedTools(
      toolbox,
      createDecideToolbox({ ...options.decide, taskId: options.runId }),
    );
  }

  if (options.wakeup) {
    // `ctx.sleep` is itself the durable checkpoint, and recovery re-arms it with no live wiring
    // needed (AB-41's decision record). The tool announces the request it accepted (COR-1806) on
    // the run's own emitter, read lazily from `ctx.services` as `requestHumanInput`'s recovery
    // forwarder reads it: the run's `services.emitter` settles after this wiring but before any
    // tool call. A recovered run whose replay re-executes the call announces it again, as it
    // would announce a human wait.
    const wakeupContext = createWakeupContext(servicesRef);
    const rawWakeupTool = createScheduleWakeupTool({
      context: wakeupContext,
      emitter: {
        dispatchEvent: (event: Event) => {
          const target = servicesRef.current?.emitter;
          return hasDispatchEvent(target) ? target.dispatchEvent(event) : false;
        },
      },
      now: () =>
        (servicesRef.current?.options.runtime ?? createDefaultRuntimeServices()).clock.now(),
    });
    const wakeupToolbox = createToolbox([
      createTool({
        ...rawWakeupTool,
        // COR-1947: it schedules work, so `read-only` denies it. It parks the step that called it,
        // and an approved call runs after that step, so `always` denies it too: the call could
        // only say it scheduled a wakeup that never comes. No version, for the same reason:
        // Armorer can raise no approval for it.
        metadata: { mutates: true },
        // Same async-wrap rationale as `requestHumanInput` above: the raw
        // tool's `execute` is synchronous and can throw synchronously
        // (`DurableCapabilityUnavailableError`); armorer's contract is
        // async, so wrapping converts a synchronous throw into a rejected
        // Promise instead of letting it escape synchronously.
        execute: withChatPermissionStanding(
          async (input: ScheduleWakeupInput) => await Promise.resolve(rawWakeupTool.execute(input)),
          'cannot-wait-for-approval',
        ),
      }),
    ]);
    toolbox = withAddedTools(toolbox, wakeupToolbox);
  }

  return toolbox;
}
/**
 * COR-1709 — the owner of record of a recovered session run: the owner recorded for the run, else
 * the session's, else none.
 */
export function recoveredOwnerOf(session: AgentSession, runId: string): string | undefined {
  const owners = session.metadata['lastRunOwningPrincipals'];
  const runOwner = isPlainAuthorityRecord(owners) ? ownEntry(owners, runId) : undefined;
  if (typeof runOwner === 'string') return runOwner;
  const sessionOwner = session.metadata[SESSION_OWNER_METADATA_KEY];
  return typeof sessionOwner === 'string' ? sessionOwner : undefined;
}
const requestAuthorityMetadataKey = 'lastRequestAuthority';
const requestAuthoritiesMetadataKey = 'lastRequestAuthorities';
export const defaultBureauAgentName = 'bureau';
const schedulerServicePrincipalId = SCHEDULER_ACTOR;
const schedulerServiceAuthorizationRevision = 'bureau:scheduler:1';
const toolExecutionCapability = 'tools:execute';
function isJsonRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requestContextFromAuthorityValue(
  value: JSONValue | undefined,
  runId: string | undefined,
  sessionId: string | undefined,
  agentName: string | undefined,
  now: () => number,
): ToolRequestContext | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const authority = value as Record<string, JSONValue>;
  const capabilities = authority['capabilities'];
  const workspace = readRunWorkspaceAuthority(authority['workspace']);
  if (authority['workspace'] !== undefined && workspace === undefined) return undefined;
  const audience = authority['audience'];
  const deadline = authority['deadline'];
  if (
    typeof authority['principalId'] !== 'string' ||
    typeof authority['tenantId'] !== 'string' ||
    typeof authority['ownerId'] !== 'string' ||
    typeof authority['authorizationRevision'] !== 'string' ||
    !Array.isArray(capabilities) ||
    !capabilities.every((capability) => typeof capability === 'string') ||
    (audience !== undefined &&
      audience !== 'public' &&
      audience !== 'tenant' &&
      audience !== 'operator') ||
    (deadline !== undefined && (typeof deadline !== 'number' || !Number.isFinite(deadline)))
  ) {
    return undefined;
  }
  if (typeof deadline === 'number' && deadline <= now()) return undefined;
  return {
    authority: {
      principalId: authority['principalId'],
      tenantId: authority['tenantId'],
      ownerId: authority['ownerId'],
      capabilities: Object.freeze([...capabilities] as string[]),
      authorizationRevision: authority['authorizationRevision'],
      ...(workspace === undefined ? {} : { workspace }),
    },
    ...(audience !== undefined ? { audience } : {}),
    ...(typeof deadline === 'number' ? { deadline } : {}),
    ...(agentName !== undefined ? { agentId: agentName } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}
/**
 * AB-260: exported directly rather than through the retired
 * `RuntimeCompositionTestingSeams` grouping — a genuine injection seam, not
 * introspection, since its only non-pure dependency was the wall clock
 * consulted for `requestContextFromAuthorityValue`'s deadline check. A test
 * calls this directly with a manual `now`, exactly as `createRuntimeComposition`
 * itself does with the bureau's composed `RuntimeServices.clock.now`.
 */
export function recoveredRequestContext(
  metadata: Record<string, JSONValue>,
  runId: string | undefined,
  sessionId: string | undefined,
  agentName: string | undefined,
  now: () => number,
): ToolRequestContext | undefined {
  const authorities = metadata[requestAuthoritiesMetadataKey];
  if (isJsonRecord(authorities)) {
    return requestContextFromAuthorityValue(
      runId === undefined ? undefined : ownEntry(authorities, runId),
      runId,
      sessionId,
      agentName,
      now,
    );
  }
  return requestContextFromAuthorityValue(
    metadata[requestAuthorityMetadataKey],
    runId,
    sessionId,
    agentName,
    now,
  );
}
function normalizedServiceAgentName(agentName: string | undefined): string {
  const trimmed = agentName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : defaultBureauAgentName;
}
export function createSchedulerServiceRequestContext(
  runId: string,
  agentName: string | undefined,
  sessionId?: string,
) {
  const ownerId = normalizedServiceAgentName(agentName);
  return {
    authority: {
      principalId: schedulerServicePrincipalId,
      tenantId: 'bureau',
      ownerId,
      capabilities: Object.freeze([toolExecutionCapability]),
      authorizationRevision: schedulerServiceAuthorizationRevision,
    },
    audience: 'operator',
    agentId: ownerId,
    runId,
    // AB-364 review finding (chatgpt-codex-connector): stamped for
    // consistency with every other request context this module builds —
    // NOT a fix for scheduled-fire grant matching, which the fixed
    // `principalId` above (always `schedulerServicePrincipalId`, never the
    // triggering user's own principal) already blocks unconditionally,
    // independent of scope or sessionId.
    ...(sessionId !== undefined ? { sessionId } : {}),
  } satisfies ToolRequestContext;
}
export function withDefaultToolboxRequestContext(
  toolbox: AnyToolbox,
  requestContext: ToolRequestContext | undefined,
  requestAuthorityValidator: () =>
    ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined,
  runtimeServices: RuntimeServices,
): AnyToolbox {
  if (!requestContext) return toolbox;

  // A layer, so that adding a tool to the toolbox puts this binding back around the result.
  return withToolboxLayer(toolbox, (inner) => {
    const executeWithDefaultRequestContext = (async (
      input: ToolCallInput | ToolCallInput[],
      executeOptions?: ToolboxExecuteOptions,
    ) => {
      const options: ToolboxExecuteOptions = {
        ...executeOptions,
        requestContext: executeOptions?.requestContext ?? requestContext,
      };
      const inheritedValidation = options.revalidateAuthority;
      const revision = options.requestContext!.authority.authorizationRevision;
      const requiresValidation =
        options.requestContext!.authority.workspace !== undefined ||
        (revision !== 'bureau:1' && revision !== 'bureau:scheduler:1');
      if (requiresValidation) {
        options.revalidateAuthority = async (candidate) => {
          const inherited =
            inheritedValidation === undefined ? candidate : await inheritedValidation(candidate);
          if (inherited === undefined) return undefined;
          const validator = requestAuthorityValidator();
          if (
            !validator ||
            !(await raceRequestAuthorityValidation(validator(inherited), options, runtimeServices))
          )
            return undefined;
          return inherited;
        };
        if ((await options.revalidateAuthority(options.requestContext!)) === undefined)
          throw new Error('Request authority is no longer current.');
      }
      return Array.isArray(input) ? inner.execute(input, options) : inner.execute(input, options);
    }) as AnyToolbox['execute'];

    return new Proxy(inner, {
      get(target, property, receiver) {
        if (property === 'execute') return executeWithDefaultRequestContext;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  });
}
function raceRequestAuthorityValidation(
  validation: boolean | Promise<boolean>,
  options: ToolboxExecuteOptions,
  runtimeServices: RuntimeServices,
): Promise<boolean> {
  const signal = options.signal;
  const deadline = options.requestContext?.deadline;
  const now = options.now ?? runtimeServices.clock.now;
  if (signal?.aborted) {
    return Promise.reject(new Error(String(signal.reason ?? 'Cancelled')));
  }
  if (deadline !== undefined && deadline <= now()) {
    return Promise.reject(new Error('Execution deadline exceeded'));
  }
  if (!signal && deadline === undefined) return Promise.resolve(validation);

  const maximumTimerDelay = 2_147_483_647;
  // AB-260: the timer-scheduling/clearing members are destructured once so
  // the call sites below read `scheduleTimeout(...)`/`clearTimeoutFunction(...)`
  // rather than a literal `timers` method call — see `create-bureau.ts`'s
  // equivalent pattern for why.
  const { setTimeout: defaultScheduleTimeout, clearTimeout: defaultCancelTimeout } =
    runtimeServices.timers;
  const setTimeoutFunction =
    options.setTimeoutFunction ??
    ((callback: () => void, milliseconds: number) =>
      defaultScheduleTimeout(callback, milliseconds));
  const clearTimeoutFunction = options.clearTimeoutFunction ?? defaultCancelTimeout;
  let timer: unknown;
  let onAbort: (() => void) | undefined;
  const interruption = new Promise<boolean>((_resolve, reject) => {
    onAbort = () => reject(new Error(String(signal?.reason ?? 'Cancelled')));
    signal?.addEventListener('abort', onAbort, { once: true });
    const scheduleDeadline = () => {
      if (deadline === undefined) return;
      const remaining = deadline - now();
      if (remaining <= 0) {
        reject(new Error('Execution deadline exceeded'));
        return;
      }
      timer = setTimeoutFunction(scheduleDeadline, Math.min(remaining, maximumTimerDelay));
    };
    scheduleDeadline();
  });
  return Promise.race([Promise.resolve(validation), interruption]).finally(() => {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (timer !== undefined) clearTimeoutFunction(timer);
  });
}
/**
 * COR-1710 — what a task's tool grant offers it. Without a grant (a composition with no settings
 * wired), the options decide, as they did before grants were recorded.
 */
export function grantedTools(
  grant: TaskToolGrant | undefined,
  options: Pick<RuntimeCompositionOptions, 'humanInput' | 'wakeup'>,
): {
  readonly humanInput: boolean;
  readonly inputSchemas: Readonly<Record<string, HumanInputSchema>> | undefined;
  readonly wakeup: boolean;
  readonly decide: boolean;
} {
  if (grant === undefined) {
    return {
      humanInput: humanInputEnabled(options.humanInput),
      inputSchemas: humanInputSchemasOf(options.humanInput),
      wakeup: options.wakeup !== false,
      decide: true,
    };
  }
  return {
    humanInput: grant.humanInput !== false,
    inputSchemas: humanInputSchemasOf(grant.humanInput),
    wakeup: grant.wakeup,
    decide: grant.decide,
  };
}
