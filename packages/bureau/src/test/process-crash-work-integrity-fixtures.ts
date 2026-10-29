/**
 * COR-1391 — the configuration the work-integrity crash scenarios share.
 *
 * The child (`process-crash-child.ts`) and the parent test
 * (`process-crash-work-integrity.test.ts`) must build the same durable Bureau,
 * the same idempotent toolbox and the same governed memory over the same
 * sidecar files, or a recovery would not be a recovery of the child's work.
 * Both import this module so there is one definition of each.
 *
 * Sidecar stores live next to the marker file, in the scenario directory.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createGovernedMemory,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
  createWeftMemoryRecordStorage,
  type GovernedMemory,
} from '@lostgradient/memory';
import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { resolveStorage } from '@lostgradient/weft';
import { type Storage, textValueStore } from '@lostgradient/storage';
import {
  type AnyToolbox,
  createTool,
  createToolbox,
  createToolResultCache,
  type ToolRequestContext,
  type ToolResultCache,
  withToolboxIdempotency,
} from 'armorer';
import { z } from 'zod';

import { createBureau } from '../create-bureau';
import type { Bureau } from '../types';
import type { AgentDefinitions } from '../agent-catalog';

/** The claim TTL the parent derives its single claim-lapse wait from. */
export const CLAIM_TTL_MS = 200;
export const CLAIM_RENEW_MS = 50;

export const TENANT_ID = 'process-crash-harness';
export const OWNER_ID = 'process-crash-owner';
export const SESSION_ID = 'process-crash-session';
export const CHARGE_ORDER_ID = 'order-1';
export const REMEMBERED_ANSWER = 'the remembered answer';
export const HUMAN_WAIT_SIGNAL = 'human-response';
export const HUMAN_WAIT_PROMPT = 'Approve the crashed run?';
/** The second signal of COR-1578's two-call park step, which the first request's park refuses. */
export const SECOND_HUMAN_WAIT_SIGNAL = 'human-response-second';
export const SECOND_HUMAN_WAIT_PROMPT = 'Approve the second request?';

export type Backend = 'sqlite' | 'lmdb';

export function requestContext(): ToolRequestContext {
  return {
    authority: {
      principalId: 'api-key:alice',
      tenantId: TENANT_ID,
      ownerId: OWNER_ID,
      capabilities: ['tools:execute'],
      authorizationRevision: 'gateway:1',
    },
  };
}

/**
 * An inspector authority that can list the run-written records. A run's memory is partitioned by
 * the Bureau's identifier (`TENANT_ID`, the `id` every process of the harness shares) and the run's
 * owner of record, which is the `principal` its scenario names (COR-1546).
 */
export function inspectorFor(ownerId: string) {
  return createMemoryAuthority({
    principal: { kind: 'governance', id: 'governance:auditor' },
    tenantId: TENANT_ID,
    ownerId,
    purpose: 'audit',
    capabilities: ['memory:get', 'memory:list', 'memory:inspect'],
    policyRevision: 'gateway:1',
    projection: 'audit',
  });
}

export const inspector = inspectorFor('alice');

export function effectsLogPath(directory: string): string {
  return join(directory, 'effects.log');
}

