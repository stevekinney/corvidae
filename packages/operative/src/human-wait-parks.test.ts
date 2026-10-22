import { describe, expect, it } from 'bun:test';

import {
  countHumanWaitParks,
  humanWaitParkSignalNames,
  parkedSignalName,
} from './human-wait-parks';

const parked = (signalName: string) => ({
  toolName: 'requestHumanInput',
  result: { parked: true, signalName },
});

describe('countHumanWaitParks', () => {
  it('counts nothing for a step that parked nowhere', () => {
    expect(countHumanWaitParks([])).toBe(0);
    expect(
      countHumanWaitParks([{ toolName: 'lookup', result: { parked: true, signalName: 'x' } }]),
    ).toBe(0);
    expect(
      countHumanWaitParks([{ toolName: 'requestHumanInput', result: { parked: false } }]),
    ).toBe(0);
  });

  it('counts consecutive parked results on one signal as one park', () => {
    expect(countHumanWaitParks([parked('human-response'), parked('human-response')])).toBe(1);
  });

  it('counts a different signal name as the next park, as a step asking under two names does', () => {
    expect(countHumanWaitParks([parked('first-question'), parked('second-question')])).toBe(2);
    expect(
      countHumanWaitParks([parked('a'), { toolName: 'lookup' }, parked('a'), parked('b')]),
    ).toBe(2);
  });
});

describe('parkedSignalName', () => {
  it('names the signal of a parked requestHumanInput result and of nothing else', () => {
    expect(parkedSignalName(parked('human-response'))).toBe('human-response');
    expect(parkedSignalName({ toolName: 'requestHumanInput', result: 'text' })).toBeUndefined();
    expect(
      parkedSignalName({ toolName: 'other', result: { parked: true, signalName: 'x' } }),
    ).toBeUndefined();
  });
});

describe('humanWaitParkSignalNames', () => {
  it('names each park once, by the rule that counts them', () => {
    expect(humanWaitParkSignalNames([])).toEqual([]);
    expect(
      humanWaitParkSignalNames([parked('a'), { toolName: 'lookup' }, parked('a'), parked('b')]),
    ).toEqual(['a', 'b']);
    const results = [parked('s'), parked('s'), parked('t')];
    expect(humanWaitParkSignalNames(results)).toHaveLength(countHumanWaitParks(results));
  });
});
