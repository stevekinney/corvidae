import { describe, expect, it } from 'bun:test';

import {
  computeToolbarOverflow,
  resolveFocusPinnedOverflow,
  type ToolbarOverflowGroup,
} from './toolbar-overflow.ts';

const groups: ToolbarOverflowGroup[] = [
  { id: 'text-formatting', width: 100 },
  { id: 'links', width: 40 },
  { id: 'lists', width: 60 },
  { id: 'block-operations', width: 30 },
];

describe('computeToolbarOverflow', () => {
  it('keeps every group inline when everything fits (gap included), without reserving trigger width', () => {
    // The four groups total 230px and share three 10px gaps.
    // An exact fit uses the full width without reserving space for the trigger.
    const result = computeToolbarOverflow({
      availableWidth: 260,
      gap: 10,
      triggerWidth: 50,
      groups,
    });

    expect(result).toEqual({
      visibleGroupIds: ['text-formatting', 'links', 'lists', 'block-operations'],
      overflowGroupIds: [],
    });
  });

  it('treats availableWidth === null as "not yet measured" and keeps everything inline', () => {
    expect(
      computeToolbarOverflow({ availableWidth: null, gap: 10, triggerWidth: 50, groups }),
    ).toEqual({
      visibleGroupIds: groups.map((group) => group.id),
      overflowGroupIds: [],
    });
  });

  it('treats a real non-positive measurement as "no room," not as unmeasured', () => {
    // availableWidth === 0 is a genuine measurement (the toolbar really has
    // no room), unlike availableWidth === null. Every group must overflow,
    // the opposite of the null case above.
    const zero = computeToolbarOverflow({ availableWidth: 0, gap: 10, triggerWidth: 50, groups });
    expect(zero).toEqual({
      visibleGroupIds: [],
      overflowGroupIds: ['text-formatting', 'links', 'lists', 'block-operations'],
    });

    const negative = computeToolbarOverflow({
      availableWidth: -10,
      gap: 10,
      triggerWidth: 50,
      groups,
    });
    expect(negative).toEqual({
      visibleGroupIds: [],
      overflowGroupIds: ['text-formatting', 'links', 'lists', 'block-operations'],
    });
  });

  it('charges flex gaps between adjacent items', () => {
    // Three 30px groups and two 10px gaps need 110px. In 95px only one group
    // fits beside the 20px trigger.
    const threeGroups: ToolbarOverflowGroup[] = [
      { id: 'a', width: 30 },
      { id: 'b', width: 30 },
      { id: 'c', width: 30 },
    ];

    const result = computeToolbarOverflow({
      availableWidth: 95,
      gap: 10,
      triggerWidth: 20,
      groups: threeGroups,
    });

    expect(result).toEqual({
      visibleGroupIds: ['a'],
      overflowGroupIds: ['b', 'c'],
    });
  });

  it('reserves trigger width (plus its own gap) and greedily fits groups in priority order', () => {
    // Formatting (100px), Links (40px), and the trigger (20px) need exactly
    // 180px including two gaps. Charging a gap at the toolbar edge hides Links.
    const result = computeToolbarOverflow({
      availableWidth: 180,
      gap: 10,
      triggerWidth: 20,
      groups,
    });

    expect(result).toEqual({
      visibleGroupIds: ['text-formatting', 'links'],
      overflowGroupIds: ['lists', 'block-operations'],
    });
  });

  it('never lets a smaller lower-priority group jump ahead of a larger one that overflowed', () => {
    // Links and Block operations would each fit beside the trigger on their
    // own. Both follow the wider Formatting group into overflow.
    const result = computeToolbarOverflow({
      availableWidth: 100,
      gap: 10,
      triggerWidth: 20,
      groups,
    });

    expect(result).toEqual({
      visibleGroupIds: [],
      overflowGroupIds: ['text-formatting', 'links', 'lists', 'block-operations'],
    });
  });

  it('puts every group inline when there are no candidate groups', () => {
    const result = computeToolbarOverflow({
      availableWidth: 10,
      gap: 10,
      triggerWidth: 20,
      groups: [],
    });

    expect(result).toEqual({ visibleGroupIds: [], overflowGroupIds: [] });
  });

  it('fits a single group without charging a gap at the toolbar edge', () => {
    const result = computeToolbarOverflow({
      availableWidth: 130,
      gap: 10,
      triggerWidth: 20,
      groups: [{ id: 'only', width: 130 }],
    });

    expect(result).toEqual({ visibleGroupIds: ['only'], overflowGroupIds: [] });
  });
});

