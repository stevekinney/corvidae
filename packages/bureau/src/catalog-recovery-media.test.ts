import type { DurableRunDeps } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createRuntimeComposition } from './runtime-composition';

describe('a recovered catalog run with part input (COR-716)', () => {
  it('is recoverable, and is given the resolver and unverified-asset policy of its recorded principal', async () => {
    const principals: Array<string | undefined> = [];
    const resolver = async () => ({ outcome: 'unavailable' as const, reason: 'probe' });
    const runtime = await createRuntimeComposition(
      {
        storage: { type: 'memory' },
        durableExecution: true,
        guardrails: { input: { detectors: [], assetSafety: { unknown: 'block' } } },
      },
      {
        contentSourceResolverFor: (principalId) => {
          principals.push(principalId);
          return resolver;
        },
      },
    );
    try {
      runtime.setCatalogAgentRunOptionsResolver(async () => ({
        status: 'resolved',
        options: {
          generate: async () => ({ content: 'ok', toolCalls: [] }),
          toolbox: createToolbox([], { context: {} }),
          conversation: createConversationHistory({ id: 'catalog-recovered' }),
        },
        definitionRevision: 1,
      }));
      await runtime.persistCatalogRunRecoveryRecord('catalog-media-run', {
        agentName: 'echo',
        definitionRevision: 1,
        principal: 'api-key:alice',
        input: [{ type: 'image', source: { kind: 'managed-asset', assetId: 'asset-1' } }],
      });
      const result = await runtime.resolveRunServices({
        workflowId: 'catalog-media-run',
        workflowType: 'agentRun',
        input: { runId: 'catalog-media-run', sessionId: 'catalog-media-run', agentName: 'echo' },
      });
      expect(result).toMatchObject({ status: 'available' });
      const options = (result as { services: DurableRunDeps }).services.options;
      expect(options.contentSourceResolver).toBe(resolver);
      expect(options.assetSafety).toEqual({ unknown: 'block' });
      expect(principals).toEqual(['api-key:alice']);
    } finally {
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });
});
