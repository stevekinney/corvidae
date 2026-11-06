import { BUREAU_HANDLER_OPERATIONS } from './create-bureau-handler.ts';
import {
  WORKSPACE_CONFORMANCE_GROUPS,
  WORKSPACE_EXPECTED_OUTCOMES,
  WORKSPACE_MOUNT_CONFORMANCE,
} from './workspace-conformance.test-support.ts';
import {
  WORKSPACE_CROSS_PRODUCERS,
  WORKSPACE_OWNER_POSITIVE_PRODUCERS,
  WORKSPACE_PROJECTION_CONFORMANCE,
} from './workspace-projection-schema.test-support.ts';

/** Record the actor requests a witness suite actually executed and require its complete inventory. */
export function workspaceConformanceLedger(testFile: string) {
  const group = WORKSPACE_CONFORMANCE_GROUPS.find((candidate) => candidate.testFile === testFile);
  if (group === undefined) throw new Error(`No conformance inventory for ${testFile}`);
  const ledger = witnessLedger(
    testFile,
    group.operations.map(([operation]) => operation),
  );
  const outcomes = new Map<string, string[]>(
    group.operations.map(([operation, outcome]) => [
      operation,
      [...WORKSPACE_EXPECTED_OUTCOMES[outcome]],
    ]),
  );
  const actors = ['owner', 'peer', 'administrator', 'grantee', 'foreign', 'removed'] as const;
  const observations = new Map<string, { outcome: string; transport: 'jsonRpcHttp' | 'http' }>();
  const privateSources = new Map<string, string>();
  const privateProjectionActors = new Map<string, Set<string>>();
  const eventActors = new Map<string, Set<string>>();
  const eventSources = new Set<string>();
  function recordEvent(operation: string, actor: Actor) {
    const seen = eventActors.get(operation) ?? new Set<string>();
    seen.add(actor);
    eventActors.set(operation, seen);
  }
  type Actor = (typeof actors)[number];
  type Observation = {
    status: number;
    transport: 'jsonRpcHttp' | 'http';
    body?:
      { error?: { data?: { httpStatus?: number } }; result?: Record<string, unknown> } | undefined;
    text?: string;
  };
  function wireOutcome(response: Observation): string {
    const errorStatus = response.body?.error?.data?.httpStatus;
    return response.status === 403 && response.text === 'Workspace membership required'
      ? 'membership-denied'
      : response.status === 403 || errorStatus === 403
        ? 'forbidden'
        : response.status === 404 || errorStatus === 404
          ? 'not-found'
          : response.status === 200 && response.body?.error === undefined
            ? 'success'
            : `unexpected:${response.status}:${String(errorStatus)}`;
  }
  function verifyOutcome(
    operation: string,
    actor: Actor,
    actual: string,
    transport: 'jsonRpcHttp' | 'http',
  ) {
    const expected = outcomes.get(operation)?.[actors.indexOf(actor)];
    if (expected === undefined) throw new Error(`No expected outcome for ${operation}:${actor}`);
    if (actual !== expected)
      throw new Error(`Wrong outcome for ${operation}:${actor}: ${actual}, expected ${expected}`);
    const registration = BUREAU_HANDLER_OPERATIONS.find((entry) => entry.name === operation);
    if (registration?.transports[transport] !== true)
      throw new Error(`Wrong transport for ${operation}: ${transport}`);
    observations.set(JSON.stringify([operation, actor]), { outcome: actual, transport });
    ledger.record(operation, actor);
  }
  function verifyPrivateProjection(operation: string, actor: Actor, response: Observation) {
    const outcome = outcomes.get(operation)?.[actors.indexOf(actor)];
    if (
      actor === 'owner' &&
      WORKSPACE_OWNER_POSITIVE_PRODUCERS.has(operation) &&
      !response.text?.includes(group!.sentinel)
    )
      throw new Error(`Owner projection lacks the private sentinel for ${operation}`);
    if (
      (actor === 'owner' && !WORKSPACE_CROSS_PRODUCERS.has(operation)) ||
      (outcome === 'own-created' && !WORKSPACE_CROSS_PRODUCERS.has(operation)) ||
      (actor === 'grantee' &&
        group!.operations.some(
          ([name, policy]) => name === operation && policy === 'reader-grant',
        )) ||
      testFile === 'workspace-assets-privacy.test.ts'
    )
      return;
    if (response.text === undefined)
      throw new Error(`No serialized projection for ${operation}:${actor}`);
    if (response.text.includes(group!.sentinel))
      throw new Error(`Private sentinel exposed by ${operation}:${actor}`);
  }
  return {
    verify() {
      ledger.verify();
      for (const [operation, expected] of outcomes) {
        const event = WORKSPACE_PROJECTION_CONFORMANCE[`event:${operation}`];
        if (event !== undefined) {
          if (event.evidence.mode === 'cross-producer' && !eventSources.has(operation))
            throw new Error(`No private source for event ${operation}`);
          for (const actor of actors)
            if (!eventActors.get(operation)?.has(actor))
              throw new Error(`Missing event projection witness ${operation}:${actor}`);
        }
        if (WORKSPACE_CROSS_PRODUCERS.has(operation) && !privateSources.has(operation))
          throw new Error(`No owner-readable private source for ${operation}`);
        const projection = WORKSPACE_PROJECTION_CONFORMANCE[`output:${operation}`];
        if (projection?.evidence.mode === 'owner-positive' && !projection.evidence.ledgerBound) {
          for (const actor of actors)
            if (!privateProjectionActors.get(operation)?.has(actor))
              throw new Error(`Missing private projection witness ${operation}:${actor}`);
        }
        for (const [index, actor] of actors.entries()) {
          const observed = observations.get(JSON.stringify([operation, actor]));
          const registration = BUREAU_HANDLER_OPERATIONS.find((entry) => entry.name === operation);
          if (
            observed === undefined ||
            observed.outcome !== expected[index] ||
            registration?.transports[observed.transport] !== true
          )
            throw new Error(`No matching outcome and transport for ${operation}:${actor}`);
        }
      }
    },
    observePrivateProjection(
      operation: string,
      actor: Actor,
      response: { status: number; text: string },
    ) {
      const projection = WORKSPACE_PROJECTION_CONFORMANCE[`output:${operation}`];
      const expectsValue =
        actor === 'owner' ||
        (operation === 'bureau.assets.uploads.create' &&
          actor !== 'foreign' &&
          actor !== 'removed');
      if (
        projection?.evidence.mode !== 'owner-positive' ||
        projection.evidence.ledgerBound ||
        (expectsValue
          ? response.status !== 200 || !response.text.includes(projection.sentinel)
          : response.text.includes(projection.sentinel))
      )
        throw new Error(`Invalid private projection witness ${operation}:${actor}`);
      const seen = privateProjectionActors.get(operation) ?? new Set<string>();
      seen.add(actor);
      privateProjectionActors.set(operation, seen);
    },
    observePrivateIdentifier(
      operation: 'bureau.assets.get' | 'bureau.memory.forget',
      actor: Actor,
      response: Observation,
      identifier: string,
    ) {
      const expected =
        actor === 'owner' || (actor === 'grantee' && operation === 'bureau.assets.get')
          ? 'success'
          : actor === 'foreign' || actor === 'removed'
            ? 'membership-denied'
            : 'not-found';
      if (
        wireOutcome(response) !== expected ||
        (expected === 'success' &&
          (!response.text?.includes(identifier) ||
            (operation === 'bureau.assets.get' && !response.text.includes(group.sentinel))))
      )
        throw new Error(`Invalid private identifier projection for ${operation}:${actor}`);
      const seen = privateProjectionActors.get(operation) ?? new Set<string>();
      seen.add(actor);
      privateProjectionActors.set(operation, seen);
    },
    confirmPrivateSource(
      operation: string,
      response: { status: number; text: string; actor: string; operation: string },
    ) {
      const evidence = WORKSPACE_PROJECTION_CONFORMANCE[`output:${operation}`]?.evidence;
      if (
        evidence?.mode !== 'cross-producer' ||
        evidence.ownerProducer !== response.operation ||
        response.actor !== 'owner' ||
        !WORKSPACE_OWNER_POSITIVE_PRODUCERS.has(response.operation) ||
        response.status !== 200 ||
        !response.text.includes(group.sentinel)
      )
        throw new Error(`Invalid private source for ${operation}`);
      privateSources.set(operation, response.operation);
    },
    observeWire(operation: string, actor: Actor, response: Observation) {
      verifyPrivateProjection(operation, actor, response);
      verifyOutcome(operation, actor, wireOutcome(response), response.transport);
    },
    async observeStream(operation: string, actor: Actor, response: Response) {
      const text = response.status === 403 ? await response.clone().text() : undefined;
      verifyOutcome(
        operation,
        actor,
        wireOutcome({
          status: response.status,
          transport: 'http',
          ...(text === undefined ? {} : { text }),
        }),
        'http',
      );
      if (
        response.status !== 200 &&
        WORKSPACE_PROJECTION_CONFORMANCE[`event:${operation}`] !== undefined
      )
        recordEvent(operation, actor);
    },
    confirmEventPrivateSource(
      operation: string,
      response: { status: number; text: string; actor: string; operation: string },
    ) {
      const row = WORKSPACE_PROJECTION_CONFORMANCE[`event:${operation}`];
      if (
        row?.evidence.mode !== 'cross-producer' ||
        row.evidence.ownerProducer !== response.operation ||
        response.actor !== 'owner' ||
        response.status !== 200 ||
        !response.text.includes(row.sentinel)
      )
        throw new Error(`Invalid private event source for ${operation}`);
      eventSources.add(operation);
    },
    observeEventFrames(operation: string, actor: Actor, frames: unknown) {
      const row = WORKSPACE_PROJECTION_CONFORMANCE[`event:${operation}`];
      const text = JSON.stringify(frames);
      if (row?.evidence.mode === 'owner-positive') {
        if (actor !== 'owner' || !text.includes(row.sentinel))
          throw new Error(`Invalid private event for ${operation}:${actor}`);
      } else if (row?.evidence.mode === 'cross-producer') {
        if (actor !== 'administrator' || text.includes(row.sentinel))
          throw new Error(`Invalid shared event for ${operation}:${actor}`);
      } else throw new Error(`Unexpected event frames for ${operation}`);
      recordEvent(operation, actor);
    },
    observeCollection(operation: string, actor: Actor, response: Observation, target: string) {
      verifyPrivateProjection(operation, actor, response);
      const wire = wireOutcome(response);
      const actual =
        wire === 'success' ? (response.text?.includes(target) ? 'own-records' : 'empty') : wire;
      verifyOutcome(operation, actor, actual, response.transport);
    },
    observeScalar(
      operation: string,
      actor: Actor,
      response: Observation,
      field: 'updated' | 'aborted',
    ) {
      verifyPrivateProjection(operation, actor, response);
      const wire = wireOutcome(response);
      const value = response.body?.result?.[field];
      const actual = wire === 'success' ? `${field}:${String(value)}` : wire;
      verifyOutcome(operation, actor, actual, response.transport);
    },
    observeCreated(operation: string, actor: Actor, response: Observation, ownedByCaller: boolean) {
      verifyPrivateProjection(operation, actor, response);
      const wire = wireOutcome(response);
      const actual = wire === 'success' ? (ownedByCaller ? 'own-created' : 'wrong-owner') : wire;
      verifyOutcome(operation, actor, actual, response.transport);
    },
    observeAudit(operation: string, actor: Actor, response: Observation, privateResource: string) {
      verifyPrivateProjection(operation, actor, response);
      const wire = wireOutcome(response);
      const records = response.body?.result?.['records'];
      const actual =
        wire !== 'success'
          ? wire
          : response.text?.includes(privateResource)
            ? 'own-records'
            : Array.isArray(records) && records.length > 0
              ? 'configuration-metadata-only'
              : 'empty';
      verifyOutcome(operation, actor, actual, response.transport);
      const seen = privateProjectionActors.get(operation) ?? new Set<string>();
      seen.add(actor);
      privateProjectionActors.set(operation, seen);
    },
  };
}

