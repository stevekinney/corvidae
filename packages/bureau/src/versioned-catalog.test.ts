/**
 * COR-1872 — the shared versioned catalog: exact `name@version` resolution for every kind, the
 * plugin's version for a contribution that declares none, and a clash result that keeps the first
 * registration.
 */
import { describe, expect, it } from 'bun:test';

import {
  createVersionedCatalog,
  formatVersionedId,
  parseVersionedId,
  VERSIONED_CATALOG_KINDS,
} from './versioned-catalog';

const linear = { name: 'linear', version: '3.0.0' } as const;

describe('createVersionedCatalog resolution', () => {
  for (const kind of VERSIONED_CATALOG_KINDS) {
    describe(kind, () => {
      it('resolves the exact version that was registered', () => {
        const catalog = createVersionedCatalog<string>();
        catalog.register({ kind, name: 'x:y', version: '1', value: 'one', source: linear });

        const resolution = catalog.resolve(kind, 'x:y@1');

        expect(resolution.ok).toBe(true);
        if (!resolution.ok) throw new Error('unreachable');
        expect(resolution.entry).toMatchObject({ kind, name: 'x:y', version: '1', id: 'x:y@1' });
        expect(resolution.entry.value).toBe('one');
      });

      it('reports version-mismatch for x:y@2 when only x:y@1 is registered', () => {
        const catalog = createVersionedCatalog<string>();
        catalog.register({ kind, name: 'x:y', version: '1', value: 'one', source: linear });

        expect(catalog.resolve(kind, 'x:y@2')).toEqual({
          ok: false,
          reason: 'version-mismatch',
          kind,
          requested: { name: 'x:y', version: '2' },
          availableVersions: ['1'],
        });
      });

      it('reports missing for x:y@2 when nothing is registered', () => {
        const catalog = createVersionedCatalog<string>();

        expect(catalog.resolve(kind, 'x:y@2')).toEqual({
          ok: false,
          reason: 'missing',
          kind,
          requested: { name: 'x:y', version: '2' },
          availableVersions: [],
        });
      });
    });
  }

  it('keeps each kind a separate namespace', () => {
    const catalog = createVersionedCatalog<string>();
    catalog.register({ kind: 'activity', name: 'x:y', version: '1', value: 'a', source: linear });

    expect(catalog.resolve('hook-action', 'x:y@1')).toMatchObject({ ok: false, reason: 'missing' });
    expect(catalog.entries('activity').map((entry) => entry.id)).toEqual(['x:y@1']);
    expect(catalog.entries('hook-action')).toEqual([]);
  });

  it('treats a reference with no version, or a non-string part, as never matching a version', () => {
    const catalog = createVersionedCatalog<string>();
    catalog.register({ kind: 'activity', name: 'x:y', version: '1', value: 'a', source: linear });

    expect(catalog.resolve('activity', 'x:y')).toMatchObject({
      ok: false,
      reason: 'version-mismatch',
      requested: { name: 'x:y', version: '' },
    });
    expect(catalog.resolve('activity', { name: 'x:y', version: 1 })).toMatchObject({
      ok: false,
      reason: 'version-mismatch',
      requested: { name: 'x:y', version: '' },
    });
  });
});

describe('createVersionedCatalog registration', () => {
  it('registers a contribution with no version at its plugin version', () => {
    const catalog = createVersionedCatalog<string>();

    const registered = catalog.register({
      kind: 'trigger-kind',
      name: 'linear:issue-created',
      value: 'trigger',
      source: linear,
    });

    expect(registered).toMatchObject({ ok: true, entry: { version: '3.0.0' } });
    expect(catalog.resolve('trigger-kind', 'linear:issue-created@3.0.0')).toMatchObject({
      ok: true,
    });
  });

  it("prefers the contribution's own version to its plugin's", () => {
    const catalog = createVersionedCatalog<string>();
    catalog.register({
      kind: 'eval-judge',
      name: 'linear:quality',
      version: '1.2.0',
      value: 'judge',
      source: linear,
    });

    expect(catalog.resolve('eval-judge', 'linear:quality@1.2.0')).toMatchObject({ ok: true });
    expect(catalog.resolve('eval-judge', 'linear:quality@3.0.0')).toMatchObject({
      reason: 'version-mismatch',
    });
  });

  it('returns a clash naming both sources and keeps the first registration', () => {
    const catalog = createVersionedCatalog<string>();
    const other = { name: 'other', version: '1.0.0' };
    catalog.register({
      kind: 'decision-router',
      name: 'x:route',
      version: '1',
      value: 'first',
      source: linear,
    });

    const clash = catalog.register({
      kind: 'decision-router',
      name: 'x:route',
      version: '1',
      value: 'second',
      source: other,
    });

    expect(clash).toEqual({
      ok: false,
      reason: 'clash',
      kind: 'decision-router',
      id: 'x:route@1',
      existing: linear,
      rejected: other,
    });
    const resolution = catalog.resolve('decision-router', 'x:route@1');
    if (!resolution.ok) throw new Error('the first registration should stay');
    expect(resolution.entry.value).toBe('first');
    expect(resolution.entry.source).toEqual(linear);
    expect(catalog.entries('decision-router')).toHaveLength(1);
  });

  it('counts a versionless contribution at its plugin version when checking for a clash', () => {
    const catalog = createVersionedCatalog<string>();
    catalog.register({
      kind: 'hook-action',
      name: 'x:post',
      version: '3.0.0',
      value: 'a',
      source: linear,
    });

    const clash = catalog.register({
      kind: 'hook-action',
      name: 'x:post',
      value: 'b',
      source: linear,
    });

    expect(clash).toMatchObject({ ok: false, reason: 'clash', id: 'x:post@3.0.0' });
  });

  it('registers a second version of a name beside the first', () => {
    const catalog = createVersionedCatalog<string>();
    catalog.register({ kind: 'validator', name: 'x:v', version: '1', value: 'a', source: linear });
    catalog.register({ kind: 'validator', name: 'x:v', version: '2', value: 'b', source: linear });

    expect(catalog.resolve('validator', 'x:v@3')).toMatchObject({
      reason: 'version-mismatch',
      availableVersions: ['1', '2'],
    });
  });

  it('throws for an identity it cannot record', () => {
    const catalog = createVersionedCatalog<string>();
    const unversioned = { name: 'core' };

    expect(() =>
      catalog.register({ kind: 'activity', name: '', version: '1', value: 'a', source: linear }),
    ).toThrow(TypeError);
    expect(() =>
      catalog.register({ kind: 'activity', name: 'x:y', value: 'a', source: unversioned }),
    ).toThrow('declares no version');
    expect(() =>
      catalog.register({
        kind: 'activity',
        name: 'x:y',
        version: '1@2',
        value: 'a',
        source: linear,
      }),
    ).toThrow('contains "@"');
    expect(() =>
      catalog.register({
        kind: 'unknown' as never,
        name: 'x:y',
        version: '1',
        value: 'a',
        source: linear,
      }),
    ).toThrow('not a versioned catalog kind');
  });
});

describe('versioned ids', () => {
  it('formats and parses name@version, splitting at the last @', () => {
    expect(formatVersionedId('x:y', '2')).toBe('x:y@2');
    expect(parseVersionedId('tests@bureau@1.0.0')).toEqual({
      name: 'tests@bureau',
      version: '1.0.0',
    });
    expect(parseVersionedId('x:y')).toBeUndefined();
    expect(parseVersionedId('@1')).toBeUndefined();
    expect(parseVersionedId('x:y@')).toBeUndefined();
  });
});
