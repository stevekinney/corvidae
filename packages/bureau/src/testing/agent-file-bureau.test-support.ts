/**
 * A Bureau over an agent directory, for the tests that run file agents (COR-1524). Models are
 * scripted: `scripts` maps a model name to the generate it resolves to, and each generate records
 * what it was offered.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgent,
  type BackendDescriptor,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createBureau } from '../create-bureau.ts';
import type { Bureau, BureauOptions } from '../types.ts';
import { lookupTool } from './agent-file-fixtures.test-support.ts';

/** What a scripted generate saw on one call. */
export interface Observation {
  readonly model: string;
  readonly tools: readonly string[];
  readonly systemPrompt: string | undefined;
}

export type Script = (observation: Observation) => Promise<string> | string;

export interface FileBureauHarness {
  readonly directory: string;
  readonly bureau: Bureau<AgentDefinitions>;
  readonly observed: Observation[];
  put(name: string, text: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface FileBureauOptions {
  /** Reuse a directory (a restart over the same files). Defaults to a fresh temporary one. */
  readonly directory?: string;
  /** What each model's generate answers. Defaults to the model's own name. */
  readonly scripts?: Readonly<Record<string, Script>>;
  readonly overrides?: Partial<BureauOptions<AgentDefinitions>>;
  readonly observed?: Observation[];
  readonly agents?: AgentDefinitions;
}

function generateFor(
  descriptor: BackendDescriptor,
  scripts: Readonly<Record<string, Script>>,
  observed: Observation[],
): GenerateFunction {
  return async ({ toolbox, conversation }) => {
    const system = conversation.getFirstSystemMessage()?.content;
    const observation: Observation = {
      model: descriptor.model,
      tools: toolbox
        .tools()
        .map((tool) => tool.name)
        .toSorted(),
      systemPrompt: typeof system === 'string' ? system : undefined,
    };
    observed.push(observation);
    const script = scripts[descriptor.model];
    return { content: await (script ? script(observation) : descriptor.model), toolCalls: [] };
  };
}

export async function startFileBureau(options: FileBureauOptions = {}): Promise<FileBureauHarness> {
  const ownsDirectory = options.directory === undefined;
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), 'bureau-agent-run-')));
  const observed = options.observed ?? [];
  const scripts = options.scripts ?? {};
  const bureau = await createBureau<AgentDefinitions>({
    agents: options.agents ?? {
      alpha: createAgent({
        generate: async () => ({ content: 'alpha', toolCalls: [] }),
        name: 'alpha',
      }),
    },
    agentDirectory: directory,
    agentTools: { 'lookup-order': lookupTool },
    resolveAgentGenerate: (descriptor) => generateFor(descriptor, scripts, observed),
    stopWhen: stopWhen.noToolCalls(),
    storage: { type: 'memory' },
    durableExecution: true,
    ...options.overrides,
  });
  return {
    directory,
    bureau,
    observed,
    put: (name, text) => writeFile(join(directory, name), text),
    async dispose() {
      await bureau.dispose();
      if (ownsDirectory) await rm(directory, { recursive: true, force: true });
    },
  };
}
