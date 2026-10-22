import { describe, expect, it } from 'bun:test';

import {
  countHumanWaitParks,
  humanWaitParks,
  humanWaitParkSignalNames,
  parkedHumanWait,
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

// COR-1578 — a refused park request is a normal tool result that never parked.
const refused = (signalName: string) => ({
  toolName: 'requestHumanInput',
  result: {
    parked: false,
    signalName,
    refused: true,
    pendingPark: { kind: 'human-input', signalName: 'a' },
    message: `Not requested: this step already waits for human signal "a". Request it again after that wait ends.`,
  },
});

describe('parkedHumanWait', () => {
  it('returns the signal and the prompt of a parked result, and no prompt key without one', () => {
    expect(
      parkedHumanWait({
        toolName: 'requestHumanInput',
        result: { parked: true, signalName: 'a', prompt: 'Approve a?' },
      }),
    ).toEqual({ signalName: 'a', prompt: 'Approve a?' });
    expect(parkedHumanWait(parked('a'))).toEqual({ signalName: 'a' });
  });

  it('returns nothing for a refused result, a non-object result, or another tool', () => {
    expect(parkedHumanWait(refused('b'))).toBeUndefined();
    expect(parkedHumanWait({ toolName: 'requestHumanInput', result: 'text' })).toBeUndefined();
    expect(
      parkedHumanWait({ toolName: 'other', result: { parked: true, signalName: 'x' } }),
    ).toBeUndefined();
  });

  it('agrees with parkedSignalName on every result', () => {
    for (const result of [parked('a'), refused('b'), { toolName: 'lookup' }]) {
      expect(parkedHumanWait(result)?.signalName).toBe(parkedSignalName(result));
    }
  });
});

describe('a refused park request never counts as a park (COR-1578)', () => {
  it('counts an a-then-refused-b step as the one park of a one-call step', () => {
    expect(countHumanWaitParks([parked('a'), refused('b')])).toBe(1);
    expect(countHumanWaitParks([parked('a'), refused('b')])).toBe(countHumanWaitParks([parked('a')]));
    expect(humanWaitParkSignalNames([parked('a'), refused('b')])).toEqual(['a']);
    expect(humanWaitParks([refused('a')])).toEqual([]);
  });

  it('does not let a refusal split or extend a run of the same signal', () => {
    expect(countHumanWaitParks([parked('a'), refused('a')])).toBe(1);
    expect(countHumanWaitParks([refused('b'), parked('a')])).toBe(1);
  });
});
