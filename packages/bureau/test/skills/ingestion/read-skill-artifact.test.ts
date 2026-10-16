import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { decodeArtifactText, findArtifactEntry } from '../../../src/skills/artifact';
import { readSkillArtifact } from '../../../src/skills/ingestion/read-skill-artifact';

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-skill-artifact-'));
  createdRoots.push(root);
  return root;
}

async function write(root: string, relativePath: string, content: string | Uint8Array) {
  const full = join(root, relativePath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
  return full;
}

const MANIFEST = '---\nname: pdf-processing\ndescription: A skill.\n---\n\nBody.\n';

async function completeSkill(): Promise<{ root: string; skill: string }> {
  const root = await scratch();
  const skill = join(root, 'pdf-processing');
  await write(skill, 'SKILL.md', MANIFEST);
  return { root, skill };
}

// There is no filesystem API for a FIFO, so `mkfifo` is the real process this test needs; it runs
// once here at module scope to stay off the per-test clock.
const fifoRoot = await mkdtemp(join(tmpdir(), 'corvidae-skill-artifact-fifo-'));
const fifoSkill = join(fifoRoot, 'pdf-processing');
await write(fifoSkill, 'SKILL.md', MANIFEST);
await mkdir(join(fifoSkill, 'assets'), { recursive: true });
const fifoMade = Bun.spawnSync(['mkfifo', join(fifoSkill, 'assets/pipe')], { timeout: 120_000 });

afterAll(async () => {
  await rm(fifoRoot, { recursive: true, force: true });
});

describe('readSkillArtifact', () => {
  it('carries nested directories with their relative paths intact', async () => {
    const { skill } = await completeSkill();
    await write(skill, 'scripts/nested/deep/extract.py', 'print("hello")');
    await write(skill, 'references/REFERENCE.md', '# Reference');
    await write(skill, 'assets/templates/letter.txt', 'Dear');

    const result = await readSkillArtifact(skill);

    expect(result.admitted).toBe(true);
    if (!result.admitted) return;

    // The previous ingestion path listed only the skill directory's top level, so every one of
    // these files was silently dropped.
    expect(result.artifact.entries.map((entry) => entry.path)).toEqual([
      'SKILL.md',
      'assets/templates/letter.txt',
      'references/REFERENCE.md',
      'scripts/nested/deep/extract.py',
    ]);
    expect(result.artifact.name).toBe('pdf-processing');
  });

  it('round-trips a nested binary asset by digest', async () => {
    const { skill } = await completeSkill();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);
    await write(skill, 'assets/images/logo.png', png);

    const result = await readSkillArtifact(skill);

    expect(result.admitted).toBe(true);
    if (!result.admitted) return;

    const entry = findArtifactEntry(result.artifact, 'assets/images/logo.png');
    expect(entry?.bytes).toEqual(png);
    expect(entry?.mediaType).toBe('image/png');
    // The digest of these exact bytes, computed independently of the ingestion path.
    const expected = await Bun.CryptoHasher.hash('sha256', png, 'hex');
    expect(entry?.digest).toBe(expected);
  });

  it('admits a symbolic link that stays inside the skill root', async () => {
    const { skill } = await completeSkill();
    await write(skill, 'references/REFERENCE.md', '# Reference');
    await symlink(join(skill, 'references/REFERENCE.md'), join(skill, 'references/ALIAS.md'));

    const result = await readSkillArtifact(skill);

    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(decodeArtifactText(findArtifactEntry(result.artifact, 'references/ALIAS.md')!)).toBe(
      '# Reference',
    );
  });

  it('refuses a symbolic link that escapes the skill root', async () => {
    const { root, skill } = await completeSkill();
    await write(root, 'outside/secrets.txt', 'do not read me');
    await mkdir(join(skill, 'references'), { recursive: true });
    await symlink(join(root, 'outside/secrets.txt'), join(skill, 'references/leak.txt'));

    const result = await readSkillArtifact(skill);

    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('symlink-escape');
    expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toContain(
      'references/leak.txt',
    );
  });

  it('refuses a symbolic link to a directory outside the skill root', async () => {
    const { root, skill } = await completeSkill();
    await write(root, 'outside/nested/secrets.txt', 'do not read me');
    await symlink(join(root, 'outside'), join(skill, 'assets'));

    const result = await readSkillArtifact(skill);

    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('symlink-escape');
  });

  it('refuses a broken symbolic link rather than skipping it', async () => {
    const { skill } = await completeSkill();
    await mkdir(join(skill, 'references'), { recursive: true });
    await symlink(join(skill, 'references/does-not-exist.md'), join(skill, 'references/broken.md'));

    const result = await readSkillArtifact(skill);

    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('symlink-escape');
  });

  it('refuses a FIFO rather than blocking on it', async () => {
    if (fifoMade.exitCode !== 0) throw new Error('mkfifo is required for this test');

    const result = await readSkillArtifact(fifoSkill);

    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    // Reading a FIFO with no writer blocks forever; the whole point of classifying it is to never
    // reach the read.
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('special-file');
  });

  it('refuses a tree deeper than the configured limit', async () => {
    const { skill } = await completeSkill();
    await write(skill, 'a/b/c/d/deep.txt', 'deep');

    const result = await readSkillArtifact(skill, { maximumDepth: 2 });

    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'scan-limit-exceeded',
    );
  });

  it('refuses a tree with more directories than the configured limit', async () => {
    const { skill } = await completeSkill();
    for (const name of ['one', 'two', 'three', 'four']) {
      await write(skill, `${name}/file.txt`, name);
    }

    const result = await readSkillArtifact(skill, { maximumDirectoryCount: 2 });

    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'scan-limit-exceeded',
    );
  });

  it('applies content limits to what it finds', async () => {
    const { skill } = await completeSkill();
    await write(skill, 'assets/big.txt', 'x'.repeat(64));

    const result = await readSkillArtifact(skill, { limits: { maximumFileBytes: 32 } });

    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('file-too-large');
  });

  it('refuses an oversized file from its size, without reading it', async () => {
    const { skill } = await completeSkill();
    await write(skill, 'assets/big.txt', 'x'.repeat(64));
    // Unreadable *and* oversized, which makes the two implementations distinguishable: a reader
    // that loads content first can only report `unreadable-file`, while one that gates on the
    // stat it already holds reports `file-too-large`. Asserting the diagnostic alone — as the
    // test above does — passes either way, which is how a 200 MiB file came to be fully loaded
    // into memory before being called too large.
    await chmod(join(skill, 'assets/big.txt'), 0o000);

    const result = await readSkillArtifact(skill, { limits: { maximumFileBytes: 32 } });

    expect(result.admitted).toBe(false);
    if (result.admitted) return;

    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('file-too-large');
    expect(codes).not.toContain('unreadable-file');
  });

  it('refuses an excess file from the running count, without reading it', async () => {
    const { skill } = await completeSkill();
    await write(skill, 'assets/a.txt', 'a');
    await write(skill, 'assets/b.txt', 'b');
    await chmod(join(skill, 'assets/b.txt'), 0o000);

    // SKILL.md and a.txt fill the budget; b.txt is refused on the count before anyone opens it.
    const result = await readSkillArtifact(skill, { limits: { maximumFileCount: 2 } });

    expect(result.admitted).toBe(false);
    if (result.admitted) return;

    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('too-many-files');
    expect(codes).not.toContain('unreadable-file');
  });

  it('refuses a directory that does not exist', async () => {
    const root = await scratch();

    const result = await readSkillArtifact(join(root, 'missing'));

    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('unreadable-file');
  });

  it('refuses a directory with no SKILL.md', async () => {
    const root = await scratch();
    const skill = join(root, 'no-manifest');
    await write(skill, 'references/REFERENCE.md', '# Reference');

    const result = await readSkillArtifact(skill);

    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('missing-skill-file');
  });

  it('treats an executable script as inert content', async () => {
    const { root, skill } = await completeSkill();
    const marker = join(root, 'executed-marker');

    await write(skill, 'scripts/side-effect.sh', `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    await chmod(join(skill, 'scripts/side-effect.sh'), 0o755);

    const result = await readSkillArtifact(skill);

    expect(result.admitted).toBe(true);
    if (!result.admitted) return;

    const entry = findArtifactEntry(result.artifact, 'scripts/side-effect.sh');
    // Read, catalogued, digested and decoded — every operation this package performs on a
    // resource — and the script's side effect never happens, because nothing here runs it.
    expect(decodeArtifactText(entry!)).toContain('touch');
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  it('is stable across repeated reads of the same tree', async () => {
    const { skill } = await completeSkill();
    await write(skill, 'scripts/a.py', 'a');
    await write(skill, 'scripts/b.py', 'b');
    await write(skill, 'references/c.md', 'c');

    const first = await readSkillArtifact(skill);
    const second = await readSkillArtifact(skill);

    expect(first.admitted && second.admitted).toBe(true);
    if (!first.admitted || !second.admitted) return;
    expect(first.artifact.digest).toBe(second.artifact.digest);
  });
});
