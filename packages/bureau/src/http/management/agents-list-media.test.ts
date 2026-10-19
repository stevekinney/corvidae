/**
 * COR-1548 — `bureau.agents.list` says which media each agent's model takes, as an additive
 * `media` field: `null` for an agent with no model descriptor, and the descriptor's modalities,
 * families and per-part byte limits for one that has.
 */
import { createAgent, createModelCatalog, withBackendDescriptors } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { agentsListOperation } from './deployment-operations.ts';
import { callAs, disposeServed, listOf, serve } from './agent-definitions-fixtures.test-support.ts';

afterEach(disposeServed);

const anthropic = createModelCatalog().descriptors.find((row) => row.provider === 'anthropic')!;

describe('bureau.agents.list media', () => {
  it('is null for a code agent whose generate names no model, and describes one that does', async () => {
    const served = await serve({
      agents: {
        alpha: createAgent({
          name: 'alpha',
          generate: async () => ({ content: 'a', toolCalls: [] }),
        }),
        seer: createAgent({
          name: 'seer',
          generate: withBackendDescriptors(
            async () => ({ content: 's', toolCalls: [] }),
            [anthropic],
          ),
        }),
      },
    });
    const response = await callAs(served.local, 'bureau.agents.list', {});
    // Only `alpha` is in the fixture's `publish` allowlist; the local caller sees the rest too.
    const byName = new Map(listOf(response, 'agents').map((entry) => [entry['name'], entry]));

    expect(byName.get('alpha')?.['media']).toBeNull();
    expect(byName.get('seer')?.['media']).toEqual({
      modalities: expect.objectContaining({
        image: { input: true, output: false },
        audio: { input: false, output: false },
      }),
      mimeFamilies: ['text', 'image', 'document'],
      mediaLimits: [{ modality: 'image', maxBytes: 10 * 1024 * 1024 }],
    });
  });
});

describe('the bureau.agents.list output schema (COR-1548)', () => {
  const entry = (maxBytes: number) => ({
    name: 'seer',
    displayName: 'Seer',
    description: null,
    definitionRevision: 1,
    kind: 'code',
    publishState: 'published',
    media: {
      modalities: { image: { input: true, output: false } },
      mimeFamilies: ['image'],
      mediaLimits: [{ modality: 'image', maxBytes }],
    },
  });
  const parse = (maxBytes: number) =>
    agentsListOperation.outputSchema.safeParse({ agents: [entry(maxBytes)] }).success;

  it('takes a per-part byte limit that is a non-negative whole number', () => {
    expect(parse(0)).toBe(true);
    expect(parse(10 * 1024 * 1024)).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN])('refuses a byte limit of %s', (maxBytes) => {
    expect(parse(maxBytes)).toBe(false);
  });
});