/** Record six-actor requests to each mounted transport assigned to this suite. */
export function workspaceMountLedger(testFile: string) {
  const entries = Object.values(WORKSPACE_MOUNT_CONFORMANCE).filter(
    (entry) => entry.testFile === testFile,
  );
  if (entries.length === 0) throw new Error(`No mount inventory for ${testFile}`);
  const ledger = witnessLedger(
    testFile,
    entries.map((entry) => entry.key),
  );
  const actors = ['owner', 'peer', 'administrator', 'grantee', 'foreign', 'removed'] as const;
  type Actor = (typeof actors)[number];
  const observations = new Map<string, { outcome: string; transport: 'http' }>();
  function verifyOutcome(key: string, actor: Actor, actual: string) {
    const entry = entries.find((candidate) => candidate.key === key);
    const projection = WORKSPACE_PROJECTION_CONFORMANCE[`mount:${key}`];
    if (
      entry === undefined ||
      projection === undefined ||
      projection.sentinel !== entry.sentinel ||
      (key === WORKSPACE_MOUNT_CONFORMANCE.contributed.key
        ? projection.evidence.mode !== 'schema-safe'
        : projection.evidence.mode !== 'owner-positive')
    )
      throw new Error(`Unbound mount projection for ${key}`);
    const expected =
      entry === undefined
        ? undefined
        : WORKSPACE_EXPECTED_OUTCOMES[entry.outcome][actors.indexOf(actor)];
    if (actual !== expected || !entry?.transports.includes('http'))
      throw new Error(
        `Wrong mount outcome for ${key}:${actor}: ${actual}, expected ${String(expected)}`,
      );
    observations.set(JSON.stringify([key, actor]), { outcome: actual, transport: 'http' });
    ledger.record(key, actor);
  }
  function refusal(status: number, text?: string) {
    if (status === 403)
      return text === 'Workspace membership required' ? 'membership-denied' : 'forbidden';
    if (status === 404) return 'not-found';
    return undefined;
  }
  return {
    verify() {
      ledger.verify();
      for (const entry of entries)
        for (const [index, actor] of actors.entries()) {
          const actual = observations.get(JSON.stringify([entry.key, actor]));
          if (
            actual === undefined ||
            actual.outcome !== WORKSPACE_EXPECTED_OUTCOMES[entry.outcome][index] ||
            actual.transport !== 'http'
          )
            throw new Error(`No matching mount outcome for ${entry.key}:${actor}`);
        }
    },
    async observeHttp(key: string, actor: Actor, response: Response, expectedBytes?: Uint8Array) {
      const text = response.status === 403 ? await response.clone().text() : undefined;
      if (key === WORKSPACE_MOUNT_CONFORMANCE.assets.key && response.status === 200) {
        if (
          expectedBytes === undefined ||
          !Buffer.from(await response.clone().arrayBuffer()).equals(Buffer.from(expectedBytes))
        )
          throw new Error(`Asset mount bytes differ for ${actor}`);
      }
      if (key === WORKSPACE_MOUNT_CONFORMANCE.contributed.key) {
        const body = await response.clone().text();
        if (
          (response.status === 200) !==
          (body === WORKSPACE_MOUNT_CONFORMANCE.contributed.sentinel)
        )
          throw new Error(`Contributed mount projection differs for ${actor}`);
      }
      verifyOutcome(
        key,
        actor,
        refusal(response.status, text) ??
          (response.status === 200 ? 'success' : `unexpected:${response.status}`),
      );
    },
    async observeAgUi(key: string, actor: Actor, response: Response, frames: unknown) {
      const text = JSON.stringify(frames);
      const admission = response.status === 403 ? await response.clone().text() : undefined;
      const actual =
        refusal(response.status, admission) ??
        (response.status !== 200
          ? `unexpected:${response.status}`
          : /RUN_NOT_FOUND|THREAD_NOT_FOUND/.test(text)
            ? 'not-found'
            : text.includes(WORKSPACE_MOUNT_CONFORMANCE.agUi.sentinel)
              ? 'success'
              : 'missing-private-frame');
      if (actor !== 'owner' && text.includes(WORKSPACE_MOUNT_CONFORMANCE.agUi.sentinel))
        throw new Error(`AG-UI exposed private content to ${actor}`);
      verifyOutcome(key, actor, actual);
    },
    observeA2a(
      key: string,
      actor: Actor,
      result: { status: number; text: string; body?: { error?: { code: number } } | undefined },
    ) {
      const actual =
        refusal(result.status, result.text) ??
        (result.body?.error?.code === -32001
          ? 'not-found'
          : result.status === 200 && result.body?.error === undefined
            ? 'success'
            : 'unexpected-a2a');
      if ((actor === 'owner') !== result.text.includes(WORKSPACE_MOUNT_CONFORMANCE.a2a.sentinel))
        throw new Error(`A2A private projection differs for ${actor}`);
      verifyOutcome(key, actor, actual);
    },
    async observeMcp(
      key: string,
      actor: Actor,
      input: {
        response?: Response;
        result?: { isError?: boolean | undefined; structuredContent?: unknown };
      },
    ) {
      const content = input.result?.structuredContent;
      const code =
        typeof content === 'object' && content !== null ? Reflect.get(content, 'code') : undefined;
      const text = input.response?.status === 403 ? await input.response.clone().text() : undefined;
      const actual =
        input.response === undefined
          ? input.result?.isError === true && code === 'NotFound'
            ? 'not-found'
            : input.result?.isError !== true
              ? 'success'
              : 'unexpected-mcp'
          : (refusal(input.response.status, text) ?? `unexpected:${input.response.status}`);
      const serialized = JSON.stringify(input.result ?? {});
      if ((actor === 'owner') !== serialized.includes(WORKSPACE_MOUNT_CONFORMANCE.mcp.sentinel))
        throw new Error(`MCP private projection differs for ${actor}`);
      verifyOutcome(key, actor, actual);
    },
  };
}

