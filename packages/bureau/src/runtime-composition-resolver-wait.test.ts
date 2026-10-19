/**
 * COR-1586 — a composition built with `awaitsCatalogAgentRunOptionsResolver` holds every reader of
 * the catalog agent run options resolver while it is unset, and settles them when the resolver is
 * wired or abandoned. A composition built without it answers at once, as it always did.
 */
import { type RunOptions } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createRuntimeComposition } from './runtime-composition';
import type { BureauDiagnostic } from './types';

function fakeRunOptions(): RunOptions {
  return {
    generate: async () => ({ content: 'x', toolCalls: [] }),
    toolbox: createToolbox([], { context: {} }),
    conversation: createConversationHistory({ id: 'catalog-recovered' }),
  };
}

async function compositionWith(
  awaitsResolver: boolean,
  diagnostics: BureauDiagnostic[] = [],
): ReturnType<typeof createRuntimeComposition> {
  const runtime = await createRuntimeComposition(
    {
      storage: { type: 'memory' },
      durableExecution: true,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
    awaitsResolver ? { awaitsCatalogAgentRunOptionsResolver: true } : {},
  );
  await runtime.persistCatalogRunRecoveryRecord('catalog-run', {
    agentName: 'echo',
    definitionRevision: 1,
    input: 'hello',
  });
  return runtime;
}

const catalogRunInfo = {
  workflowId: 'catalog-run',
  workflowType: 'agentRun',
  input: { runId: 'catalog-run', sessionId: 'catalog-run', agentName: 'echo' },
} as const;

/** Whether `promise` has settled, after the microtasks and one macrotask a wait would need. */
async function settledWithin(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(resolve, 20, marker)),
  ]);
  return winner !== marker;
}

describe('a composition that was not told a resolver is coming (COR-1586)', () => {
  it('answers unavailable at once, for a catalog run and for a session run', async () => {
    const diagnostics: BureauDiagnostic[] = [];
    const runtime = await compositionWith(false, diagnostics);
    try {
      expect(await runtime.resolveRunServices(catalogRunInfo)).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('no catalog agent recovery resolver is configured'),
      });
      expect(await runtime.resolveSessionAgentRun('echo', 'run-1')).toMatchObject({
        status: 'resolver-failed',
      });
      expect(diagnostics.filter((entry) => entry.level === 'warn')).toEqual([]);

      // Without the flag, abandoning is a no-op: the answer still names the missing resolver, not
      // an abandonment reason.
      runtime.abandonCatalogAgentRunOptionsResolver('construction failed');
      expect(await runtime.resolveRunServices(catalogRunInfo)).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('no catalog agent recovery resolver is configured'),
      });
    } finally {
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });
});

describe('a composition that was told a resolver is coming (COR-1586)', () => {
  it('holds a catalog run and a session run, each with one warn naming it, until the resolver is wired', async () => {
    const diagnostics: BureauDiagnostic[] = [];
    const runtime = await compositionWith(true, diagnostics);
    try {
      const catalogRun = runtime.resolveRunServices(catalogRunInfo);
      const sessionRun = runtime.resolveSessionAgentRun('echo', 'session-run-1');
      expect(await settledWithin(catalogRun)).toBe(false);
      expect(await settledWithin(sessionRun)).toBe(false);
      const warnings = diagnostics.filter((entry) => entry.level === 'warn');
      expect(warnings.map((entry) => entry.scope)).toEqual(['recovery', 'recovery']);
      const messages = warnings.map((entry) => entry.message).join('\n');
      expect(messages).toContain('Run "catalog-run"');
      expect(messages).toContain('Run "session-run-1"');

      runtime.setCatalogAgentRunOptionsResolver(async () => ({
        status: 'resolved',
        options: fakeRunOptions(),
        definitionRevision: 1,
      }));

      expect(await catalogRun).toMatchObject({ status: 'available' });
      expect(await sessionRun).toMatchObject({ status: 'resolved' });
      expect(diagnostics.filter((entry) => entry.level === 'warn')).toHaveLength(2);
    } finally {
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });

  it('settles every waiting reader, and every later one, as unavailable once the resolver is abandoned', async () => {
    const runtime = await compositionWith(true);
    try {
      const catalogRun = runtime.resolveRunServices(catalogRunInfo);
      const sessionRun = runtime.resolveSessionAgentRun('echo', 'session-run-1');
      expect(await settledWithin(catalogRun)).toBe(false);

      runtime.abandonCatalogAgentRunOptionsResolver('the bureau failed to build its catalog');

      expect(await catalogRun).toEqual({
        status: 'unavailable',
        reason: 'run catalog-run: the bureau failed to build its catalog',
      });
      expect(await sessionRun).toMatchObject({
        status: 'resolver-failed',
        error: expect.objectContaining({ message: 'the bureau failed to build its catalog' }),
      });
      expect(await runtime.resolveRunServices(catalogRunInfo)).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('the bureau failed to build its catalog'),
      });

      // Terminal: a resolver wired after the abandonment does not revive the composition.
      runtime.setCatalogAgentRunOptionsResolver(async () => ({
        status: 'resolved',
        options: fakeRunOptions(),
        definitionRevision: 1,
      }));
      expect(await runtime.resolveRunServices(catalogRunInfo)).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('the bureau failed to build its catalog'),
      });
    } finally {
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });
});