describe('resolveFocusPinnedOverflow', () => {
  const unpinned = {
    overflowSetPinnedByTrigger: null,
    focusedGroupId: null,
    focusedGroupWasOverflowing: false,
  };

  it('passes the raw set through when nothing holds focus', () => {
    expect(
      resolveFocusPinnedOverflow({
        ...unpinned,
        rawOverflowGroupIds: ['lists', 'block-operations'],
      }),
    ).toEqual(['lists', 'block-operations']);
  });

  it('keeps a focused group inline after a resize says it should overflow', () => {
    // Focus entered `lists` while it was inline. Narrowing the toolbar must not yank it
    // into the popover under the user's cursor.
    expect(
      resolveFocusPinnedOverflow({
        ...unpinned,
        rawOverflowGroupIds: ['lists', 'block-operations'],
        focusedGroupId: 'lists',
        focusedGroupWasOverflowing: false,
      }),
    ).toEqual(['block-operations']);
  });

  it('keeps a focused group in the popover after a resize says it fits inline', () => {
    // The reverse transition. Focus is inside the PORTALED overflow panel, which is why
    // the component listens for focus on the document rather than on the toolbar node:
    // a panel focus that never reaches the toolbar would leave this pin unset and let
    // the group snap back inline mid-interaction.
    expect(
      resolveFocusPinnedOverflow({
        ...unpinned,
        rawOverflowGroupIds: ['block-operations'],
        focusedGroupId: 'lists',
        focusedGroupWasOverflowing: true,
      }),
    ).toEqual(['block-operations', 'lists']);
  });

  it('does not override when the raw calculation already agrees with the pinned side', () => {
    expect(
      resolveFocusPinnedOverflow({
        ...unpinned,
        rawOverflowGroupIds: ['lists'],
        focusedGroupId: 'lists',
        focusedGroupWasOverflowing: true,
      }),
    ).toEqual(['lists']);
  });

  it('holds the whole set while the overflow trigger has focus', () => {
    // The trigger renders only while the set is non-empty. Without this pin, growing
    // the toolbar until everything fits unmounts the control the user is focused on and
    // drops focus to <body>.
    expect(
      resolveFocusPinnedOverflow({
        rawOverflowGroupIds: [],
        overflowSetPinnedByTrigger: ['lists', 'block-operations'],
        focusedGroupId: null,
        focusedGroupWasOverflowing: false,
      }),
    ).toEqual(['lists', 'block-operations']);
  });

  it('lets the trigger pin win over a group pin', () => {
    // Both can be set only transiently, between a focusout and the focusin that clears
    // the group. The trigger's own survival is the stronger constraint.
    expect(
      resolveFocusPinnedOverflow({
        rawOverflowGroupIds: [],
        overflowSetPinnedByTrigger: ['lists'],
        focusedGroupId: 'block-operations',
        focusedGroupWasOverflowing: true,
      }),
    ).toEqual(['lists']);
  });

  it('honours a group pinned on the popover side while the raw set is empty', () => {
    // The state a focus move INTO the portaled panel must produce. The trigger was
    // holding a set open after the toolbar grew (raw is now empty); focus lands on a
    // group inside that panel, and the handler snapshots the EFFECTIVE side -- what the
    // user can see -- before releasing the trigger pin.
    //
    // Snapshotting after the release instead would read the empty raw set, record the
    // group as "was inline", and the pin would then yank it out of the panel the user is
    // looking at. This asserts the resulting state resolves the way that ordering
    // intends.
    expect(
      resolveFocusPinnedOverflow({
        rawOverflowGroupIds: [],
        overflowSetPinnedByTrigger: null,
        focusedGroupId: 'lists',
        focusedGroupWasOverflowing: true,
      }),
    ).toEqual(['lists']);

    // The same state recorded the wrong way round collapses the panel instead --
    // the failure mode, stated so the difference is visible.
    expect(
      resolveFocusPinnedOverflow({
        rawOverflowGroupIds: [],
        overflowSetPinnedByTrigger: null,
        focusedGroupId: 'lists',
        focusedGroupWasOverflowing: false,
      }),
    ).toEqual([]);
  });

  it('releases every pin once focus leaves, letting the raw set through again', () => {
    expect(resolveFocusPinnedOverflow({ ...unpinned, rawOverflowGroupIds: [] })).toEqual([]);
  });
});
