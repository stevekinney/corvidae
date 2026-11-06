/** COR-2032 — registered managed-asset tools use the persisted run owner and bounded content. */
import { createToolbox } from 'armorer';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, it } from 'bun:test';

import { createAssetTools, managedAssetPart } from './asset-tools';
import { createMemoryAssetStorage } from './assets/storage';
import { createAssetHarness, textBytes } from './testing/asset-fixtures.test-support';
import type { AssetHarness } from './testing/asset-fixtures.test-support';
import type { AssetDescriptor } from './assets/types';

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

async function toolsFor(
  owner = 'alice',
  workspaceAuthority?: (otherOwner: string) => Promise<boolean>,
) {
  const fixture = await createAssetHarness({ storage: createMemoryAssetStorage() });
  opened.push(fixture);
  const toolbox = createToolbox(
    createAssetTools({
      assets: () => fixture.assets,
      ownerOfRun: async () => owner,
      ...(workspaceAuthority === undefined ? {} : { workspaceAuthority: () => workspaceAuthority }),
    }),
  );
  return { fixture, toolbox };
}

describe('registered managed-asset tools', () => {
  it('keeps generic binary assets as canonical file parts', () => {
    const part = managedAssetPart({
      assetId: 'asset-generic',
      revision: 1,
      modality: 'file',
      mediaType: 'application/octet-stream',
      fileName: 'blob.bin',
    } as unknown as AssetDescriptor);
    expect(part).toMatchObject({
      type: 'file',
      mimeType: 'application/octet-stream',
      name: 'blob.bin',
    });
  });

  it('falls back to a file part for storage documents outside the portable MIME classifier', () => {
    const part = managedAssetPart({
      assetId: 'asset-epub',
      revision: 1,
      modality: 'document',
      mediaType: 'application/epub+zip',
      fileName: 'book.epub',
    } as unknown as AssetDescriptor);
    expect(part).toMatchObject({
      type: 'file',
      mimeType: 'application/epub+zip',
      name: 'book.epub',
    });
  });

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

  it('returns the existing readable asset id when duplicate publication reuses it', async () => {
    const fixture = await createAssetHarness({
      storage: createMemoryAssetStorage(),
      policy: { duplicatePolicy: 'reuse' },
    });
    opened.push(fixture);
    const toolbox = createToolbox(
      createAssetTools({ assets: () => fixture.assets, ownerOfRun: async () => 'alice' }),
    );
    const first = await toolbox.execute(
      { name: 'assets-publish', arguments: { text: 'same', mediaType: 'text/plain' } },
      runContext,
    );
    const firstAssetId = payload(first)['assetId'];
    const second = await toolbox.execute(
      { name: 'assets-publish', arguments: { text: 'same', mediaType: 'text/plain' } },
      runContext,
    );
    expect(payload(second)).toEqual({ status: 'ok', assetId: firstAssetId });
    const read = await toolbox.execute(
      { name: 'assets-read', arguments: { assetId: firstAssetId } },
      runContext,
    );
    expect(payload(read)).toMatchObject({ status: 'ok', content: 'same' });
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

  it('rejects oversized encoded base64 before decoding and refuses unsafe file names at admission', async () => {
    const { fixture, toolbox } = await toolsFor();
    const oversized = await toolbox.execute(
      {
        name: 'assets-publish',
        arguments: { base64: 'A'.repeat(349_528), mediaType: 'application/octet-stream' },
      },
      runContext,
    );
    expect(oversized.outcome).toBe('error');
    for (const fileName of ['.', '..', 'nested/file.txt', 'nested\\file.txt', 'bad\nname']) {
      const result = await toolbox.execute(
        {
          name: 'assets-publish',
          arguments: { text: 'payload', mediaType: 'text/plain', fileName },
        },
        runContext,
      );
      expect(result.outcome).toBe('error');
    }
    expect(await fixture.assets.auditRecords()).not.toContainEqual(
      expect.objectContaining({ type: 'asset.admission.started' }),
    );
    const direct = await rejectionOf(
      fixture.assets.admit(
        {
          source: { kind: 'inline', bytes: textBytes('payload') },
          fileName: '',
        },
        { id: 'alice' },
      ),
    );
    expect(direct).toMatchObject({ code: 'invalid-file-name' });
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

  it('does not let a service-account tool spend a stored cross-owner grant', async () => {
    const fixture = await createAssetHarness({ storage: createMemoryAssetStorage() });
    opened.push(fixture);
    const shared = await fixture.assets.admit(
      { source: { kind: 'inline', bytes: textBytes('private') }, readers: ['alice'] },
      { id: 'owner' },
    );
    await shared.work.result();
    const toolbox = createToolbox(
      createAssetTools({
        assets: () => fixture.assets,
        ownerOfRun: async () => 'service',
        workspaceAuthority: () => async (otherOwner) => otherOwner === 'service',
      }),
    );
    const read = await toolbox.execute(
      { name: 'assets-read', arguments: { assetId: shared.assetId } },
      runContext,
    );
    expect(read.outcome).toBe('success');
    expect(payload(read)).toEqual({ status: 'not-found' });
  });
});
