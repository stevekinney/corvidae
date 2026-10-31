/**
 * The builder's model: the file's text read as rows, and every edit as a new text. The text is the
 * only state, so each edit keeps the keys the builder has no control for, and the reverse (a text
 * typed in the JSON tab) is what `readBuilder` shows.
 */
import { describe, expect, test } from 'bun:test';

import { WORKFLOW_COPY } from '../../app/copy.ts';

import {
  addStep,
  moveStep,
  readBuilder,
  removeStep,
  setDescription,
  setName,
  setStepField,
  setTrigger,
} from './workflow-builder-model.ts';

const FILE = {
  name: 'digest',
  description: 'A digest.',
  paused: true,
  inputSchema: { type: 'object' },
  trigger: { kind: 'schedule', spec: '1h', overlap: 'skip' },
  steps: [
    {
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'writer', message: 'Write it.', extra: 1 },
      timeout: '5m',
    },
    { kind: 'sleep', duration: '1m' },
    { kind: 'await-signal', signal: 'go' },
  ],
};

const text = (value: unknown = FILE): string => JSON.stringify(value, null, 2);
const parsed = (value: string): Record<string, unknown> =>
  JSON.parse(value) as Record<string, unknown>;

describe('readBuilder', () => {
  test('reads the name, description, trigger and each kind of step as a row', () => {
    const view = readBuilder(text());
    expect(view).toMatchObject({
      name: 'digest',
      description: 'A digest.',
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [
        { kind: 'agent', agent: 'writer', message: 'Write it.' },
        { kind: 'wait', duration: '1m' },
        { kind: 'signal', signal: 'go' },
      ],
    });
  });

  test('says the whole workflow in plain words', () => {
    expect(readBuilder(text())?.summary).toBe(
      'On a schedule: 1h (overlap: skip) → Ask the agent writer: Write it. → Sleep for 1m → Wait for the signal go',
    );
  });

  test('shows a step it has no control for as a label, and a trigger it does not know', () => {
    const view = readBuilder(
      text({ trigger: { kind: 'webhook' }, steps: [{ kind: 'activity', handler: 'other' }, 5] }),
    );
    expect(view?.trigger).toEqual({ kind: 'other', label: 'A webhook trigger' });
    expect(view?.steps[0]).toEqual({ kind: 'other', label: 'Run the activity other' });
    expect(view?.steps[1]?.kind).toBe('other');
  });

  test('reads a file with no trigger or steps as empty, and a number as its digits', () => {
    expect(readBuilder('{}')).toMatchObject({ trigger: null, steps: [], summary: '' });
    expect(readBuilder(text({ steps: [{ kind: 'sleep', duration: 60000 }] }))?.steps).toEqual([
      { kind: 'wait', duration: '60000' },
    ]);
  });

  test('has nothing to read for text that is not JSON or not an object', () => {
    expect(readBuilder('{ not json')).toBeUndefined();
    expect(readBuilder('[]')).toBeUndefined();
    expect(readBuilder('7')).toBeUndefined();
  });
});

