/**
 * A Bureau with a workflow directory and an agent directory, for the tests of the workflow tools
 * (COR-1529). One file agent lists the five tools; its model is scripted to make one tool call a
 * test names and to record what the tool answered. No provider key is used.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type BackendDescriptor,
  createAgent,
  type GenerateFunction,
} from '@lostgradient/operative';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createBureau } from '../create-bureau.ts';
import type { Bureau, BureauOptions } from '../types.ts';
import { WORKFLOW_TOOL_NAMES } from '../workflow-tools.ts';
import { agentFileText, KNOWN_MODEL } from './agent-file-fixtures.test-support.ts';
import { agentFileDirectory } from '../sources/agent-file-directory';
import { workflowFileDirectory } from '../sources/workflow-file-directory';
import { startTaskFrom } from '../test/task-start-request.ts';

/** Wait, by the clock and not by a count of turns, until a session run is no longer running. */
async function settledRun(bureau: Bureau<AgentDefinitions>, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const run = bureau.tasks.detail(runId);
    if (run !== undefined && run.status !== 'running') return;
    await Bun.sleep(5);
  }
  throw new Error(`Run ${runId} did not settle`);
}

export interface WorkflowToolsHarness {
  readonly bureau: Bureau<AgentDefinitions>;
  readonly workflowsPath: string;
  readonly agentsPath: string;
  /** Runs `agent` as `principal` so it makes one call to `tool` and answers what the tool returned. */
  callTool(
    tool: string,
    args: Record<string, unknown>,
    options?: {
      readonly agent?: string;
      readonly principal?: string;
      /** `session` runs the agent as a chat session run (`createRun`), as the AG-UI mount does. */
      readonly via?: 'catalog' | 'session';
    },
  ): Promise<{
    /** What the tool answered. */
    readonly result: unknown;
    /** How the run recorded the call: `success`, or an error outcome if the tool failed. */
    readonly outcome: unknown;
    readonly runId: string;
  }>;
  /** The names of the tools each model call was offered, in order. */
  readonly offered: string[][];
  /** Writes an agent file under the identifier `id` that lists `tools` (the five workflow tools by default). */
  putAgent(id: string, tools?: readonly string[]): Promise<void>;
  dispose(): Promise<void>;
}

export interface WorkflowToolsOptions {
  readonly overrides?: Partial<BureauOptions<AgentDefinitions>>;
  /** The file agents to create, by identifier. Defaults to `scribe`. */
  readonly agents?: readonly string[];
}

export async function startWorkflowToolsBureau(
  options: WorkflowToolsOptions = {},
): Promise<WorkflowToolsHarness> {
  const root = await mkdtemp(join(tmpdir(), 'bureau-workflow-tools-'));
  const workflowsPath = join(root, 'workflows');
  const agentsPath = join(root, 'agents');
  let plan: { tool: string; args: Record<string, unknown> } | undefined;
  let captured: unknown;
  const offered: string[][] = [];
  const generate: GenerateFunction = async ({ conversation, toolbox }) => {
    offered.push(
      toolbox
        .tools()
        .map((tool) => tool.name)
        .toSorted(),
    );
    const rows = conversation.getMessages();
    const answered = rows.findLast((row) => row.role === 'tool-result');
    if (answered !== undefined && rows.at(-1) === answered) {
      captured = (answered as { toolResult?: unknown }).toolResult;
      return { content: 'done', toolCalls: [] };
    }
    if (plan === undefined) return { content: 'nothing to do', toolCalls: [] };
    return {
      content: '',
      toolCalls: [{ id: 'call-1', name: plan.tool, arguments: plan.args }],
    };
  };
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      anchor: createAgent({
        name: 'anchor',
        generate: async () => ({ content: 'a', toolCalls: [] }),
      }),
    },
    agentSource: agentFileDirectory(agentsPath),
    workflowSource: workflowFileDirectory(workflowsPath),
    models: { generate: (_descriptor: BackendDescriptor) => generate },
    storage: { type: 'memory' },
    durable: true,
    ...options.overrides,
  });
  const putAgent = async (
    id: string,
    tools: readonly string[] = WORKFLOW_TOOL_NAMES,
  ): Promise<void> => {
    await writeFile(
      join(agentsPath, `${id}.md`),
      agentFileText({ name: id, model: KNOWN_MODEL, tools: `[${tools.join(', ')}]` }),
    );
    await bureau.agents.refresh();
  };
  await mkdir(agentsPath, { recursive: true });
  for (const id of options.agents ?? ['scribe']) await putAgent(id);
  await bureau.workflows?.refresh();
  return {
    bureau,
    workflowsPath,
    agentsPath,
    offered,
    putAgent,
    async callTool(tool, args, callOptions = {}) {
      plan = { tool, args };
      captured = undefined;
      let runId: string;
      if (callOptions.via === 'session') {
        const created = await startTaskFrom(bureau, {
          input: 'go',
          agentName: callOptions.agent ?? 'scribe',
          ...(callOptions.principal === undefined ? {} : { principal: callOptions.principal }),
        });
        await settledRun(bureau, created.id);
        runId = created.id;
      } else {
        const run = await bureau.tasks.start(
          callOptions.agent ?? 'scribe',
          'go',
          callOptions.principal === undefined ? {} : { principal: callOptions.principal },
        );
        await run.result();
        runId = run.id;
      }
      plan = undefined;
      const recorded = captured as { outcome?: unknown; content?: unknown } | undefined;
      return { result: recorded?.content, outcome: recorded?.outcome, runId };
    },
    async dispose() {
      await bureau.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
