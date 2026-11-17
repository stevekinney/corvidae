/**
 * The Tags row of the Details rail (`run-tags.ts`, rows 54j, 55d, 55h): the system's tags are
 * counted, never listed, and a person edits only their own.
 */
import { describe, expect, test } from 'bun:test';

import { editableRunTags, isSystemTag, runTagsFact } from './run-tags.ts';

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
