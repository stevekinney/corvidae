import { describe, expect, test } from 'bun:test';

import { scheduleStatusDescriptor } from './schedule-status.ts';

describe('scheduleStatusDescriptor', () => {
  test('maps every ScheduleStatus to a descriptor', () => {
    expect(scheduleStatusDescriptor('active')).toEqual({
      variant: 'success',
      icon: 'play',
      label: 'Active',
    });
    expect(scheduleStatusDescriptor('paused')).toEqual({
      variant: 'neutral',
      icon: 'pause',
      label: 'Paused',
    });
    expect(scheduleStatusDescriptor('cancelled')).toEqual({
      variant: 'neutral',
      icon: 'circle-x',
      label: 'Cancelled',
    });
  });
});
