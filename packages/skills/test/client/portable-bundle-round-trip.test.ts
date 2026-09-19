import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SkillActivationRecord } from '../../src/client/activation';
import { createFilesystemArtifactLoader } from '../../src/client/artifact-loader';
import { createSkillClientToolbox } from '../../src/client/client-toolbox';
import { renderActiveSkillInstructions } from '../../src/client/render';
import { createSkillClient, type SkillClient } from '../../src/client/skill-client';
import { discoverSkills } from '../../src/discovery/discover';
import type { SkillTrustPolicy } from '../../src/discovery/source';

/**
 * The end-to-end gate for COR-892's criterion 4: one portable bundle, carrying nested text and
 * binary resources, activated both explicitly and by the model, surviving compaction and recovery
 * with an identical artifact digest and identical instructions.
 *
 * The unit suites each prove one link — discovery catalogues, the loader verifies, `recover()`
 * refuses a drifted digest, rendering deduplicates. None of them proves the chain holds end to end,
 * and a chain is exactly what a resumed run depends on: the failure this guards against is every
 * link passing its own test while the composition quietly hands a resumed run different bytes than
 * the run it resumed.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Bytes that are not valid UTF-8, so a lossy decode anywhere in the chain is visible. */
const LOGO_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00,
]);

const GUIDE = '# Guide\n\nNested reference text, two directories deep.\n';

const INSTRUCTIONS = [
  'Read the nested guide before answering.',
  '',
  'It lives at `references/deep/guide.md`.',
].join('\n');

async function writePortableBundle(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-skill-bundle-'));
  roots.push(root);
  const directory = join(root, name);
  await mkdir(join(directory, 'references', 'deep'), { recursive: true });
  await mkdir(join(directory, 'assets'), { recursive: true });

  await writeFile(
    join(directory, 'SKILL.md'),
    ['---', `name: ${name}`, `description: A portable bundle.`, '---', '', INSTRUCTIONS, ''].join(
      '\n',
    ),
  );
  await writeFile(join(directory, 'references', 'deep', 'guide.md'), GUIDE);
  await writeFile(join(directory, 'assets', 'logo.png'), LOGO_BYTES);
  return root;
}

const trustEverything: SkillTrustPolicy = {
  decide: () => ({ state: 'trusted', reason: 'test policy' }),
};

const now = (): string => '2026-09-19T00:00:00.000Z';

async function clientFor(root: string): Promise<SkillClient> {
  const catalog = await discoverSkills({
    sources: [{ id: 'user', kind: 'user', location: root, precedence: 20 }],
    trustPolicy: trustEverything,
    now,
  });
  return createSkillClient({ catalog, loadArtifact: createFilesystemArtifactLoader(), now });
}

describe('a portable bundle survives the whole chain', () => {
  it('carries nested text and binary resources from disk to an activated skill', async () => {
    const root = await writePortableBundle('portable');
    const client = await clientFor(root);

    const outcome = await client.activate('portable');
    expect(outcome.activated).toBe(true);

    const guide = client.loadResource('portable', 'references/deep/guide.md');
    expect(guide?.mediaType).toBe('text/markdown');
    expect(new TextDecoder().decode(guide?.bytes)).toBe(GUIDE);

    // Byte-for-byte, not merely "some bytes arrived". A UTF-8 round trip anywhere in the chain
    // replaces 0xff/0xfe with U+FFFD and corrupts every binary asset a bundle ships.
    const logo = client.loadResource('portable', 'assets/logo.png');
    expect(logo?.mediaType).toBe('image/png');
    expect(logo?.bytes).toEqual(LOGO_BYTES);
  });

  it('reaches the same skill through the model-facing tool as through the host', async () => {
    const root = await writePortableBundle('portable');
    const explicit = await clientFor(root);
    const viaModel = await clientFor(root);

    const hostOutcome = await explicit.activate('portable');
    const toolbox = createSkillClientToolbox(viaModel);
    const modelResult = (await toolbox!.activateSkill.execute({ name: 'portable' })) as {
      instructions?: string;
      digest?: string;
    };

    expect(hostOutcome.activated).toBe(true);
    if (!hostOutcome.activated) return;
    // A host command and a model tool call are two doors onto one client, not two implementations
    // that happen to agree today.
    expect(modelResult.digest).toBe(hostOutcome.record.instructionsDigest);
    expect(modelResult.instructions).toBe(renderActiveSkillInstructions(explicit.active()));
  });

  it('recovers a compacted run with the identical digest and instructions', async () => {
    const root = await writePortableBundle('portable');

    const before = await clientFor(root);
    await before.activate('portable');
    const rendered = renderActiveSkillInstructions(before.active());
    const records: readonly SkillActivationRecord[] = before.activationRecords();
    const digestBefore = records[0]?.instructionsDigest;
    const artifactBefore = records[0]?.artifactDigest;

    // Compaction throws the transcript away; the client is rebuilt from the stored records alone,
    // as a resumed run rebuilds it.
    const after = await clientFor(root);
    const recovery = await after.recover(records);

    expect(recovery).toEqual({ recovered: ['portable'], refused: [] });
    expect(after.activationRecords()[0]?.instructionsDigest).toBe(digestBefore);
    expect(after.activationRecords()[0]?.artifactDigest).toBe(artifactBefore);
    // The digests agreeing is the proof; re-rendering identically is what the digests are for.
    expect(renderActiveSkillInstructions(after.active())).toBe(rendered);
  });

  it('still carries its resources after recovery, not just its instructions', async () => {
    const root = await writePortableBundle('portable');
    const before = await clientFor(root);
    await before.activate('portable');

    const after = await clientFor(root);
    await after.recover(before.activationRecords());

    // Recovery that restored instructions but not the bundle would leave a resumed run able to
    // read its own directions and unable to follow them.
    expect(after.loadResource('portable', 'assets/logo.png')?.bytes).toEqual(LOGO_BYTES);
    expect(
      new TextDecoder().decode(after.loadResource('portable', 'references/deep/guide.md')?.bytes),
    ).toBe(GUIDE);
  });

  it('refuses recovery when a nested resource changed, even though the instructions did not', async () => {
    const root = await writePortableBundle('portable');
    const before = await clientFor(root);
    await before.activate('portable');
    const records = before.activationRecords();

    // The manifest is untouched. Only a file two directories down moved.
    await writeFile(
      join(root, 'portable', 'references', 'deep', 'guide.md'),
      '# Guide\n\nRewritten.\n',
    );

    const after = await clientFor(root);
    const recovery = await after.recover(records);

    // The artifact digest covers the whole bundle, so tampering with a resource a skill tells the
    // model to read is caught even when the instructions still hash the same.
    expect(recovery).toEqual({ recovered: [], refused: ['portable'] });
    expect(after.active()).toEqual([]);
  });
});
