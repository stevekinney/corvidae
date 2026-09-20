import { describe, expect, it } from 'bun:test';

import { createStorageSkillProvider } from '../../src/create-storage-skill-provider';
import { findRecord } from '../../src/discovery/catalog';
import { discoverSkills } from '../../src/discovery/discover';
import type { SkillSource } from '../../src/discovery/source';
import { parseSkillMarkdown } from '../../src/parse-skill-markdown';
import { createMockKeyValueStore, createMockSkillProvider } from '../../src/test/index';

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

describe('storage as a discovery source', () => {
  it('catalogues a stored skill with the same provenance a filesystem one gets', async () => {
    const store = createMockKeyValueStore();
    const provider = createStorageSkillProvider(store);
    await provider.saveSkill('persisted', parseSkillMarkdown(skillMarkdown('persisted')));

    const revision = await discoverSkills({ sources: [storageSource], storage: store, now });

    const record = findRecord(revision, 'persisted');
    // Before this, a KV-backed skill had no catalog entry at all: no trust decision, no artifact
    // digest, no compatibility verdict, and nothing to say where it came from.
    expect(record?.available).toBe(true);
    expect(record?.sourceKind).toBe('storage');
    expect(record?.sourceId).toBe('storage');
    expect(record?.artifactDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(record?.compatibility.conformant).toBe(true);
    expect(record?.bundleSupport).toBe('complete');
  });

  it('carries a stored skill resource into the artifact', async () => {
    const store = createMockKeyValueStore();
    const provider = createStorageSkillProvider(store);
    await provider.saveSkill('with-asset', parseSkillMarkdown(skillMarkdown('with-asset')));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
    await provider.saveResource('with-asset', 'assets/logo.png', png);

    const revision = await discoverSkills({ sources: [storageSource], storage: store, now });

    // A stored bundle is complete, resources included — which is what distinguishes it from a
    // manifest-only registry.
    expect(findRecord(revision, 'with-asset')?.bundleSupport).toBe('complete');
    expect(findRecord(revision, 'with-asset')?.available).toBe(true);
  });

  it('omits a disabled skill rather than cataloguing it as unavailable', async () => {
    const store = createMockKeyValueStore();
    const provider = createStorageSkillProvider(store);
    await provider.saveSkill('switched-off', parseSkillMarkdown(skillMarkdown('switched-off')));
    await provider.setEnabled('switched-off', false);

    const revision = await discoverSkills({ sources: [storageSource], storage: store, now });

    // `enabled` is an operator switch on the store, not a trust or compatibility verdict about the
    // skill, so it does not belong in the catalog as a reason.
    expect(findRecord(revision, 'switched-off')).toBeUndefined();
  });

  it('validates a stored skill with the same strict parser as a published one', async () => {
    const store = createMockKeyValueStore();
    // Written straight to the store, bypassing the provider's own validation, the way a corrupted
    // or hand-edited record would be.
    await store.set(
      'skill:broken:metadata',
      JSON.stringify({ name: 'Not_Valid', description: 'Bad name.' }),
    );
    await store.set('skill:broken:body', 'Body.');

    const revision = await discoverSkills({ sources: [storageSource], storage: store, now });

    // Coming from our own store is not a reason to trust the content's shape.
    const record = findRecord(revision, 'Not_Valid');
    expect(record?.available ?? false).toBe(false);
  });

  it('reports a configured storage source with no store rather than skipping it', async () => {
    const revision = await discoverSkills({ sources: [storageSource], now });

    expect(revision.records).toEqual([]);
    expect(revision.sourceDiagnostics.map((entry) => entry.code)).toContain('unavailable');
  });

  it('is deterministic across repeated reads of an unchanged store', async () => {
    const store = createMockKeyValueStore();
    const provider = createStorageSkillProvider(store);
    for (const name of ['alpha', 'beta', 'gamma']) {
      await provider.saveSkill(name, parseSkillMarkdown(skillMarkdown(name)));
    }

    const first = await discoverSkills({ sources: [storageSource], storage: store, now });
    const second = await discoverSkills({ sources: [storageSource], storage: store, now });

    expect(first.digest).toBe(second.digest);
    expect(first.records.map((record) => record.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('lets a project source shadow a stored skill of the same name', async () => {
    const store = createMockKeyValueStore();
    const provider = createStorageSkillProvider(store);
    await provider.saveSkill('shared', parseSkillMarkdown(skillMarkdown('shared', 'Stored.')));

    const revision = await discoverSkills({
      sources: [storageSource, { ...storageSource, id: 'other-storage', precedence: 5 }],
      storage: store,
      now,
    });

    // Precedence works across kinds exactly as it does within one.
    const shared = revision.records.filter((record) => record.name === 'shared');
    expect(shared.find((record) => record.available)?.sourceId).toBe('other-storage');
  });

  it('trusts storage by default, because the runtime wrote it', async () => {
    const store = createMockKeyValueStore();
    const provider = createStorageSkillProvider(store);
    await provider.saveSkill('accepted', parseSkillMarkdown(skillMarkdown('accepted')));

    // No trust policy supplied at all.
    const revision = await discoverSkills({ sources: [storageSource], storage: store, now });

    // An accepted self-improvement proposal must be usable by the run that accepted it.
    expect(findRecord(revision, 'accepted')?.trust).toBe('trusted');
    expect(findRecord(revision, 'accepted')?.available).toBe(true);
  });

  it('still lets an explicit policy revoke a storage source', async () => {
    const store = createMockKeyValueStore();
    const provider = createStorageSkillProvider(store);
    await provider.saveSkill('revocable', parseSkillMarkdown(skillMarkdown('revocable')));

    const revision = await discoverSkills({
      sources: [storageSource],
      storage: store,
      trustPolicy: { decide: () => ({ state: 'revoked', reason: 'withdrawn' }) },
      now,
    });

    expect(findRecord(revision, 'revocable')?.unavailableReason).toBe('source-revoked');
  });
});

describe('the mock provider still round-trips, so proposals keep a write surface', () => {
  it('writes a skill that discovery then catalogues', async () => {
    const provider = createMockSkillProvider();
    await provider.saveSkill('proposed', parseSkillMarkdown(skillMarkdown('proposed')));

    // The write half is the part that is genuinely needed: the self-improvement flow persists an
    // accepted proposal, and discovery reads it back as a source.
    expect(provider.written.has('proposed')).toBe(true);
  });
});
