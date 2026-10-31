/**
 * COR-1703. Every operation `createBureauHandler` serves has a row in the operation map, and every
 * row names an operation that is served and, unless exempt, a member a Bureau has.
 *
 * The served operations are read from the handler's own registry, `BUREAU_HANDLER_OPERATIONS`, so
 * an operation added there with no row fails this file without anyone editing it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createGovernedMemory,
  createInMemoryMemoryRecordStorage,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
  createMemoryVectorStore,
  createTestEmbedders,
} from '@lostgradient/memory';
import { createAgent } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { WorkerDeploymentCatalog } from '@lostgradient/weft';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createMemoryAssetStorage } from '../assets/storage';
import { createBureau } from '../create-bureau.ts';
import { workflowFileDirectory } from '../sources/workflow-file-directory';
import type { Bureau } from '../types.ts';
import { BUREAU_HANDLER_OPERATIONS } from './create-bureau-handler.ts';
import { OPERATION_MAP, type OperationBinding } from './operation-map.ts';

/**
 * A Bureau with every optional namespace a row can name: durable storage (the audit trail and the
 * task registry), assets, governed memory, workflow files, worker deployments, hooks, and goals.
 */
async function openFullBureau(): Promise<{ bureau: Bureau; dispose: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-operation-map-'));
  const durable = new MemoryStorage();
  const bureau = await createBureau<AgentDefinitions>({
    id: 'operation-map-bureau',
    agents: { default: createAgent({ generate: async () => ({ content: 'ok', toolCalls: [] }) }) },
    storage: new MemoryStorage(),
    durable: true,
    assets: { storage: createMemoryAssetStorage() },
    workflowSource: workflowFileDirectory(directory),
    workerDeployments: new WorkerDeploymentCatalog(new MemoryStorage()),
    hooks: {},
    memory: createGovernedMemory({
      storage: createInMemoryMemoryRecordStorage(),
      ledger: createMemoryGovernanceLedger(durable),
      ...createTestEmbedders(createMockEmbedder(64), 64),
      vectors: createMemoryVectorStore(durable),
      policy: createMemoryGovernancePolicy({ revision: 'governance:operation-map' }),
    }),
  });
  return {
    bureau,
    dispose: async () => {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** What is wrong with a map, as sentences a failing run prints. */
function problemsWith(
  served: readonly string[],
  map: Readonly<Record<string, OperationBinding>>,
  bureau: unknown,
): string[] {
  const problems: string[] = [];
  for (const name of served) {
    if (!(name in map)) problems.push(`${name} is served but has no row in the operation map`);
  }
  for (const [name, binding] of Object.entries(map)) {
    if (!served.includes(name)) problems.push(`${name} has a row but is not served`);
    if ('exempt' in binding) {
      if (binding.exempt.trim() === '') problems.push(`${name} is exempt without a reason`);
      continue;
    }
    if (!hasMember(bureau, binding.member)) {
      problems.push(`${name} names ${binding.member}, which a Bureau does not have`);
    }
  }
  return problems;
}

/** Whether `path` (dotted) leads to a defined member of `root`. */
function hasMember(root: unknown, path: string): boolean {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' && typeof current !== 'function') return false;
    if (current === null) return false;
    current = Reflect.get(current, segment);
    if (current === undefined) return false;
  }
  return true;
}

describe('the operation map', () => {
  let opened: Awaited<ReturnType<typeof openFullBureau>>;

  beforeAll(async () => {
    opened = await openFullBureau();
  });

  afterAll(async () => {
    await opened.dispose();
  });

  const served = BUREAU_HANDLER_OPERATIONS.map((operation) => operation.name);

  it('covers every served operation, names no operation that is not served, and names real members', () => {
    expect(problemsWith(served, OPERATION_MAP, opened.bureau)).toEqual([]);
  });

  it('fails on a served operation that has no row', () => {
    const { 'bureau.reviews.list': _removed, ...withoutReviewsList } = OPERATION_MAP;
    expect(problemsWith(served, withoutReviewsList, opened.bureau)).toEqual([
      'bureau.reviews.list is served but has no row in the operation map',
    ]);
  });

  it('fails on a row whose operation is not served', () => {
    const extra: Record<string, OperationBinding> = {
      ...OPERATION_MAP,
      'bureau.reviews.retire': { member: 'reviews.resolve' },
    };
    expect(problemsWith(served, extra, opened.bureau)).toEqual([
      'bureau.reviews.retire has a row but is not served',
    ]);
  });

  it('fails on a row that names a member a Bureau does not have', () => {
    const renamed = {
      ...OPERATION_MAP,
      'bureau.reviews.resolve': { member: 'reviews.decide' },
    } as unknown as Record<string, OperationBinding>;
    expect(problemsWith(served, renamed, opened.bureau)).toEqual([
      'bureau.reviews.resolve names reviews.decide, which a Bureau does not have',
    ]);
  });

  it('fails on an exempt row with no reason', () => {
    const bare = { ...OPERATION_MAP, 'bureau.events': { exempt: ' ' } };
    expect(problemsWith(served, bare, opened.bureau)).toEqual([
      'bureau.events is exempt without a reason',
    ]);
  });
});
