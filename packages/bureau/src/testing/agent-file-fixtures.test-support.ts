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
import { createTool } from 'armorer';
import { z } from 'zod';

import {
  type AgentCatalogChange,
  type AgentFileCatalog,
  createAgentFileCatalog,
} from '../agent-file-catalog.ts';
import type { AgentFileOperations } from '../agent-file-operations.ts';
import { createModelCatalogService } from '../model-catalog-refresh.ts';

/** A model the default catalog holds, written the way an agent file names it. */
export const KNOWN_MODEL = 'anthropic/claude-opus-5-5';
/** A second model, so an update can change it. */
export const OTHER_MODEL = 'anthropic/claude-opus-5';

export const lookupTool = createTool({
  name: 'lookup-order',
  description: 'Looks an order up',
  input: z.object({}),
  execute: async () => 'order',
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
  readonly descriptors: readonly BackendDescriptor[];
  readonly generated: BackendDescriptor[];
  /** Write a file into the directory without going through the catalog. */
  put(name: string, text: string | Uint8Array): Promise<void>;
  /** Resolves with the next change that satisfies `predicate`; rejects at the test's own timeout. */
  nextChange(predicate?: (change: AgentCatalogChange) => boolean): Promise<AgentCatalogChange>;
  dispose(): Promise<void>;
}

export interface AgentFileFixtureOptions {
  /** A subdirectory of the temporary root that does not exist yet, to use as the agent directory. */
  readonly subdirectory?: string;
  readonly reserved?: readonly string[];
  readonly watch?: boolean;
  readonly operations?: AgentFileOperations;
  readonly descriptors?: readonly BackendDescriptor[];
  readonly runtime?: RuntimeServices;
}

export async function createAgentFileFixture(
  options: AgentFileFixtureOptions = {},
): Promise<AgentFileFixture> {
  const root = await mkdtemp(join(tmpdir(), 'bureau-agent-files-'));
  const directory = options.subdirectory === undefined ? root : join(root, options.subdirectory);
  const descriptors = options.descriptors ?? createModelCatalog().descriptors;
  const modelCatalog = createModelCatalogService({
    seed: { ...createModelCatalog(), descriptors },
    descriptorSource: () => Promise.resolve(descriptors),
    now: () => '2026-10-18T00:00:00.000Z',
    newRefreshId: () => 'refresh',
  });
  const generated: BackendDescriptor[] = [];
  const resolveGenerate = (descriptor: BackendDescriptor): GenerateFunction => {
    generated.push(descriptor);
    return async () => ({ content: 'scripted', toolCalls: [] });
  };
  const catalog = createAgentFileCatalog({
    directory,
    reservedIdentifiers: new Set(options.reserved ?? ['alpha']),
    tools: { 'lookup-order': lookupTool },
    modelCatalog,
    resolveGenerate,
    runtime: options.runtime ?? createDefaultRuntimeServices(),
    diagnose: (message, cause) => {
      throw new Error(`${message} ${String(cause)}`);
    },
    ...(options.watch === undefined ? {} : { watch: options.watch }),
    ...(options.operations === undefined ? {} : { operations: options.operations }),
  });
  return {
    directory,
    catalog,
    descriptors,
    generated,
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
