/**
 * Shared fixtures for the workflow file tests (COR-1527): a real temporary directory and a catalog
 * over it, with the host the Bureau builds. Agents are scripted; no provider key is used.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';

import type { AgentFileOperations } from '../sources/agent-file-operations.ts';
import type { WorkflowSource } from '../sources/definition-source.ts';
import { workflowFileDirectory } from '../sources/workflow-file-directory.ts';
import type { DefinitionChange } from '../definition-scanner.ts';
import { createWorkflowFileCatalog, type WorkflowFileCatalog } from '../workflow-file-catalog.ts';
import { createWorkflowDocumentHost } from '../workflow-host.ts';

/** A schedule fast enough for a test to see it fire. */
export const FAST_SCHEDULE = { kind: 'schedule', spec: '1s' } as const;

export const AGENT_STEP = {
  kind: 'activity',
  handler: 'agent',
  input: { agent: 'writer', message: 'Write the digest' },
} as const;

/** The text of a valid workflow file named `name`; `overrides` replace or add top-level keys. */
export function workflowFileText(name: string, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    { name, trigger: FAST_SCHEDULE, steps: [AGENT_STEP], ...overrides },
    null,
    2,
  )}\n`;
}

export interface WorkflowFileFixture {
  readonly directory: string;
  readonly catalog: WorkflowFileCatalog;
  /** Write a file into the directory without going through the catalog. */
  put(name: string, text: string | Uint8Array): Promise<void>;
  /** Resolves with the next change that satisfies `predicate`. */
  nextChange(predicate?: (change: DefinitionChange) => boolean): Promise<DefinitionChange>;
  dispose(): Promise<void>;
}

export interface WorkflowFileFixtureOptions {
  /** A subdirectory of the temporary root that does not exist yet, to use as the directory. */
  readonly subdirectory?: string;
  readonly codeWorkflows?: readonly string[];
  readonly watch?: boolean;
  readonly operations?: AgentFileOperations;
  /** A source to run over instead of the fixture's directory; the directory options then do nothing. */
  readonly source?: WorkflowSource;
  readonly runtime?: RuntimeServices;
  /** Where scan and watcher failures are reported. Defaults to throwing. */
  readonly diagnose?: (message: string, cause: unknown) => void;
  readonly openWatcher?: NonNullable<Parameters<typeof workflowFileDirectory>[1]>['watchFactory'];
}

export async function createWorkflowFileFixture(
  options: WorkflowFileFixtureOptions = {},
): Promise<WorkflowFileFixture> {
  const root = await mkdtemp(join(tmpdir(), 'bureau-workflow-files-'));
  const directory = options.subdirectory === undefined ? root : join(root, options.subdirectory);
  const host = createWorkflowDocumentHost({
    runAgentStep: async () => ({ content: '', output: null, finishReason: 'stop-condition' }),
  });
  const codeWorkflows = new Set(options.codeWorkflows ?? ['code-workflow']);
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const diagnose =
    options.diagnose ??
    ((message: string, cause: unknown): never => {
      throw new Error(`${message} ${String(cause)}`);
    });
  const catalog = createWorkflowFileCatalog({
    source:
      options.source ??
      workflowFileDirectory(directory, {
        runtime,
        diagnose,
        ...(options.watch === undefined ? {} : { watch: options.watch }),
        ...(options.openWatcher === undefined ? {} : { watchFactory: options.openWatcher }),
        ...(options.operations === undefined ? {} : { operations: options.operations }),
      }),
    host,
    isCodeWorkflow: (id) => codeWorkflows.has(id),
    runtime,
    diagnose,
  });
  return {
    directory,
    catalog,
    async put(name, text) {
      await writeFile(join(directory, name), text);
    },
    nextChange(predicate = () => true) {
      return new Promise((resolve) => {
        const stop = catalog.onChange((change) => {
          if (!predicate(change)) return;
          stop();
          resolve(change);
        });
      });
    },
    async dispose() {
      await catalog.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
