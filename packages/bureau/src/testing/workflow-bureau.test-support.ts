/**
 * A Bureau over a workflow directory, for the tests that run workflow files (COR-1527). Agents are
 * code-defined and scripted: `replies` maps an agent's name to what it answers, and each call
 * records the user message it was sent. No provider key is used.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgent, type GenerateContext, stopWhen } from '@lostgradient/operative';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createBureau } from '../create-bureau.ts';
import type { Bureau, BureauOptions } from '../types.ts';
import { workflowFileText } from './workflow-file-fixtures.test-support.ts';

/** What a scripted agent was sent, and by which agent. */
export interface AgentCall {
  readonly agent: string;
  readonly message: string;
}

export type Reply = (call: AgentCall) => Promise<string> | string;

export interface WorkflowBureauHarness {
  readonly directory: string;
  readonly bureau: Bureau<AgentDefinitions>;
  readonly calls: AgentCall[];
  put(name: string, text: string): Promise<void>;
  /** Write a valid workflow file for `id` and rescan. */
  putWorkflow(id: string, overrides?: Record<string, unknown>): Promise<void>;
  dispose(): Promise<void>;
}

export interface WorkflowBureauOptions {
  /** Reuse a directory (a restart over the same files). Defaults to a fresh temporary one. */
  readonly directory?: string;
  /** What each agent answers. An agent not listed answers with its own name. */
  readonly replies?: Readonly<Record<string, Reply>>;
  /** The code-defined agents. Defaults to `writer` and `editor`. */
  readonly agentNames?: readonly string[];
  readonly overrides?: Partial<BureauOptions<AgentDefinitions>>;
  readonly calls?: AgentCall[];
}

function lastUserMessage(context: GenerateContext): string {
  const message = context.conversation.getMessages().findLast((entry) => entry.role === 'user');
  return typeof message?.content === 'string' ? message.content : '';
}

export function scriptedAgents(
  names: readonly string[],
  replies: Readonly<Record<string, Reply>>,
  calls: AgentCall[],
): AgentDefinitions {
  return Object.fromEntries(
    names.map((name) => [
      name,
      createAgent({
        name,
        generate: async (context) => {
          const call = { agent: name, message: lastUserMessage(context) };
          calls.push(call);
          const reply = replies[name];
          return { content: await (reply ? reply(call) : name), toolCalls: [] };
        },
      }),
    ]),
  );
}

export async function startWorkflowBureau(
  options: WorkflowBureauOptions = {},
): Promise<WorkflowBureauHarness> {
  const ownsDirectory = options.directory === undefined;
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), 'bureau-workflow-run-')));
  const calls = options.calls ?? [];
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      ...scriptedAgents(options.agentNames ?? ['writer', 'editor'], options.replies ?? {}, calls),
      default: createAgent({ stopWhen: stopWhen.noToolCalls() }),
    },
    workflowDirectory: directory,
    storage: { type: 'memory' },
    durableExecution: true,
    ...options.overrides,
  });
  const put = async (name: string, text: string): Promise<void> => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), text);
  };
  return {
    directory,
    bureau,
    calls,
    put,
    async putWorkflow(id, overrides) {
      await put(`${id}.json`, workflowFileText(id, overrides));
      await bureau.workflows?.refresh();
    },
    async dispose() {
      await bureau.dispose();
      if (ownsDirectory) await rm(directory, { recursive: true, force: true });
    },
  };
}
