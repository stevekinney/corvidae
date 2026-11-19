/**
 * The Tags row of the Details rail (`run-tags.ts`, rows 54j, 55d, 55h): the system's tags are
 * counted, never listed, and a person edits only their own.
 */
import { describe, expect, test } from 'bun:test';

import { RESERVED_RUN_TAG_PREFIXES } from '@lostgradient/bureau';

import { editableRunTags, isSystemTag, runTagsFact, SYSTEM_TAG_PREFIXES } from './run-tags.ts';

describe('the system tag prefixes', () => {
  test('hold every prefix the Bureau reserves for its run tags', () => {
    for (const prefix of RESERVED_RUN_TAG_PREFIXES) {
      expect(SYSTEM_TAG_PREFIXES, prefix).toContain(prefix);
    }
  });

  test('count the steering tag, a 40-character hash, and never list it', () => {
    const steering = `bureau-steering-run:${'a1b2c3d4e5'.repeat(4)}`;
    expect(isSystemTag(steering)).toBe(true);
    expect(runTagsFact([steering, 'origin:chat'])).toEqual({ tags: [], systemTagCount: 2 });
    expect(isSystemTag('hook-origin:hook-1')).toBe(true);
  });
});

describe('runTagsFact', () => {
  test('counts the origin tags and lists only a person’s own', () => {
    expect(runTagsFact(['origin-parent:run-1', 'origin:goal', 'prod'])).toEqual({
      tags: ['prod'],
      systemTagCount: 2,
    });
  });

  test('a run with only system tags lists none, so the row says None and Add a tag', () => {
    expect(runTagsFact(['origin:goal', 'origin-parent-sha256:ab'])).toEqual({
      tags: [],
      systemTagCount: 2,
    });
    expect(runTagsFact(undefined)).toEqual({ tags: [], systemTagCount: 0 });
  });
});

describe('isSystemTag and editableRunTags', () => {
  test('an origin tag is the system’s, any other is a person’s', () => {
    expect(isSystemTag('origin:agent-run')).toBe(true);
    expect(isSystemTag('origin-parent:run-1')).toBe(true);
    expect(isSystemTag('original')).toBe(false);
    expect(editableRunTags(['origin:schedule', 'tier-1'])).toEqual(['tier-1']);
  });
});
