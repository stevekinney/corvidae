/**
 * COR-1710 — the prevention test for the settings. A key in the schema is either `restart`, which
 * a new `createBureau` reads at boot, or `live` and owned by a module that reads it through the
 * settings at its point of use. A key added to the schema with neither fails here, and so does an
 * owner whose module does not read the key it claims.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SETTING_OWNERS } from './setting-owners.ts';
import { ENGINE_PATCH_FIELDS } from './settings-options.ts';
import { SETTING_APPLY, SETTING_KEYS } from './settings-schema.ts';

const sourceRoot = join(import.meta.dirname, '..');

/** Whether `source` reads `key` from a settings object: `values.key`, `settings()['key']`, and the like. */
function readsKey(source: string, key: string): boolean {
  const accessor = '(?:values|currentSettings\\(\\)|settings\\(\\))';
  const member = key.includes('.')
    ? `\\[\\s*'${key.replaceAll('.', '\\.')}'\\s*\\]`
    : `\\.${key}\\b`;
  return new RegExp(`${accessor}\\s*${member}`).test(source);
}

describe('who reads each setting', () => {
  const restart = SETTING_KEYS.filter((key) => SETTING_APPLY[key] === 'restart');
  const owned = SETTING_OWNERS.flatMap((owner) => owner.keys);

  it('every key is owned by a reader or declared restart, and by exactly one of them', () => {
    const unowned = SETTING_KEYS.filter((key) => !owned.includes(key) && !restart.includes(key));
    expect(unowned).toEqual([]);
    expect(owned.filter((key, index) => owned.indexOf(key) !== index)).toEqual([]);
    expect(owned.filter((key) => restart.includes(key))).toEqual([]);
    expect(owned.filter((key) => !SETTING_KEYS.includes(key))).toEqual([]);
  });

  it('every live key has an owner', () => {
    const live = SETTING_KEYS.filter((key) => SETTING_APPLY[key] === 'live');
    expect([...owned].toSorted()).toEqual([...live].toSorted());
  });

  for (const owner of SETTING_OWNERS) {
    it(`${owner.name} reads each of its keys through the settings`, () => {
      if (owner.reads === 'patch-table') {
        expect(owner.keys.map(String).toSorted()).toEqual(
          Object.keys(ENGINE_PATCH_FIELDS).toSorted(),
        );
        return;
      }
      const source = readFileSync(join(sourceRoot, owner.module), 'utf8');
      const unread = owner.keys.filter((key) => !readsKey(source, key));
      expect(unread).toEqual([]);
    });
  }
});
