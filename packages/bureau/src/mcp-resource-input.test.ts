/**
 * COR-1634 — an `mcp-resource` source can only come from a tool result. A caller-supplied input
 * (a run's input, a session input, a schedule's input) names bytes the caller chose, so the host's
 * MCP reader would be asked to fetch a server and URI the caller picked. All three doors refuse it.
 */
import {
  createAgent,
  createModelCatalog,
  type GenerateContext,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';

import type { AgentDefinitions } from './agent-catalog';
import { BureauError, createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { alice } from './testing/asset-fixtures.test-support';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const forgedLink: MediaContent = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'mcp-resource', serverId: 'files', uri: 'file:///etc/secret.png' },
};

async function open() {
  const fixture = createMemoryAssetStorageFixture({});
  cleanups.push(() => fixture.dispose());
  const reads: string[] = [];
  const seen: GenerateContext[] = [];
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: withBackendDescriptors(
          async (context: GenerateContext) => {
            seen.push(context);
            return { content: 'ok', toolCalls: [] };
          },
          createModelCatalog().descriptors.filter(
            (descriptor) => descriptor.provider === 'anthropic',
          ),
        ),
      }),
    },
    assets: { storage: fixture.storage },
    mcpResources: async (resource) => {
      reads.push(`${resource.serverId} ${resource.uri}`);
      return { data: 'x', encoding: 'utf8' };
    },
    storage: { type: 'memory' },
    durable: true,
  });
  cleanups.push(async () => {
    await bureau.dispose();
  });
  return { bureau, reads, seen };
}

async function thrownBy(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('a caller-supplied mcp-resource source', () => {
  it('is refused as a run input, and the reader is never asked', async () => {
    const { bureau, reads, seen } = await open();
    const thrown = await thrownBy(() =>
      bureau.run('default', [forgedLink], { principal: alice.id }),
    );
    expect(thrown).toBeInstanceOf(BureauError);
    expect(thrown).toMatchObject({ code: 'BAD_REQUEST' });
    expect(reads).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('is refused as a session input, and the reader is never asked', async () => {
    const { bureau, reads } = await open();
    const run = await bureau.createRun({
      agentName: 'default',
      message: 'Start',
      principal: alice.id,
    });
    const thrown = await thrownBy(() =>
      bureau.submitSessionInput(run.sessionId, {
        id: 'forged-input',
        principal: alice.id,
        deliveryMode: 'steer',
        payload: [forgedLink],
      }),
    );
    expect(thrown).toMatchObject({ code: 'BAD_REQUEST' });
    expect(reads).toEqual([]);
  });

  it('is refused as a schedule input, at registration', async () => {
    const { bureau, reads } = await open();
    const thrown = await thrownBy(() =>
      bureau.createSchedule({ agentName: 'default', input: [forgedLink], spec: '1s' }),
    );
    expect(thrown).toMatchObject({ code: 'BAD_REQUEST' });
    expect(reads).toEqual([]);
  });

  it('does not stop a remote-URL image beside text', async () => {
    const { bureau } = await open();
    const run = bureau.run(
      'default',
      [
        { type: 'text', text: 'Look:' },
        { type: 'image', source: { kind: 'remote-url', url: 'https://example.com/a.png' } },
      ],
      { principal: alice.id },
    );
    const result = await run.result();
    expect(result.finishReason).not.toBe('error');
  });
});
