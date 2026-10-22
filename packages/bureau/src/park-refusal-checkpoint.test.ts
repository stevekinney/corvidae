// COR-1578 — a refused park request is persisted in `StepRecord.results` as a normal tool result.
// Everything that rebuilds parks from a checkpoint (the boot repair's park count, a fire's
// committed reviews) must read it as no park at all, so a step that asked `a` and was refused `b`
// is the one-park step a single call to `a` is.

import { describe, expect, it } from 'bun:test';

import { countCheckpointParks } from './park-ordinals';
import { committedFireReviewIds, committedFireReviews } from './scheduled-fire-review-state';

const RUN = 'run-1';

const parked = (signalName: string, prompt?: string) => ({
  outcome: 'success',
  toolName: 'requestHumanInput',
  result:
    prompt === undefined ? { parked: true, signalName } : { parked: true, signalName, prompt },
});

const refusedHumanInput = (signalName: string, pendingSignal: string) => ({
  outcome: 'success',
  toolName: 'requestHumanInput',
  result: {
    parked: false,
    signalName,
    refused: true,
    pendingPark: { kind: 'human-input', signalName: pendingSignal },
    message: `Not requested: this step already waits for human signal "${pendingSignal}". Request it again after that wait ends.`,
  },
});

const refusedWakeup = {
  outcome: 'success',
  toolName: 'scheduleWakeup',
  result: {
    scheduled: false,
    refused: true,
    pendingPark: { kind: 'human-input', signalName: 'a' },
    message:
      'Not requested: this step already waits for human signal "a". Request it again after that wait ends.',
  },
};

describe('countCheckpointParks ignores a refused park request (COR-1578)', () => {
  it('counts an a-then-refused-b step as the one park of a one-call step, with a prompt', () => {
    const oneCall = countCheckpointParks([{ results: [parked('a', 'Approve a?')] }]);
    const twoCalls = countCheckpointParks([
      { results: [parked('a', 'Approve a?'), refusedHumanInput('b', 'a')] },
    ]);

    expect(twoCalls).toEqual(oneCall);
    expect(twoCalls).toEqual({
      baseline: 1,
      outstanding: { signalName: 'a', prompt: 'Approve a?', ordinal: 0 },
    });
  });

  it('finds no outstanding park in a step holding only refusals', () => {
    expect(
      countCheckpointParks([{ results: [refusedHumanInput('b', 'a'), refusedWakeup] }]),
    ).toEqual({ baseline: 0 });
  });

  it('numbers a later park after the parks before it, never after a refusal', () => {
    const parks = countCheckpointParks([
      { results: [parked('a'), refusedHumanInput('b', 'a')] },
      { results: [refusedHumanInput('x', 'a'), parked('c', 'Approve c?')] },
    ]);

    expect(parks).toEqual({
      baseline: 2,
      outstanding: { signalName: 'c', prompt: 'Approve c?', ordinal: 1 },
    });
  });
});

describe('a fire commits no review for a refused park request (COR-1578)', () => {
  const steps = [
    { results: [parked('a', 'Approve a?'), refusedHumanInput('b', 'a'), refusedWakeup] },
  ];

  it('names only the honored park in the committed review ids', () => {
    expect([...committedFireReviewIds(RUN, steps)]).toEqual([`human-wait:${RUN}:a:0`]);
  });

  it('rebuilds only the honored park, with its prompt', () => {
    expect([...committedFireReviews(RUN, steps)]).toEqual([
      [`human-wait:${RUN}:a:0`, { kind: 'human-wait', signalName: 'a', prompt: 'Approve a?' }],
    ]);
  });
});
