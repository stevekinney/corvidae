/**
 * Every run tag the Bureau sets is covered by a reserved prefix (`reserved-tag-prefixes.ts`), so a
 * client that counts system tags by those prefixes never lists one as a person's tag.
 */
import { describe, expect, test } from 'bun:test';

import { hookOriginTag } from './hooks/hook-origin.ts';
import { isReservedRunTag, RESERVED_RUN_TAG_PREFIXES } from './reserved-tag-prefixes.ts';
import { steeringSessionRunTag } from './steering-log.ts';
import { taskOriginParentTag, taskOriginTag } from './task-origin.ts';

describe('the reserved run tag prefixes', () => {
  test('cover every tag the Bureau and the engine set on a run', () => {
    const tags = [
      taskOriginTag({ kind: 'goal' }),
      taskOriginTag({ kind: 'system' }),
      taskOriginParentTag('run-1'),
      taskOriginParentTag('r'.repeat(400)),
      steeringSessionRunTag('session-1', 'incarnation-1'),
      hookOriginTag('hook-1'),
      // Weft's own schedule tag (`SCHEDULE_ORIGIN_TAG`, not exported by the engine's package).
      'origin:schedule',
    ];
    for (const tag of tags) expect(isReservedRunTag(tag), tag).toBe(true);
  });

  test('leave a person’s own tag alone', () => {
    expect(isReservedRunTag('prod')).toBe(false);
    expect(isReservedRunTag('original')).toBe(false);
    expect(RESERVED_RUN_TAG_PREFIXES.every((prefix) => /[:]$/.test(prefix))).toBe(true);
  });
});