/** Compare actual WebSocket frames and rejected upgrades to every live WebSocket operation. */
export function workspaceWebSocketLedger() {
  const registrations = BUREAU_HANDLER_OPERATIONS.filter(
    (entry) => entry.transports.jsonRpcWebSocket,
  );
  const ledger = witnessLedger(
    'WebSocket operations',
    registrations.map((entry) => entry.name),
  );
  const actors = ['owner', 'peer', 'administrator', 'grantee', 'foreign', 'removed'] as const;
  type Actor = (typeof actors)[number];
  function record(operation: string, actor: Actor, actual: string) {
    const row = WORKSPACE_CONFORMANCE_GROUPS.map((group) =>
      group.operations.find(([name]) => name === operation),
    ).find((entry) => entry !== undefined);
    const expected =
      row === undefined ? undefined : WORKSPACE_EXPECTED_OUTCOMES[row[1]][actors.indexOf(actor)];
    if (!registrations.some((entry) => entry.name === operation) || actual !== expected)
      throw new Error(
        `Wrong WebSocket outcome for ${operation}:${actor}: ${actual}, expected ${String(expected)}`,
      );
    ledger.record(operation, actor);
  }
  return {
    verify: ledger.verify,
    rejectedUpgrade(actor: Actor, accepted: boolean, response: { status: number; text: string }) {
      if (accepted || response.status !== 403 || response.text !== 'Workspace membership required')
        throw new Error(`The ${actor} WebSocket upgrade was not rejected at membership`);
      for (const entry of registrations) record(entry.name, actor, 'membership-denied');
    },
    observe(
      operation: string,
      actor: Actor,
      frame: { error?: { data?: { httpStatus?: number } } },
    ) {
      const status = frame.error?.data?.httpStatus;
      const actual =
        status === 403
          ? 'forbidden'
          : status === 404
            ? 'not-found'
            : frame.error === undefined
              ? 'success'
              : `unexpected:${String(status)}`;
      record(operation, actor, actual);
    },
  };
}

function witnessLedger(testFile: string, keys: readonly string[]) {
  const expected = new Set<string>(keys);
  const actors = ['owner', 'peer', 'administrator', 'grantee', 'foreign', 'removed'] as const;
  const observed = new Map<string, Set<string>>();
  return {
    record(operation: string, actor: (typeof actors)[number]) {
      if (!expected.has(operation))
        throw new Error(`Unexpected conformance operation ${operation}`);
      const seen = observed.get(operation) ?? new Set<string>();
      seen.add(actor);
      observed.set(operation, seen);
    },
    verify() {
      const missing = [...expected].flatMap((operation) =>
        actors
          .filter((actor) => !observed.get(operation)?.has(actor))
          .map((actor) => `${operation}:${actor}`),
      );
      if (missing.length > 0)
        throw new Error(`Missing conformance witnesses in ${testFile}: ${missing.join(', ')}`);
    },
  };
}
