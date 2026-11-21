import { describe, expect, it } from 'bun:test';

import { FIX_THE_FIELDS, saveMessage } from './save-message.ts';
import type { SaveOutcome } from './save.ts';

type Stopped = Exclude<SaveOutcome, { kind: 'saved' }>;

const CHANGED_SINCE_OPENED =
  'The schedule changed since it was opened. Read it again, then make the change again.';
const CREATE_NOT_ANSWERED =
  'The host did not answer, so the schedule may or may not have been made. Look at the list before trying again.';

const refused = (
  tool: string,
  done: string[],
  fault: { message: string; fields?: Record<string, string>; currentRevision?: number },
): Stopped => ({
  kind: 'refused',
  id: 's1',
  done,
  tool,
  fault: {
    message: fault.message,
    fields: fault.fields ?? {},
    currentRevision: fault.currentRevision,
  },
});

const UPDATE = 'bureau.schedules.update';
const PAUSE = 'bureau.schedules.pause';
const CREATE = 'bureau.schedules.create';

describe('the sentence a stopped save says', () => {
  it('ends the Bureau’s wording in a capital and a full stop, and leaves a finished sentence alone', () => {
    const reasonOf = (message: string) =>
      saveMessage(refused(UPDATE, [], { message }), false).replace('Not saved: ', '');
    expect(reasonOf('failed')).toBe('Failed.');
    expect(reasonOf(' no such agent ')).toBe('No such agent.');
    expect(reasonOf('Already done!')).toBe('Already done!');
  });

  it('says a refusal once on the fields when they carry it, and the page only says to fix them', () => {
    const message = saveMessage(
      refused(UPDATE, [], {
        message: 'Not a cron expression',
        fields: { spec: 'Not a cron expression' },
      }),
      false,
    );
    expect(message).toBe(`Not saved. ${FIX_THE_FIELDS}`);
    // The fault's own wording is the field's, not the page's.
    expect(message).not.toContain('cron');
  });

  it('says the Bureau’s own reason when no field is to blame, with its punctuation', () => {
    expect(saveMessage(refused(UPDATE, [], { message: 'schedule is gone' }), false)).toBe(
      'Not saved: Schedule is gone.',
    );
  });

  it('says which part landed and which did not, never "not saved" beside "saved"', () => {
    const message = saveMessage(refused(PAUSE, [UPDATE], { message: 'failed' }), false);
    expect(message).toBe('Saved the changes. Pausing it failed: Failed.');
    expect(message).not.toMatch(/not saved/i);
  });

  it('says the schedule changed, with what landed first when something did', () => {
    expect(saveMessage(refused(UPDATE, [], { message: 'Stale', currentRevision: 4 }), true)).toBe(
      `Not saved. ${CHANGED_SINCE_OPENED}`,
    );
    expect(
      saveMessage(refused(PAUSE, [UPDATE], { message: 'Stale', currentRevision: 6 }), true),
    ).toBe(`Saved the changes. Pausing it failed. ${CHANGED_SINCE_OPENED}`);
  });

  it('says fields are to blame for a part that failed after another landed', () => {
    expect(
      saveMessage(refused(UPDATE, [CREATE], { message: 'x', fields: { spec: 'x' } }), false),
    ).toBe(`Created the schedule. Saving the changes failed. ${FIX_THE_FIELDS}`);
  });

  it('says an answer it cannot read in the words of the action', () => {
    expect(saveMessage({ kind: 'unreadable', id: 's1', done: [], tool: UPDATE }, false)).toBe(
      'Saving the changes did not finish: the answer could not be read.',
    );
    expect(saveMessage({ kind: 'unreadable', id: 's1', done: [UPDATE], tool: PAUSE }, false)).toBe(
      'Saved the changes. Pausing it did not finish: the answer could not be read.',
    );
  });

  it('says a host that did not answer, for a create it may have written and for a change', () => {
    expect(saveMessage({ kind: 'unanswered', id: undefined, done: [], tool: CREATE }, false)).toBe(
      CREATE_NOT_ANSWERED,
    );
    expect(saveMessage({ kind: 'unanswered', id: 's1', done: [UPDATE], tool: PAUSE }, false)).toBe(
      'Saved the changes. The host did not answer while pausing it. The form was read again to show what the schedule holds. Check it before saving again.',
    );
  });

  it('never names a tool or the Bureau’s answer in any of its sentences', () => {
    const outcomes: Stopped[] = [
      refused(PAUSE, [UPDATE], { message: 'failed' }),
      refused(UPDATE, [], { message: 'x', fields: { spec: 'x' } }),
      refused(UPDATE, [], { message: 'Stale', currentRevision: 1 }),
      { kind: 'unreadable', id: 's1', done: [], tool: UPDATE },
      { kind: 'unanswered', id: 's1', done: [], tool: PAUSE },
      { kind: 'unanswered', id: undefined, done: [], tool: CREATE },
    ];
    for (const outcome of outcomes) {
      const message = saveMessage(
        outcome,
        outcome.kind === 'refused' && outcome.fault.currentRevision !== undefined,
      );
      expect(message).not.toMatch(/bureau/i);
      expect(message).toMatch(/[.!?]$/);
    }
  });
});