describe('the edits', () => {
  test('setName puts the name first and keeps everything else', () => {
    const next = parsed(setName(text({ ...FILE, name: undefined }), 'fresh'));
    expect(Object.keys(next)[0]).toBe('name');
    expect(next).toMatchObject({ name: 'fresh', paused: true, inputSchema: { type: 'object' } });
  });

  test('setDescription sets it, and removes the key when it is emptied', () => {
    expect(parsed(setDescription(text(), 'New.'))['description']).toBe('New.');
    expect(parsed(setDescription(text(), ''))).not.toHaveProperty('description');
  });

  test('setTrigger keeps a schedule’s overlap while its spec changes, and replaces the trigger when the kind does', () => {
    expect(parsed(setTrigger(text(), 'schedule', '2h'))['trigger']).toEqual({
      kind: 'schedule',
      spec: '2h',
      overlap: 'skip',
    });
    expect(parsed(setTrigger(text(), 'signal', 'ping'))['trigger']).toEqual({
      kind: 'signal',
      name: 'ping',
    });
  });

  test('addStep appends each kind of step', () => {
    let next = text({ trigger: FILE.trigger, steps: [] });
    for (const kind of ['agent', 'wait', 'signal'] as const) next = addStep(next, kind, 'notes');
    expect(parsed(next)['steps']).toEqual([
      { kind: 'activity', handler: 'agent', input: { agent: 'notes', message: '' } },
      { kind: 'sleep', duration: '1m' },
      { kind: 'await-signal', signal: '' },
    ]);
  });

  test('addStep names no agent in a new agent step when none can run', () => {
    expect(parsed(addStep('{}', 'agent'))['steps']).toEqual([
      { kind: 'activity', handler: 'agent', input: { agent: '', message: '' } },
    ]);
  });

  test('addStep starts the list on a file with no steps key', () => {
    expect(parsed(addStep('{}', 'wait'))['steps']).toEqual([{ kind: 'sleep', duration: '1m' }]);
  });

  test('moveStep swaps neighbours, and does nothing past either end', () => {
    const steps = (value: string) =>
      (parsed(value)['steps'] as { kind: string }[]).map((s) => s.kind);
    expect(steps(moveStep(text(), 0, 1))).toEqual(['sleep', 'activity', 'await-signal']);
    expect(steps(moveStep(text(), 2, -1))).toEqual(['activity', 'await-signal', 'sleep']);
    expect(moveStep(text(), 0, -1)).toBe(text());
    expect(moveStep(text(), 2, 1)).toBe(text());
  });

  test('removeStep removes one step, and ignores an index that is not there', () => {
    expect((parsed(removeStep(text(), 1))['steps'] as unknown[]).length).toBe(2);
    expect(removeStep(text(), 9)).toBe(text());
  });

  test('setStepField changes one field and keeps the step’s other keys', () => {
    const edited = parsed(setStepField(text(), 0, 'message', 'Again.'))['steps'] as {
      input: Record<string, unknown>;
      timeout: string;
    }[];
    expect(edited[0]?.input).toEqual({ agent: 'writer', message: 'Again.', extra: 1 });
    expect(edited[0]?.timeout).toBe('5m');
    const steps = (value: string) => parsed(value)['steps'] as Record<string, unknown>[];
    expect(steps(setStepField(text(), 1, 'duration', '90s'))[1]?.['duration']).toBe('90s');
    expect(steps(setStepField(text(), 1, 'duration', '5000'))[1]?.['duration']).toBe(5000);
    expect(steps(setStepField(text(), 2, 'signal', 'stop'))[2]?.['signal']).toBe('stop');
  });

  test('setStepField changes nothing for a field the step does not have', () => {
    expect(setStepField(text(), 1, 'message', 'x')).toBe(text());
    expect(setStepField(text(), 0, 'signal', 'x')).toBe(text());
    expect(setStepField(text(), 2, 'duration', 'x')).toBe(text());
    expect(setStepField(text(), 7, 'agent', 'x')).toBe(text());
  });

  test('every edit returns text that is not JSON, or not an object, unchanged', () => {
    for (const bad of ['{ nope', '[]']) {
      expect(setName(bad, 'a')).toBe(bad);
      expect(setDescription(bad, 'a')).toBe(bad);
      expect(setTrigger(bad, 'signal', 'a')).toBe(bad);
      expect(addStep(bad, 'agent')).toBe(bad);
      expect(removeStep(bad, 0)).toBe(bad);
      expect(moveStep(bad, 0, 1)).toBe(bad);
      expect(setStepField(bad, 0, 'agent', 'a')).toBe(bad);
    }
  });

  test('a builder edit is what the JSON holds, and a JSON edit is what the builder reads', () => {
    const built = addStep(text({ trigger: { kind: 'signal', name: 'go' }, steps: [] }), 'signal');
    const typed = built.replace('"signal": ""', '"signal": "typed-in-json"');
    expect(readBuilder(typed)?.steps).toEqual([{ kind: 'signal', signal: 'typed-in-json' }]);
    expect(readBuilder(setStepField(typed, 0, 'signal', 'back'))?.steps).toEqual([
      { kind: 'signal', signal: 'back' },
    ]);
  });
});

