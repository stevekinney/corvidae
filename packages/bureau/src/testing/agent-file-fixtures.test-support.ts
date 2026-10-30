/**
 * Shared fixtures for the agent file tests (COR-1524): a real temporary directory, a model
 * catalog, a tool catalog, and a catalog over them. Models are scripted; no provider key is used.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';
import {
  type BackendDescriptor,
  createModelCatalog,
  type GenerateFunction,
} from '@lostgradient/operative';
import type { ConditionalTextValueStore } from '@lostgradient/storage';
import { createTool } from 'armorer';
import { z } from 'zod';

import {
  type AgentCatalogChange,
  type AgentFileCatalog,
  type AgentFileCatalogOptions,
  createAgentFileCatalog,
} from '../agent-file-catalog.ts';
import type { AgentSource } from '../sources/definition-source.ts';
import { agentFileDirectory } from '../sources/agent-file-directory.ts';
import type { AgentFileOperations } from '../sources/agent-file-operations.ts';
import { createModels, type Models } from '../models/create-models.ts';

/** A model the default catalog holds, written the way an agent file names it. */
export const KNOWN_MODEL = 'anthropic/claude-opus-5-5';
/** A second model, so an update can change it. */
export const OTHER_MODEL = 'anthropic/claude-opus-5';

export const lookupTool = createTool({
  name: 'lookup-order',
  description: 'Looks an order up',
  input: z.object({}),
  // Read-only, so a file agent's default `toolApproval` (`on-changes`) lets a call run.
  metadata: { readOnly: true },
  execute: async () => 'order',
});

/** A tool that declares `metadata.shortDescription`, beside {@link lookupTool}, which does not. */
export const summarizedTool = createTool({
  name: 'summarize-order',
  description:
    'Summarizes an order for the model, in several sentences. It never changes anything.',
  input: z.object({}),
  metadata: { shortDescription: 'Summarize an order.' },
  execute: async () => 'summary',
});

export function agentFileText(
  frontmatter: Record<string, string>,
  body = 'You are helpful.\n',
): string {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

export function validAgentFile(body = 'You are helpful.\n'): string {
  return agentFileText({ name: 'Helper', model: KNOWN_MODEL }, body);
}

export interface AgentFileFixture {
  readonly directory: string;
  readonly catalog: AgentFileCatalog;
  /** The models the file catalog validates against; `replace` raises the catalog's revision. */
  readonly models: Models;
  readonly descriptors: readonly BackendDescriptor[];
  readonly generated: BackendDescriptor[];
  /** Name the summarizer model (`<provider>/<model>`), or unset it with `undefined`; call `catalog.revalidate()` after. */
  setSummarizerModel(name: string | undefined): void;
  /** Write a file into the directory without going through the catalog. */
  put(name: string, text: string | Uint8Array): Promise<void>;
  /** Resolves with the next change that satisfies `predicate`; rejects at the test's own timeout. */
  nextChange(predicate?: (change: AgentCatalogChange) => boolean): Promise<AgentCatalogChange>;
  dispose(): Promise<void>;
}

export interface AgentFileFixtureOptions {
  /**
   * An agent directory that already exists, such as the one an earlier fixture used: a restart
   * over the same files. The fixture does not remove it.
   */
  readonly directory?: string;
  /** Where the revision records live. Share one between fixtures to model one store. */
  readonly revisionStore?: ConditionalTextValueStore;
  /** The revisions of an agent that a retained run references, which saved versions keep. */
  readonly retainedRevisions?: AgentFileCatalogOptions['retainedRevisions'];
  /** Where scan, watcher, and record failures are reported. Defaults to throwing. */
  readonly diagnose?: (message: string, cause: unknown) => void;
  /** A subdirectory of the temporary root that does not exist yet, to use as the agent directory. */
  readonly subdirectory?: string;
  readonly reserved?: readonly string[];
  readonly watch?: boolean;
  /** Replaces the tool catalog, which holds {@link lookupTool} by default. */
  readonly tools?: AgentFileCatalogOptions['tools'];
  readonly operations?: AgentFileOperations;
  /** A source to run over instead of the fixture's directory; the directory options then do nothing. */
  readonly source?: AgentSource;
  readonly descriptors?: readonly BackendDescriptor[];
  /** The `context.summarizerModel` setting in force at the start. Unset by default. */
  readonly summarizerModel?: string;
  readonly runtime?: RuntimeServices;
  /** Replaces the host's resolver, to make a model that cannot be set up. */
  readonly resolveGenerate?: (descriptor: BackendDescriptor) => GenerateFunction;
  /** Replaces how a directory is watched, to observe the watchers the catalog opens. */
  readonly openWatcher?: NonNullable<Parameters<typeof agentFileDirectory>[1]>['watchFactory'];
}

export async function createAgentFileFixture(
  options: AgentFileFixtureOptions = {},
): Promise<AgentFileFixture> {
  const root = options.directory ?? (await mkdtemp(join(tmpdir(), 'bureau-agent-files-')));
  const directory = options.subdirectory === undefined ? root : join(root, options.subdirectory);
  const descriptors = options.descriptors ?? createModelCatalog().descriptors;
  let summarizerModel = options.summarizerModel;
  const models = createModels({
    options: { catalog: descriptors },
    now: () => '2026-10-18T00:00:00.000Z',
    notConfigured: () => new Error('The fixture has no generate.'),
    badRequest: (message) => {
      throw new Error(message);
    },
    onReplace: () => {},
    agents: {},
    settings: () =>
      summarizerModel === undefined ? {} : { 'context.summarizerModel': summarizerModel },
    modelPolicy: undefined,
  });
  const generated: BackendDescriptor[] = [];
  const resolveGenerate = (descriptor: BackendDescriptor): GenerateFunction => {
    generated.push(descriptor);
    return async () => ({ content: 'scripted', toolCalls: [] });
  };
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const diagnose =
    options.diagnose ??
    ((message: string, cause: unknown): never => {
      throw new Error(`${message} ${String(cause)}`);
    });
  const tools = options.tools ?? { 'lookup-order': lookupTool };
  const catalog = createAgentFileCatalog({
    source:
      options.source ??
      agentFileDirectory(directory, {
        tools,
        runtime,
        diagnose,
        ...(options.watch === undefined ? {} : { watch: options.watch }),
        ...(options.openWatcher === undefined ? {} : { watchFactory: options.openWatcher }),
        ...(options.operations === undefined ? {} : { operations: options.operations }),
      }),
    reservedIdentifiers: new Set(options.reserved ?? ['alpha']),
    tools,
    models,
    resolveGenerate: options.resolveGenerate ?? resolveGenerate,
    runtime,
    diagnose,
    ...(options.revisionStore === undefined ? {} : { revisionStore: options.revisionStore }),
    ...(options.retainedRevisions === undefined
      ? {}
      : { retainedRevisions: options.retainedRevisions }),
  });
  return {
    directory,
    catalog,
    models,
    descriptors,
    generated,
    setSummarizerModel(name) {
      summarizerModel = name;
    },
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
      if (options.directory === undefined) await rm(root, { recursive: true, force: true });
    },
  };
}
