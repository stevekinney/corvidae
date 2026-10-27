import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { createStorageSkillProvider } from '../../src/skills/create-storage-skill-provider';
import { findRecord } from '../../src/skills/discovery/catalog';
import { discoverSkills } from '../../src/skills/discovery/discover';
import type { SkillSource } from '../../src/skills/discovery/source';
import { parseSkillMarkdown, SkillParseError } from '../../src/skills/parse-skill-markdown';
import { createMockKeyValueStore } from '../../src/skills/test/index';
import { resourceBytes } from './support/resource-bytes';

/**
 * A write surface, tested as one.
 *
 * The key namespace is the whole contract here: it is what the writer promises and what the
 * `storage` discovery source reads. So these assert the keys directly, and then assert that
 * discovery actually finds what was written — a test that wrote and read through the same module
 * would pass just as well if both halves agreed on the wrong thing.
 */

const now = (): string => '2026-09-19T00:00:00.000Z';

const storageSource: SkillSource = {
  id: 'storage',
  kind: 'storage',
  location: 'kv://skills',
  precedence: 25,
};

function skillMarkdown(name: string, body = `Instructions for ${name}.`): string {
  return ['---', `name: ${name}`, `description: Description for ${name}`, '---', '', body, ''].join(
    '\n',
  );
}

describe('createStorageSkillProvider writes the namespace discovery reads', () => {
  it('stores a skill under skill:{name}:metadata and skill:{name}:body', async () => {
    const store = createMockKeyValueStore();
    await createStorageSkillProvider(store).saveSkill(
      'documented',
      parseSkillMarkdown(skillMarkdown('documented', 'Body text.')),
    );

    const metadata = await store.get('skill:documented:metadata');
    expect(JSON.parse(metadata!)).toMatchObject({
      name: 'documented',
      description: 'Description for documented',
    });
    expect(await store.get('skill:documented:body')).toBe('Body text.');
  });

  it('stores a resource base64-encoded under skill:{name}:resource:{path}', async () => {
    const store = createMockKeyValueStore();
    const provider = createStorageSkillProvider(store);
    await provider.saveSkill('with-asset', parseSkillMarkdown(skillMarkdown('with-asset')));
    // Bytes no UTF-8 round trip survives, so an encoding regression is visible rather than subtle.
    const logo = new Uint8Array([0xff, 0xfe, 0x00, 0x89]);
    await provider.saveResource('with-asset', 'assets/logo.png', logo);

    const stored = await store.get('skill:with-asset:resource:assets/logo.png');
    const decoded = Uint8Array.from(atob(stored!), (character) => character.charCodeAt(0));
    expect(decoded).toEqual(logo);
  });

  it('stores the enabled flag under skill:{name}:enabled', async () => {
    const store = createMockKeyValueStore();
    const provider = createStorageSkillProvider(store);
    await provider.saveSkill('switchable', parseSkillMarkdown(skillMarkdown('switchable')));
    await provider.setEnabled('switchable', false);

    expect(await store.get('skill:switchable:enabled')).toBe('false');
  });

  it('removes everything under a deleted skill, and nothing under another', async () => {
    const store = createMockKeyValueStore();
    const provider = createStorageSkillProvider(store);
    for (const name of ['delete-me', 'keep-me']) {
      await provider.saveSkill(name, parseSkillMarkdown(skillMarkdown(name)));
      await provider.saveResource(name, 'guide.md', resourceBytes(name));
      await provider.setEnabled(name, false);
    }

    await provider.deleteSkill('delete-me');

    expect(await store.list('skill:delete-me:')).toEqual([]);
    // A prefix delete that swept a neighbour would be silent data loss, so the survivor is asserted
    // rather than assumed.
    const survivorKeys = await store.list('skill:keep-me:');
    expect(survivorKeys.length).toBe(4);
  });
});

describe('what it writes is what discovery admits', () => {
  it('round-trips a written skill into a catalog record', async () => {
    const store = createMockKeyValueStore();
    await createStorageSkillProvider(store).saveSkill(
      'persisted',
      parseSkillMarkdown(skillMarkdown('persisted')),
    );

    const revision = await discoverSkills({ sources: [storageSource], storage: store, now });

    expect(findRecord(revision, 'persisted')?.available).toBe(true);
    expect(findRecord(revision, 'persisted')?.sourceKind).toBe('storage');
  });

  it('keeps a written resource reachable as part of the bundle', async () => {
    const store = createMockKeyValueStore();
    const provider = createStorageSkillProvider(store);
    await provider.saveSkill('bundled', parseSkillMarkdown(skillMarkdown('bundled')));
    await provider.saveResource('bundled', 'references/guide.md', resourceBytes('guide'));

    const revision = await discoverSkills({ sources: [storageSource], storage: store, now });

    expect(findRecord(revision, 'bundled')?.bundleSupport).toBe('complete');
  });

  it('hides a disabled skill from discovery', async () => {
    const store = createMockKeyValueStore();
    const provider = createStorageSkillProvider(store);
    await provider.saveSkill('switched-off', parseSkillMarkdown(skillMarkdown('switched-off')));
    await provider.setEnabled('switched-off', false);

    const revision = await discoverSkills({ sources: [storageSource], storage: store, now });

    expect(findRecord(revision, 'switched-off')).toBeUndefined();
  });

  it('leaves two skills independent of each other', async () => {
    const store = createMockKeyValueStore();
    const provider = createStorageSkillProvider(store);
    await provider.saveSkill('alpha', parseSkillMarkdown(skillMarkdown('alpha', 'Alpha body.')));
    await provider.saveSkill('beta', parseSkillMarkdown(skillMarkdown('beta', 'Beta body.')));

    const revision = await discoverSkills({ sources: [storageSource], storage: store, now });

    expect(revision.records.map((record) => record.name)).toEqual(['alpha', 'beta']);
    expect(findRecord(revision, 'alpha')?.artifactDigest).not.toBe(
      findRecord(revision, 'beta')?.artifactDigest,
    );
  });
});

describe('a write that cannot be read back is refused at the write', () => {
  it('refuses a name the specification does not allow', async () => {
    const provider = createStorageSkillProvider(createMockKeyValueStore());

    expect(
      await throwingRejectionOf(
        provider.saveSkill('Not_Valid', {
          metadata: { name: 'Not_Valid', description: 'Bad name.' },
          body: 'Body.',
        }),
      ),
    ).toThrow(SkillParseError);
  });

  it('refuses a name that disagrees with the content it is saving', async () => {
    const provider = createStorageSkillProvider(createMockKeyValueStore());

    // Written under one key and self-describing as another, this skill would be catalogued under
    // the name in its manifest and be unreachable at the key anything else addressed it by.
    expect(
      await throwingRejectionOf(
        provider.saveSkill('stored-as', parseSkillMarkdown(skillMarkdown('calls-itself'))),
      ),
    ).toThrow(SkillParseError);
  });

  it('refuses an invalid name when saving a resource, not only a skill', async () => {
    const provider = createStorageSkillProvider(createMockKeyValueStore());

    expect(
      await throwingRejectionOf(
        provider.saveResource('Not_Valid', 'guide.md', resourceBytes('guide')),
      ),
    ).toThrow(SkillParseError);
  });
});
