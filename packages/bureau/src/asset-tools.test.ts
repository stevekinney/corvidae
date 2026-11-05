/** COR-2032 — registered managed-asset tools use the persisted run owner and bounded content. */
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { createAssetTools } from './asset-tools';
import { createMemoryAssetStorage } from './assets/storage';
import { createAssetHarness, textBytes } from './testing/asset-fixtures.test-support';
import type { AssetHarness } from './testing/asset-fixtures.test-support';

const runContext = {
  requestContext: {
    runId: 'run-1',
    authority: {
      principalId: 'run:run-1',
      ownerId: 'wrong-owner',
      capabilities: ['tools:execute'],
      tenantId: 'test',
      authorizationRevision: 'test:1',
    },
    audience: 'tenant' as const,
  },
};

const opened: AssetHarness[] = [];

function payload(result: { content: unknown }): Record<string, unknown> {
  return (
    typeof result.content === 'string' ? JSON.parse(result.content) : result.content
  ) as Record<string, unknown>;
}

afterEach(async () => {
  for (const fixture of opened.splice(0)) await fixture.harness.close();
});

async function toolsFor(owner = 'alice') {
  const fixture = await createAssetHarness({ storage: createMemoryAssetStorage() });
  opened.push(fixture);
  const toolbox = createToolbox(
    createAssetTools({
      assets: () => fixture.assets,
      ownerOfRun: async () => owner,
    }),
  );
  return { fixture, toolbox };
}

describe('registered managed-asset tools', () => {
  it('publishes and reads text through the persisted run owner, not tool authority', async () => {
    const { toolbox } = await toolsFor();
    const published = await toolbox.execute(
      { name: 'assets-publish', arguments: { text: 'hello', mediaType: 'text/plain' } },
      runContext,
    );
    expect(published.outcome).toBe('success');
    const assetId = payload(published)['assetId'] as string;
    const read = await toolbox.execute({ name: 'assets-read', arguments: { assetId } }, runContext);
    expect(read.outcome).toBe('success');
    expect(payload(read)).toMatchObject({ content: 'hello', truncated: false });
  });

  it('cuts UTF-8 content back to a complete code point at the read cap', async () => {
    const { toolbox } = await toolsFor();
    const text = `${'a'.repeat(65_534)}🙂${'b'.repeat(140_000)}`;
    const published = await toolbox.execute(
      { name: 'assets-publish', arguments: { text, mediaType: 'text/plain' } },
      runContext,
    );
    const assetId = payload(published)['assetId'] as string;
    const read = await toolbox.execute({ name: 'assets-read', arguments: { assetId } }, runContext);
    const result = payload(read) as unknown as { content: string; truncated: boolean };
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(65_536);
    expect(result.content).not.toContain('🙂');
    expect(result.truncated).toBe(true);
    expect(
      new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(result.content)),
    ).toBe(result.content);
  });

  it('refuses oversized text and decoded base64 before admitting an asset', async () => {
    const { fixture, toolbox } = await toolsFor();
    const oversizedText = 'x'.repeat(256 * 1024 + 1);
    const textResult = await toolbox.execute(
      { name: 'assets-publish', arguments: { text: oversizedText, mediaType: 'text/plain' } },
      runContext,
    );
    expect(textResult.outcome).toBe('error');
    const bytes = textBytes('x'.repeat(256 * 1024 + 1));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const base64Result = await toolbox.execute(
      {
        name: 'assets-publish',
        arguments: { base64: btoa(binary), mediaType: 'application/octet-stream' },
      },
      runContext,
    );
    expect(base64Result.outcome).toBe('error');
    expect(await fixture.assets.auditRecords()).not.toContainEqual(
      expect.objectContaining({ type: 'asset.admission.started' }),
    );
  });

  it('hides an owner asset from a different A2A owner', async () => {
    const { fixture, toolbox } = await toolsFor('anonymous:local');
    const published = await toolbox.execute(
      { name: 'assets-publish', arguments: { text: 'private', mediaType: 'text/plain' } },
      runContext,
    );
    const assetId = payload(published)['assetId'] as string;
    const foreign = createToolbox(
      createAssetTools({
        assets: () => fixture.assets,
        ownerOfRun: async () => 'api-key:a2a',
      }),
    );
    const read = await foreign.execute({ name: 'assets-read', arguments: { assetId } }, runContext);
    expect(read.outcome).toBe('success');
    expect(payload(read)).toEqual({ status: 'not-found' });
  });
});
