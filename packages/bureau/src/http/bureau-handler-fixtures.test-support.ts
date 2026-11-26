/**
 * Test-only Bureau construction shared by the handler tests and the wire goldens.
 */

import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { createMockGenerate } from '@lostgradient/operative/testing';
import { MemoryStorage } from '@lostgradient/storage';

import type { AgentDefinitions } from '../agent-catalog';
import { createMemoryAssetStorage } from '../assets/storage';
import { createBureau } from '../create-bureau.ts';
import type { WorkspaceMembershipOptions } from './workspace-principal.ts';

export const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });

export async function buildBureau(
  options: {
    id?: string;
    agents?: string[];
    persist?: boolean;
    assets?: boolean;
    durable?: boolean;
    workspace?: WorkspaceMembershipOptions;
  } = {},
) {
  const agents = Object.fromEntries(
    (options.agents ?? []).map((name) => [
      name,
      createAgent({ generate: createMockGenerate([]), name }),
    ]),
  );
  return createBureau<AgentDefinitions>({
    ...(options.id === undefined ? {} : { id: options.id }),
    agents: { ...agents, default: createAgent({ generate }) },
    ...(options.persist === true || options.durable === true
      ? { storage: new MemoryStorage() }
      : {}),
    ...(options.durable === true ? { durable: true } : {}),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    // The handler serves the asset operations, so it needs the service behind them.
    ...(options.assets === false ? {} : { assets: { storage: createMemoryAssetStorage() } }),
  });
}
