/**
 * The builder's model: the file's text read as rows, and every edit as a new text. The text is the
 * only state, so each edit keeps the keys the builder has no control for, and the reverse (a text
 * typed in the JSON tab) is what `readBuilder` shows.
 */
import { describe, expect, test } from 'bun:test';

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
    for (const kind of ['agent', 'wait', 'signal'] as const) next = addStep(next, kind);
    expect(parsed(next)['steps']).toEqual([
      { kind: 'activity', handler: 'agent', input: { agent: 'assistant', message: '' } },
      { kind: 'sleep', duration: '1m' },
      { kind: 'await-signal', signal: '' },
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
