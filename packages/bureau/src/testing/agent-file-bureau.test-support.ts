/**
 * A Bureau over an agent directory, for the tests that run file agents (COR-1524). Models are
 * scripted: `scripts` maps a model name to the generate it resolves to, and each generate records
 * what it was offered.
 */
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgent,
  type BackendDescriptor,
  type GenerateFunction,
  type TokenUsage,
} from '@lostgradient/operative';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createBureau } from '../create-bureau.ts';
import type { Bureau, BureauOptions } from '../types.ts';
import { lookupTool } from './agent-file-fixtures.test-support.ts';
import { createMemoryAssetStorage } from '../assets/storage';
import { agentFileDirectory } from '../sources/agent-file-directory';
import { MemoryStorage } from '@lostgradient/storage';

/** What a scripted generate saw on one call. */
export interface Observation {
  readonly model: string;
  readonly tools: readonly string[];
  readonly systemPrompt: string | undefined;
}

/**
 * What a scripted generate answers: its text, or the text with the token usage the provider
 * reported and the tool calls it asked for (COR-1914), so a test can spend money and take steps.
 */
export type ScriptedReply =
  | string
  | {
      readonly content: string;
      readonly usage?: TokenUsage;
      readonly toolCalls?: readonly { readonly name: string; readonly arguments: object }[];
    };

export type Script = (observation: Observation) => Promise<ScriptedReply> | ScriptedReply;

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
  /**
   * The reasoning each model's generate puts before its answer, as a `thinking` part (a model
   * with no entry returns none). The answer is still `scripts`'.
   */
  readonly thinking?: Readonly<Record<string, string>>;
  readonly overrides?: Partial<BureauOptions<AgentDefinitions>>;
  readonly observed?: Observation[];
  readonly agents?: AgentDefinitions;
}

function generateFor(
  descriptor: BackendDescriptor,
  scripts: Readonly<Record<string, Script>>,
  observed: Observation[],
  thinking: Readonly<Record<string, string>>,
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
    const reply = await (script ? script(observation) : descriptor.model);
    const content = typeof reply === 'string' ? reply : reply.content;
    const thought = thinking[descriptor.model];
    return {
      content,
      toolCalls:
        typeof reply === 'string'
          ? []
          : [...(reply.toolCalls ?? [])].map((call) => ({
              name: call.name,
              arguments: call.arguments,
            })),
      ...(typeof reply === 'string' || reply.usage === undefined ? {} : { usage: reply.usage }),
      ...(thought === undefined
        ? {}
        : {
            parts: [
              { type: 'thinking' as const, thinking: thought, signature: 'scripted-signature' },
              { type: 'text' as const, text: content },
            ],
          }),
    };
  };
}

export async function startFileBureau(options: FileBureauOptions = {}): Promise<FileBureauHarness> {
  const ownsDirectory = options.directory === undefined;
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), 'bureau-agent-run-')));
  const observed = options.observed ?? [];
  const scripts = options.scripts ?? {};
  const thinking = options.thinking ?? {};
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      ...(options.agents ?? {
        alpha: createAgent({
          generate: async () => ({ content: 'alpha', toolCalls: [] }),
          name: 'alpha',
        }),
      }),
    },
    agentSource: agentFileDirectory(directory, { tools: { 'lookup-order': lookupTool } }),
    storage: new MemoryStorage(),
    durable: true,
    // A handler over this Bureau serves the asset operations, so the Bureau has the service.
    assets: { storage: createMemoryAssetStorage() },
    ...options.overrides,
    // Merged, so an override of the catalog or of the generate keeps the other.
    models: {
      generate: (descriptor) => generateFor(descriptor, scripts, observed, thinking),
      ...options.overrides?.models,
    },
  });
  return {
    directory,
    bureau,
    observed,
    // Written beside the file and renamed into place, as the Bureau's own writer does: the watcher
    // scans on its own, and a file read half-written is a different content with a revision of its
    // own, which a test that counts revisions cannot tell from an edit.
    async put(name, text) {
      const temporary = join(directory, `.${crypto.randomUUID()}.tmp`);
      await writeFile(temporary, text);
      await rename(temporary, join(directory, name));
    },
    async dispose() {
      await bureau.dispose();
      if (ownsDirectory) await rm(directory, { recursive: true, force: true });
    },
  };
}
