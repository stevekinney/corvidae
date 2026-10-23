import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const chatCopy = join(root, 'components/chat/src/lib/a2ui/basic-catalog.schema.json');
const bureauCopy = join(root, 'packages/bureau/src/a2ui/basic-catalog.schema.json');

describe('the vendored A2UI basic catalog', () => {
  test('Bureau and Chat hold byte-identical copies', async () => {
    const [chat, bureau] = await Promise.all([
      Bun.file(chatCopy).arrayBuffer(),
      Bun.file(bureauCopy).arrayBuffer(),
    ]);
    expect(Buffer.from(bureau).equals(Buffer.from(chat))).toBe(true);
  });

  test("Bureau's provenance records the digest of its copy", async () => {
    const provenance = (await Bun.file(
      join(root, 'packages/bureau/src/a2ui/PROVENANCE.json'),
    ).json()) as { commit: string; files: Record<string, { sha256: string }> };
    const digest = new Bun.CryptoHasher('sha256')
      .update(await Bun.file(bureauCopy).arrayBuffer())
      .digest('hex');
    expect(provenance.files['basic-catalog.schema.json']?.sha256).toBe(digest);
    expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("Bureau's other vendored A2UI schemas", () => {
  const copies: readonly [string, string][] = [
    ['common-types.schema.json', 'components/cinder/scripts/a2ui/common_types.json'],
    ['server-to-client.schema.json', 'components/cinder/scripts/a2ui/server_to_client.json'],
    ['cinder-catalog.schema.json', 'components/cinder/a2ui-catalog.json'],
  ];

  for (const [name, source] of copies) {
    test(`${name} is byte-identical to ${source} and its digest is recorded`, async () => {
      const copy = join(root, 'packages/bureau/src/a2ui', name);
      const [bytes, original] = await Promise.all([
        Bun.file(copy).arrayBuffer(),
        Bun.file(join(root, source)).arrayBuffer(),
      ]);
      expect(Buffer.from(bytes).equals(Buffer.from(original))).toBe(true);
      const provenance = (await Bun.file(
        join(root, 'packages/bureau/src/a2ui/PROVENANCE.json'),
      ).json()) as { files: Record<string, { sha256: string }> };
      const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
      expect(provenance.files[name]?.sha256).toBe(digest);
    });
  }
});
