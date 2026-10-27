/**
 * COR-1710 — the prevention test for the settings' consumer checks. Every key's value is checked
 * by the validator its consumer runs before it is written or applied, or is declared checked by
 * the schema alone. A key added without either fails here.
 */
import { describe, expect, it } from 'bun:test';

import { ENGINE_PATCH_FIELDS, SETTING_KEYS } from './settings-schema.ts';
import {
  ENGINE_CLAIM_KEYS,
  OPTION_VALIDATORS,
  SCHEMA_CHECKED_KEYS,
  settingsFailures,
} from './settings-validation.ts';

describe('the consumer checks behind each setting', () => {
  it('every key is checked by its consumer or declared checked by the schema alone, once', () => {
    const covered = [
      ...Object.keys(OPTION_VALIDATORS),
      ...Object.keys(ENGINE_PATCH_FIELDS),
      ...ENGINE_CLAIM_KEYS,
      ...SCHEMA_CHECKED_KEYS,
    ];
    expect([...new Set(covered)].toSorted()).toEqual([...SETTING_KEYS].toSorted());
    expect(covered.length).toBe(SETTING_KEYS.length);
  });

  it('the claim timing is checked under the ownership in force', () => {
    expect(settingsFailures({ 'engine.workflowClaimTtl': 1_000 })).toEqual([
      expect.objectContaining({ keys: ENGINE_CLAIM_KEYS }),
    ]);
    expect(
      settingsFailures({
        'engine.workflowClaimTtl': 1_000,
        'durableOwnership.ownership': 'none',
      }),
    ).toEqual([]);
  });
});