describe('values the builder must not flatten or replace', () => {
  const MULTI_LINE = 'First line.\n\nSecond line, after a blank one.\n  Indented third.';

  test('a multi-line message and description survive reading and each edit', () => {
    const file = text({ ...FILE, description: MULTI_LINE });
    const steps = [{ ...FILE.steps[0], input: { agent: 'writer', message: MULTI_LINE } }];
    const withMessage = text({ ...FILE, description: MULTI_LINE, steps });
    expect(readBuilder(withMessage)).toMatchObject({
      description: MULTI_LINE,
      steps: [{ kind: 'agent', message: MULTI_LINE }],
    });
    const renamed = parsed(setName(withMessage, 'again'));
    expect(renamed['description']).toBe(MULTI_LINE);
    expect((renamed['steps'] as { input: { message: string } }[])[0]?.input.message).toBe(
      MULTI_LINE,
    );
    const appended = parsed(setStepField(withMessage, 0, 'message', `${MULTI_LINE}\nMore.`));
    expect((appended['steps'] as { input: { message: string } }[])[0]?.input.message).toBe(
      `${MULTI_LINE}\nMore.`,
    );
    expect(parsed(setDescription(file, `${MULTI_LINE}\nMore.`))['description']).toBe(
      `${MULTI_LINE}\nMore.`,
    );
  });

  test('a steps value that is not a list is not replaced by an add, and the builder says it cannot edit it', () => {
    const bad = text({ ...FILE, steps: 'sleep for a while' });
    expect(readBuilder(bad)?.stepsEditable).toBe(false);
    for (const kind of ['agent', 'wait', 'signal'] as const) expect(addStep(bad, kind)).toBe(bad);
    expect(moveStep(bad, 0, 1)).toBe(bad);
    expect(removeStep(bad, 0)).toBe(bad);
    expect(readBuilder(text(FILE))?.stepsEditable).toBe(true);
    expect(readBuilder('{}')?.stepsEditable).toBe(true);
  });

  test('an agent step whose input is not an object is left to the JSON tab and survives a field edit', () => {
    for (const input of ['Write it.', ['a'], 7, null]) {
      const bad = text({ ...FILE, steps: [{ kind: 'activity', handler: 'agent', input }] });
      expect(readBuilder(bad)?.steps[0]?.kind).toBe('other');
      expect(setStepField(bad, 0, 'message', 'x')).toBe(bad);
      expect(setStepField(bad, 0, 'agent', 'x')).toBe(bad);
    }
    const none = text({ ...FILE, steps: [{ kind: 'activity', handler: 'agent' }] });
    expect(readBuilder(none)?.steps[0]).toEqual({ kind: 'agent', agent: '', message: '' });
  });

  test('a trigger that is not an object is not replaced by an edit', () => {
    const bad = text({ ...FILE, trigger: '1h' });
    expect(readBuilder(bad)?.trigger?.kind).toBe('other');
    expect(setTrigger(bad, 'schedule', '2h')).toBe(bad);
    expect(setTrigger(bad, 'signal', 'go')).toBe(bad);
  });
});

describe('the summary', () => {
  test('says a bare number of waiting is milliseconds', () => {
    expect(readBuilder(text({ steps: [{ kind: 'sleep', duration: 5000 }] }))?.summary).toBe(
      'Sleep for 5000 ms',
    );
    expect(readBuilder(text({ steps: [{ kind: 'sleep', duration: '5s' }] }))?.summary).toBe(
      'Sleep for 5s',
    );
  });

  test('says an agent after a wait gets no result from before it, and an agent after a signal does not', () => {
    const agent = { kind: 'activity', handler: 'agent', input: { agent: 'a', message: 'm' } };
    const note = WORKFLOW_COPY.builder.afterWaitSummary;
    expect(
      readBuilder(text({ steps: [agent, { kind: 'sleep', duration: '1m' }, agent] }))?.summary,
    ).toBe(`Ask the agent a: m → Sleep for 1m → Ask the agent a: m ${note}`);
    expect(
      readBuilder(text({ steps: [agent, { kind: 'await-signal', signal: 's' }, agent] }))?.summary,
    ).not.toContain(note);
    expect(readBuilder(text({ steps: [agent, agent] }))?.summary).not.toContain(note);
  });
});