export function readEffects(directory: string): string[] {
  const path = effectsLogPath(directory);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

/** Opens the idempotency cache over its own sidecar SQLite file. */
export async function openIdempotencyCache(directory: string) {
  const store = textValueStore(
    await resolveStorage({ type: 'sqlite', path: join(directory, 'idempotency.sqlite') }),
  );
  return { cache: createToolResultCache({ store }), store, close: () => store.close() };
}

type KeyLister = { list(prefix: string): Promise<string[]> };

/**
 * Reads the state of the `charge` entry. The cache key embeds a tool revision
 * the harness has no reason to reproduce, so this scans the (single-tenant)
 * store instead.
 */
export async function chargeStatus(
  store: KeyLister,
  cache: ToolResultCache,
): Promise<'started' | 'completed' | undefined> {
  for (const key of await store.list('')) {
    const entry = await cache.getState(key);
    if (entry !== undefined && entry.toolName === 'charge') {
      return entry.status === 'started' ? 'started' : 'completed';
    }
  }
  return undefined;
}

export function createChargeTool(directory: string) {
  return createTool({
    name: 'charge',
    description: 'charge an order',
    input: z.object({ orderId: z.string() }),
    idempotencyKey: (input: unknown) => (input as { orderId: string }).orderId,
    execute: async (input: { orderId: string }) => {
      appendFileSync(effectsLogPath(directory), `charged ${input.orderId}\n`, 'utf8');
      return `charged:${input.orderId}`;
    },
  });
}

/** Wraps the toolbox with the shared cache; `wrap: false` is the control. */
export function createChargeToolbox(
  directory: string,
  crashExecute: () => Promise<string>,
  options: { cache: ToolResultCache; wrap: boolean },
) {
  const crash = createTool({
    name: 'crash',
    description: 'the kill point',
    input: z.object({}),
    execute: crashExecute,
  });
  const toolbox = createToolbox([createChargeTool(directory), crash]);
  return options.wrap
    ? withToolboxIdempotency(toolbox, { cache: options.cache, tenantId: TENANT_ID })
    : toolbox;
}

export const chargeToolCalls = [
  { name: 'charge', arguments: { orderId: CHARGE_ORDER_ID } },
  { name: 'crash', arguments: {} },
];

export interface GovernedMemoryFixture {
  readonly memory: GovernedMemory;
  readonly close: () => void;
}

/** Governed memory over two sidecar SQLite files; `wrapMemoryStorage` intercepts record writes. */
export async function openGovernedMemory(
  directory: string,
  wrapMemoryStorage: (storage: Storage) => Storage = (storage) => storage,
): Promise<GovernedMemoryFixture> {
  const memoryStorage = await resolveStorage({
    type: 'sqlite',
    path: join(directory, 'memory.sqlite'),
  });
  const ledgerStorage = await resolveStorage({
    type: 'sqlite',
    path: join(directory, 'ledger.sqlite'),
  });
  const memory = createGovernedMemory({
    storage: createWeftMemoryRecordStorage(wrapMemoryStorage(memoryStorage)),
    ledger: createMemoryGovernanceLedger(ledgerStorage),
    embedder: createMockEmbedder(64),
    policy: createMemoryGovernancePolicy({ revision: 'governance:process-crash' }),
  });
  return {
    memory,
    close: () => {
      memoryStorage[Symbol.dispose]();
      ledgerStorage[Symbol.dispose]();
    },
  };
}

export function firstUserMessage(context: Parameters<GenerateFunction>[0]): string {
  const message = context.conversation.getMessages().find((entry) => entry.role === 'user');
  return typeof message?.content === 'string' ? message.content : '';
}

export interface HarnessBureauOptions {
  readonly backend: Backend;
  readonly storagePath: string;
  readonly generate: GenerateFunction;
  readonly toolbox: AnyToolbox;
  readonly memory?: GovernedMemory;
  /** Wires `requestHumanInput` into the run (the COR-1409 park scenario). */
}

/** The durable, `workflow-lease` Bureau every child and the recoverer share. */
export function createHarnessBureau(options: HarnessBureauOptions): Promise<Bureau> {
  return createBureau<AgentDefinitions>({
    // The identifier is the memory tenant, so every process of a scenario must share it.
    id: TENANT_ID,
    agents: {
      default: createAgent({
        generate: options.generate,
        toolbox: options.toolbox,
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: { type: options.backend, path: options.storagePath },
    durable: true,
    requestAuthorityValidator: () => true,
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    durableOwnership: {
      ownership: 'workflow-lease',
      workflowClaimTtlMs: CLAIM_TTL_MS,
      workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
    },
  });
}

/** COR-1717: the secret every process of the interrupted-approval scenario signs approvals under. */
export const INTERRUPTED_APPROVAL_SECRET = 'interrupted-approval-secret';
/** The file the interrupted-approval tool appends one line to each time its body runs. */
export const INTERRUPTED_APPROVAL_FILE = 'approved-tool-runs.txt';

/**
 * COR-1717: a toolbox whose one tool needs approval and, when it runs, appends a line to a file
 * under `directory` (then calls `afterAppend`, which the crashing child uses to die mid-tool).
 */
export function createInterruptedApprovalToolbox(
  directory: string,
  afterAppend: () => void = () => {},
): AnyToolbox {
  return createToolbox(
    [
      createTool({
        name: 'append-line',
        version: '1.0.0',
        description: 'Append one line to the scenario file',
        input: z.object({}),
        async execute() {
          appendFileSync(join(directory, INTERRUPTED_APPROVAL_FILE), 'ran\n', 'utf8');
          afterAppend();
          return 'appended';
        },
      }),
    ],
    {
      approvalSecret: INTERRUPTED_APPROVAL_SECRET,
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'needs_approval',
            reason: 'Operator approval required',
            action: { message: 'Approve append' },
          };
        },
      },
    },
  );
}
