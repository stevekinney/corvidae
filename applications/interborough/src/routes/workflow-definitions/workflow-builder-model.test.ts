/**
 * The builder's model: the file's text read as fields and steps, and every edit as a new text. The
 * text is the only state, so each edit keeps the keys the builder has no control for, and the
 * reverse (a text typed in the JSON tab) is what `readBuilder` shows. Writing back what was read
 * returns the file byte for byte, a title never changes an existing workflow's ID, and every key
 * written is one the workflow file format accepts (COR-2009).
 */
import { describe, expect, test } from 'bun:test';

import {
  SHOWCASE_ORDER_REFUND_FILE,
  SHOWCASE_ORDER_REFUND_VALID_FILE,
  SHOWCASE_RELEASE_NOTES_FILE,
  SHOWCASE_TRIAGE_INBOX_FILE,
} from '../../../fixtures/showcase-content.ts';
import {
  addBranch,
  addCase,
  addOtherwise,
  addStep,
  forEachStep,
  identifierFromTitle,
  moveStep,
  readBuilder,
  removeBranch,
  removeCase,
  removeOtherwise,
  removeStep,
  ROOT_LIST,
  setBranchName,
  setCaseValue,
  setContributedTrigger,
  setDescription,
  setName,
  setSchema,
  setStepConcurrency,
  setStepField,
  setStepInput,
  setStepTimeout,
  setStepTitle,
  setTimeoutDuration,
  setTitle,
  setTitleDerivingName,
  setTrigger,
  setWaitDuration,
  waitPartsOf,
  type BuilderStep,
  type ListPath,
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

/**
 * Morning briefing as the board's JSON tab writes it (board PageWorkflowBuilder, "JSON tab"), by
 * hand and not as `JSON.stringify` spaces it: a title, a schedule trigger with its zone, a step
 * title on each step, a wait for a person, and a wait.
 */
const MORNING_BRIEFING = `{
  "name": "morning-briefing",
  "title": "Morning briefing",
  "description": "Summarizes yesterday, then waits for a person before posting it.",
  "trigger": { "kind": "schedule", "spec": "0 9 * * 1-5",
    "timezone": "America/Chicago", "overlap": "skip", "catchUp": false },
  "steps": [
    { "title": "Summarize yesterday", "kind": "activity", "handler": "agent",
      "input": { "agent": "assistant", "message": "Summarize what happened yesterday." } },
    { "title": "Review the briefing", "kind": "await-signal",
      "signal": "approve-briefing", "review": true },
    { "title": "Post the summary", "kind": "activity", "handler": "agent",
      "input": { "agent": "assistant", "message": "Post it." } },
    { "title": "Short pause", "kind": "sleep", "duration": "15m" }
  ]
}
`;

/** A manual workflow with a wait the builder cannot split into For and Unit, also by hand. */
const BY_HAND = `{"name":"by-hand","trigger":{"kind":"manual"},
"steps":[{"kind":"sleep","duration":60000},{"kind":"await-signal","signal":"go"}]}`;

/**
 * One of every kind of step the builder draws, by hand and not as `JSON.stringify` spaces it: an
 * activity whose input holds a `kind` of its own, a code workflow, a wait for a signal and one for a
 * person (each with its limit, one written as milliseconds), a branch with an otherwise path, side
 * by side steps, and a repeat that holds a branch.
 */
const EVERY_KIND = `{
  "name": "every-kind",
  "title": "Every kind",
  "trigger": { "kind": "manual" },
  "steps": [
    { "kind": "activity", "handler": "demo:echo-input", "input": { "text": "hi", "kind": "loud" } },
    { "kind": "workflow", "workflow": "demo:echo-workflow", "input": { "count": 1 } },
    { "kind": "await-signal", "signal": "go", "timeout": "2h" },
    { "kind": "await-signal", "signal": "review-1", "review": true, "timeout": 7200000 },
    { "kind": "branch", "on": "status",
      "cases": { "approved": [ { "kind": "sleep", "duration": "1m" } ], "rejected": [] },
      "otherwise": [ { "kind": "await-signal", "signal": "later" } ] },
    { "kind": "parallel", "branches": {
      "notify": [ { "kind": "activity", "handler": "agent",
        "input": { "agent": "assistant", "message": "Tell them." } } ],
      "log": [ { "kind": "sleep", "duration": "1s" } ] } },
    { "kind": "map", "over": "files", "concurrency": 2, "steps": [
      { "kind": "branch", "on": "ok", "cases": { "yes": [ { "kind": "sleep", "duration": 5 } ] } } ] }
  ]
}
`;

/** The valid files a person may open in the builder, each as the bytes on disk. */
const VALID_FILES: readonly { readonly id: string; readonly text: string }[] = [
  SHOWCASE_RELEASE_NOTES_FILE,
  SHOWCASE_TRIAGE_INBOX_FILE,
  SHOWCASE_ORDER_REFUND_VALID_FILE,
  { id: 'morning-briefing', text: MORNING_BRIEFING },
  { id: 'by-hand', text: BY_HAND },
  { id: 'every-kind', text: EVERY_KIND },
];

/** Reads `file` in the builder and writes every field it read back, as unchanged edits. */
function writeBack(file: string): string {
  const view = readBuilder(file);
  if (view === undefined) throw new Error('expected a file the builder can read');
  let next = setName(file, view.name);
  next = setTitle(next, view.title);
  next = setDescription(next, view.description);
  if (view.trigger?.kind === 'manual') next = setTrigger(next, 'manual');
  if (view.trigger?.kind === 'schedule') next = setTrigger(next, 'schedule', view.trigger.spec);
  if (view.trigger?.kind === 'signal') next = setTrigger(next, 'signal', view.trigger.name);
  next = writeSteps(next, view.steps, ROOT_LIST);
  for (const key of ['inputSchema', 'outputSchema'] as const) {
    const schema = view[key];
    if (schema.kind === 'schema') next = setSchema(next, key, schema.schema);
  }
  return next;
}

/** Writes every field of `steps`, and of the steps inside them, back as unchanged edits. */
function writeSteps(file: string, steps: readonly BuilderStep[], list: ListPath): string {
  let next = file;
  steps.forEach((step, index) => {
    const path = [...list, index];
    next = setStepTitle(next, path, step.title);
    if (step.kind === 'agent') {
      next = setStepField(next, path, 'agent', step.agent);
      next = setStepField(next, path, 'message', step.message);
    } else if (step.kind === 'person' || step.kind === 'signal') {
      next = setStepField(next, path, 'signal', step.signal);
      next = setStepTimeout(next, path, step.timeout?.duration ?? null);
    } else if (step.kind === 'wait') {
      next =
        step.parts === null
          ? setStepField(next, path, 'duration', step.duration)
          : setWaitDuration(next, path, step.parts.amount, step.parts.unit);
    } else if (step.kind === 'activity' || step.kind === 'workflow') {
      if (step.kind === 'workflow') next = setStepField(next, path, 'workflow', step.workflow);
      if (step.input !== null && Object.keys(step.input).length > 0) {
        next = setStepInput(next, path, step.input);
      }
    } else if (step.kind === 'branch') {
      next = setStepField(next, path, 'on', step.on);
      for (const entry of step.cases) {
        next = setCaseValue(next, path, entry.value, entry.value);
        next = writeSteps(next, entry.steps, [...path, 'cases', entry.value]);
      }
      if (step.otherwise !== null) {
        next = writeSteps(next, step.otherwise, [...path, 'otherwise']);
      }
    } else if (step.kind === 'parallel') {
      for (const entry of step.branches) {
        next = setBranchName(next, path, entry.name, entry.name);
        next = writeSteps(next, entry.steps, [...path, 'branches', entry.name]);
      }
    } else if (step.kind === 'map') {
      next = setStepField(next, path, 'over', step.over);
      next = setStepConcurrency(
        next,
        path,
        step.concurrency === '' ? null : Number(step.concurrency),
      );
      next = writeSteps(next, step.steps, [...path, 'steps']);
    }
  });
  return next;
}

describe('a file read and written back', () => {
  for (const file of VALID_FILES) {
    test(`is ${file.id} byte for byte, the keys the builder does not edit included`, () => {
      expect(writeBack(file.text)).toBe(file.text);
    });
  }

  test('keeps every other key, in its order, through one real edit', () => {
    const before = parsed(SHOWCASE_RELEASE_NOTES_FILE.text);
    const after = parsed(setStepTitle(SHOWCASE_RELEASE_NOTES_FILE.text, 3, 'Wait for sign-off'));
    expect(Object.keys(after)).toEqual(Object.keys(before));
    const steps = (value: Record<string, unknown>) => value['steps'] as Record<string, unknown>[];
    expect(steps(after)[3]).toEqual({ ...steps(before)[3], title: 'Wait for sign-off' });
    expect(Object.keys(steps(after)[3] ?? {})).toEqual(Object.keys(steps(before)[3] ?? {}));
    expect({ ...after, steps: [] }).toEqual({ ...before, steps: [] });
    expect(steps(after).slice(0, 3)).toEqual(steps(before).slice(0, 3));
  });

  test('leaves a file that is not JSON exactly as it is, whatever the edit', () => {
    const broken = SHOWCASE_ORDER_REFUND_FILE.text;
    expect(readBuilder(broken)).toBeUndefined();
    expect(setName(broken, 'other')).toBe(broken);
    expect(setTitle(broken, 'Order refund')).toBe(broken);
    expect(setTitleDerivingName(broken, 'Order refund')).toBe(broken);
    expect(setDescription(broken, 'x')).toBe(broken);
    expect(setTrigger(broken, 'manual')).toBe(broken);
    expect(addStep(broken, 'person')).toBe(broken);
    expect(setStepTitle(broken, 0, 'x')).toBe(broken);
    expect(setWaitDuration(broken, 0, '5', 'minutes')).toBe(broken);
    expect(setSchema(broken, 'inputSchema', { type: 'object' })).toBe(broken);
  });
});

describe('the title and the ID', () => {
  test('a title never changes an existing workflow’s ID', () => {
    for (const file of VALID_FILES) {
      const retitled = parsed(setTitle(file.text, 'Something else entirely'));
      expect(retitled['name']).toBe(file.id);
      expect(retitled['title']).toBe('Something else entirely');
    }
  });

  test('a title is written after the name, and removed rather than written blank', () => {
    const titled = parsed(setTitle(text(), 'Daily digest'));
    expect(Object.keys(titled).slice(0, 2)).toEqual(['name', 'title']);
    expect(parsed(setTitle(text({ ...FILE, title: 'Old' }), '   '))).not.toHaveProperty('title');
    expect(setTitle(text(), '')).toBe(text());
  });

  test('a new workflow’s ID is made from its title, capitals and all', () => {
    const fresh = text({ name: '', trigger: { kind: 'manual' }, steps: [] });
    const titled = parsed(setTitleDerivingName(fresh, 'Morning Briefing'));
    expect(titled).toMatchObject({ name: 'morning-briefing', title: 'Morning Briefing' });
  });

  test('the ID follows a title it was made from, and keeps one that was typed', () => {
    const made = text({ name: 'morning-briefing', title: 'Morning briefing', steps: [] });
    expect(parsed(setTitleDerivingName(made, 'Evening briefing'))['name']).toBe('evening-briefing');
    const typed = text({ name: 'my-own-id', title: 'Morning briefing', steps: [] });
    expect(parsed(setTitleDerivingName(typed, 'Evening briefing'))['name']).toBe('my-own-id');
    const untitled = text({ name: 'typed-first', steps: [] });
    expect(parsed(setTitleDerivingName(untitled, 'A title'))['name']).toBe('typed-first');
  });

  test('a title with no letter leaves the ID to be typed', () => {
    const fresh = text({ name: '', steps: [] });
    expect(parsed(setTitleDerivingName(fresh, '2024!'))['name']).toBe('');
  });

  test('clearing a title the ID followed empties the ID, so the next title makes it afresh', () => {
    const made = text({ name: 'morning-briefing', title: 'Morning briefing', steps: [] });
    const cleared = setTitleDerivingName(made, '');
    expect(parsed(cleared)).toEqual({ name: '', steps: [] });
    expect(parsed(setTitleDerivingName(cleared, 'Evening briefing'))).toMatchObject({
      name: 'evening-briefing',
      title: 'Evening briefing',
    });
  });

  test('identifierFromTitle makes an identifier the Bureau accepts', () => {
    expect(identifierFromTitle('Morning Briefing')).toBe('morning-briefing');
    expect(identifierFromTitle('Release notes')).toBe('release-notes');
    expect(identifierFromTitle('Café, déjà vu!')).toBe('cafe-deja-vu');
    expect(identifierFromTitle('2024 Report')).toBe('report');
    expect(identifierFromTitle('  --  ')).toBe('');
    expect(identifierFromTitle(`${'a'.repeat(63)} bcd`)).toBe('a'.repeat(63));
    for (const title of ['Morning Briefing', 'A  B  C', 'x', 'Über-Report 9', 'z'.repeat(80)]) {
      const identifier = identifierFromTitle(title);
      expect(identifier).toMatch(/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/);
      expect(identifier.length).toBeLessThanOrEqual(64);
    }
  });

  test('setName sets the name where the file has it, and leads with it otherwise', () => {
    const next = parsed(setName(text({ ...FILE, name: undefined }), 'fresh'));
    expect(Object.keys(next)[0]).toBe('name');
    expect(next).toMatchObject({ name: 'fresh', paused: true, inputSchema: { type: 'object' } });
    const later = parsed(setName(text({ paused: true, name: 'old' }), 'new-name'));
    expect(Object.keys(later)).toEqual(['paused', 'name']);
  });
});

describe('readBuilder', () => {
  test('reads the name, title, description, trigger and each kind of step', () => {
    const view = readBuilder(MORNING_BRIEFING);
    expect(view).toMatchObject({
      name: 'morning-briefing',
      title: 'Morning briefing',
      description: 'Summarizes yesterday, then waits for a person before posting it.',
      trigger: { kind: 'schedule', spec: '0 9 * * 1-5' },
      steps: [
        {
          kind: 'agent',
          agent: 'assistant',
          message: 'Summarize what happened yesterday.',
          title: 'Summarize yesterday',
        },
        { kind: 'person', signal: 'approve-briefing', title: 'Review the briefing' },
        { kind: 'agent', agent: 'assistant', message: 'Post it.', title: 'Post the summary' },
        {
          kind: 'wait',
          duration: '15m',
          parts: { amount: '15', unit: 'minutes' },
          title: 'Short pause',
        },
      ],
      inputSchema: { kind: 'none' },
      outputSchema: { kind: 'none' },
    });
  });

  test('tells a wait for a person from a wait for a signal by review: true alone', () => {
    const view = readBuilder(SHOWCASE_RELEASE_NOTES_FILE.text);
    expect(view?.steps[3]).toEqual({
      kind: 'signal',
      signal: 'notes-approved',
      timeout: null,
      title: 'Wait for approval',
    });
    expect(readBuilder(SHOWCASE_ORDER_REFUND_VALID_FILE.text)?.steps[1]?.kind).toBe('person');
  });

  test('reads a manual trigger, and the Input and Output schemas', () => {
    expect(readBuilder(BY_HAND)?.trigger).toEqual({ kind: 'manual' });
    const view = readBuilder(SHOWCASE_RELEASE_NOTES_FILE.text);
    expect(view?.inputSchema).toMatchObject({ kind: 'schema', schema: { required: ['branch'] } });
    expect(view?.outputSchema).toMatchObject({ kind: 'schema', schema: { required: ['notes'] } });
    expect(readBuilder(text({ ...FILE, outputSchema: 'text' }))?.outputSchema).toEqual({
      kind: 'unreadable',
    });
  });

  test('shows a step it has no control for as a label, and a trigger it does not know', () => {
    const view = readBuilder(
      text({
        trigger: { kind: 'webhook' },
        steps: [{ kind: 'activity', handler: '' }, { kind: 'banana' }, 5],
      }),
    );
    expect(view?.trigger).toEqual({ kind: 'other', label: 'A webhook trigger' });
    expect(view?.steps[0]?.kind).toBe('other');
    expect(view?.steps[1]?.kind).toBe('other');
    expect(view?.steps[2]?.kind).toBe('other');
  });

  test('reads an activity a plugin provides by its handler, and its input as an object or as left to the JSON tab', () => {
    const view = readBuilder(
      text({
        steps: [
          { kind: 'activity', handler: 'demo:echo-input', input: { text: 'hi' } },
          { kind: 'activity', handler: 'demo:echo-input' },
          { kind: 'activity', handler: 'demo:echo-input', input: 'not an object' },
        ],
      }),
    );
    expect(view?.steps).toEqual([
      { kind: 'activity', handler: 'demo:echo-input', input: { text: 'hi' }, title: '' },
      { kind: 'activity', handler: 'demo:echo-input', input: {}, title: '' },
      { kind: 'activity', handler: 'demo:echo-input', input: null, title: '' },
    ]);
  });

  test('reads a file with no trigger or steps as empty, and a wait in milliseconds as written', () => {
    expect(readBuilder('{}')).toMatchObject({ trigger: null, steps: [] });
    expect(readBuilder(text({ steps: [{ kind: 'sleep', duration: 60000 }] }))?.steps).toEqual([
      { kind: 'wait', duration: '60000', parts: null, title: '' },
    ]);
  });

  test('has nothing to read for text that is not JSON or not an object', () => {
    expect(readBuilder('{ not json')).toBeUndefined();
    expect(readBuilder('[]')).toBeUndefined();
    expect(readBuilder('7')).toBeUndefined();
  });
});

describe('the edits', () => {
  test('setDescription sets it, and removes the key when it is emptied', () => {
    expect(parsed(setDescription(text(), 'New.'))['description']).toBe('New.');
    expect(parsed(setDescription(text(), ''))).not.toHaveProperty('description');
  });

  test('setTrigger keeps a schedule’s other keys while its spec changes, and replaces the trigger when the kind does', () => {
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

  test('a manual trigger is written as its kind and nothing else', () => {
    expect(parsed(setTrigger(text(), 'manual'))['trigger']).toEqual({ kind: 'manual' });
    expect(parsed(setTrigger(text({ name: 'x', steps: [] }), 'manual', 'ignored'))).toEqual({
      name: 'x',
      trigger: { kind: 'manual' },
      steps: [],
    });
  });

  test('addStep appends each kind of step, naming no agent unless told one', () => {
    let next = text({ trigger: FILE.trigger, steps: [] });
    for (const kind of ['agent', 'person', 'signal', 'wait'] as const) next = addStep(next, kind);
    expect(parsed(next)['steps']).toEqual([
      { kind: 'activity', handler: 'agent', input: { agent: '', message: '' } },
      { kind: 'await-signal', signal: expect.stringMatching(/^review-[0-9a-f]{8}$/), review: true },
      { kind: 'await-signal', signal: '' },
      { kind: 'sleep', duration: '1m' },
    ]);
    expect(parsed(addStep('{}', 'agent', { agent: 'notes' }))['steps']).toEqual([
      { kind: 'activity', handler: 'agent', input: { agent: 'notes', message: '' } },
    ]);
  });

  test('two waits for a person never share a signal, so a signal sent by name resumes only one', () => {
    const once = addStep('{}', 'person');
    const twice = parsed(addStep(once, 'person'))['steps'] as { signal: string }[];
    expect(twice[0]?.signal).not.toBe(twice[1]?.signal);
  });

  test('a wait for a person waits on a signal no other step or the trigger uses, and keeps it', () => {
    const taken = text({
      trigger: { kind: 'signal', name: 'review-x-2' },
      steps: [{ kind: 'await-signal', signal: 'review-x', review: true }],
    });
    const added = addStep(taken, 'person', { reviewSignal: 'review-x' });
    expect((parsed(added)['steps'] as Record<string, unknown>[])[1]).toEqual({
      kind: 'await-signal',
      signal: 'review-x-3',
      review: true,
    });
    // Renaming and moving never change it: a changed signal is a breaking change.
    const renamed = moveStep(setStepTitle(added, 1, 'Approve it'), 1, -1);
    expect((parsed(renamed)['steps'] as Record<string, unknown>[])[0]).toEqual({
      title: 'Approve it',
      kind: 'await-signal',
      signal: 'review-x-3',
      review: true,
    });
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

  test('setStepTitle leads the step with its title, edits it in place, and removes it when blank', () => {
    const titled = parsed(setStepTitle(text(), 1, 'Short pause'));
    const step = (titled['steps'] as Record<string, unknown>[])[1] ?? {};
    expect(Object.keys(step)).toEqual(['title', 'kind', 'duration']);
    const renamed = parsed(setStepTitle(JSON.stringify(titled), 1, 'Long pause'));
    expect((renamed['steps'] as Record<string, unknown>[])[1]).toEqual({
      title: 'Long pause',
      kind: 'sleep',
      duration: '1m',
    });
    const cleared = parsed(setStepTitle(JSON.stringify(titled), 1, ' '));
    expect((cleared['steps'] as Record<string, unknown>[])[1]).toEqual({
      kind: 'sleep',
      duration: '1m',
    });
    expect(setStepTitle(text(), 9, 'x')).toBe(text());
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

  test('a wait is For a number of a Unit, written as a Weft duration', () => {
    expect(waitPartsOf('15m')).toEqual({ amount: '15', unit: 'minutes' });
    expect(waitPartsOf('2 hours')).toEqual({ amount: '2', unit: 'hours' });
    expect(waitPartsOf('30s')).toEqual({ amount: '30', unit: 'seconds' });
    expect(waitPartsOf('')).toEqual({ amount: '', unit: 'minutes' });
    expect(waitPartsOf('1.5h')).toBeNull();
    expect(waitPartsOf('250ms')).toBeNull();
    const steps = (value: string) => parsed(value)['steps'] as Record<string, unknown>[];
    expect(steps(setWaitDuration(text(), 1, '15', 'minutes'))[1]?.['duration']).toBe('15m');
    expect(steps(setWaitDuration(text(), 1, '2', 'days'))[1]?.['duration']).toBe('2d');
    expect(steps(setWaitDuration(text(), 1, '', 'hours'))[1]?.['duration']).toBe('h');
    expect(waitPartsOf('h')).toEqual({ amount: '', unit: 'hours' });
    expect(waitPartsOf('days')).toEqual({ amount: '', unit: 'days' });
    expect(waitPartsOf('ms')).toBeNull();
  });

  test('a wait keeps its unit while For is empty: cleared and retyped, or a unit chosen first', () => {
    const waitOf = (value: string) => {
      const step = readBuilder(value)?.steps[1];
      if (step?.kind !== 'wait' || step.parts === null)
        throw new Error('expected a For and Unit wait');
      return step.parts;
    };
    const steps = (value: string) => parsed(value)['steps'] as Record<string, unknown>[];

    // Two hours, then For cleared to type a new number: Unit stays hours, and 3 is 3 hours.
    const twoHours = setWaitDuration(text(), 1, '2', 'hours');
    const cleared = setWaitDuration(twoHours, 1, '', waitOf(twoHours).unit);
    expect(waitOf(cleared)).toEqual({ amount: '', unit: 'hours' });
    const retyped = setWaitDuration(cleared, 1, '3', waitOf(cleared).unit);
    expect(steps(retyped)[1]?.['duration']).toBe('3h');

    // A unit chosen while For is empty is kept, and the number typed next is of that unit.
    const days = setWaitDuration(cleared, 1, waitOf(cleared).amount, 'days');
    expect(days).not.toBe(cleared);
    expect(waitOf(days)).toEqual({ amount: '', unit: 'days' });
    expect(steps(setWaitDuration(days, 1, '4', waitOf(days).unit))[1]?.['duration']).toBe('4d');
  });

  test('setSchema writes a schema in the file format’s place, and removes it', () => {
    const plain = text({ name: 'x', trigger: { kind: 'manual' }, steps: [] });
    const withOutput = parsed(setSchema(plain, 'outputSchema', { type: 'object' }));
    expect(Object.keys(withOutput)).toEqual(['name', 'trigger', 'outputSchema', 'steps']);
    const withBoth = parsed(
      setSchema(JSON.stringify(withOutput), 'inputSchema', { type: 'object', required: ['a'] }),
    );
    expect(Object.keys(withBoth)).toEqual([
      'name',
      'trigger',
      'inputSchema',
      'outputSchema',
      'steps',
    ]);
    expect(
      parsed(setSchema(JSON.stringify(withBoth), 'inputSchema', undefined)),
    ).not.toHaveProperty('inputSchema');
  });

  test('setSchema leaves a schema that is not an object to the JSON tab', () => {
    const bad = text({ ...FILE, inputSchema: 'text' });
    expect(setSchema(bad, 'inputSchema', { type: 'object' })).toBe(bad);
  });

  test('every edit returns text that is not JSON, or not an object, unchanged', () => {
    for (const bad of ['{ nope', '[]']) {
      expect(setName(bad, 'a')).toBe(bad);
      expect(setTitle(bad, 'a')).toBe(bad);
      expect(setDescription(bad, 'a')).toBe(bad);
      expect(setTrigger(bad, 'signal', 'a')).toBe(bad);
      expect(addStep(bad, 'agent')).toBe(bad);
      expect(removeStep(bad, 0)).toBe(bad);
      expect(moveStep(bad, 0, 1)).toBe(bad);
      expect(setStepField(bad, 0, 'agent', 'a')).toBe(bad);
      expect(setStepTitle(bad, 0, 'a')).toBe(bad);
    }
  });

  test('a builder edit is what the JSON holds, and a JSON edit is what the builder reads', () => {
    const built = addStep(text({ trigger: { kind: 'signal', name: 'go' }, steps: [] }), 'signal');
    const typed = built.replace('"signal": ""', '"signal": "typed-in-json"');
    expect(readBuilder(typed)?.steps).toEqual([
      { kind: 'signal', signal: 'typed-in-json', timeout: null, title: '' },
    ]);
    expect(readBuilder(setStepField(typed, 0, 'signal', 'back'))?.steps).toEqual([
      { kind: 'signal', signal: 'back', timeout: null, title: '' },
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
    for (const kind of ['agent', 'person', 'signal', 'wait'] as const) {
      expect(addStep(bad, kind)).toBe(bad);
    }
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
    expect(readBuilder(none)?.steps[0]).toEqual({
      kind: 'agent',
      agent: '',
      message: '',
      title: '',
    });
  });

  test('a trigger that is not an object is not replaced by an edit', () => {
    const bad = text({ ...FILE, trigger: '1h' });
    expect(readBuilder(bad)?.trigger?.kind).toBe('other');
    expect(setTrigger(bad, 'schedule', '2h')).toBe(bad);
    expect(setTrigger(bad, 'signal', 'go')).toBe(bad);
    expect(setTrigger(bad, 'manual')).toBe(bad);
  });
});

describe('a trigger a plugin contributes', () => {
  const text = (trigger: unknown) => JSON.stringify({ ...FILE, trigger });

  test('is read as its kind and the rest of the trigger as its configuration', () => {
    expect(
      readBuilder(text({ kind: 'inbox:message', mailbox: 'support', unreadOnly: true }))?.trigger,
    ).toEqual({
      kind: 'contributed',
      id: 'inbox:message',
      configuration: { mailbox: 'support', unreadOnly: true },
    });
  });

  test('is told from a kind that is not plugin:name, which only the JSON tab edits', () => {
    expect(readBuilder(text({ kind: 'webhook' }))?.trigger?.kind).toBe('other');
    expect(readBuilder(text({ kind: 'Inbox:Message' }))?.trigger?.kind).toBe('other');
  });

  test('is written as the kind and its fields, replacing the trigger before it', () => {
    const written = JSON.parse(
      setContributedTrigger(text({ kind: 'schedule', spec: '1h' }), 'inbox:message', {
        mailbox: 'support',
      }),
    ) as Record<string, unknown>;
    expect(written['trigger']).toEqual({ kind: 'inbox:message', mailbox: 'support' });
    expect(written['name']).toBe('digest');
  });

  test('cannot be given a kind by its configuration', () => {
    const written = JSON.parse(
      setContributedTrigger(text(undefined), 'inbox:message', { kind: 'schedule', mailbox: 'a' }),
    ) as Record<string, unknown>;
    expect(written['trigger']).toEqual({ kind: 'inbox:message', mailbox: 'a' });
  });

  test('leaves a trigger that is not an object alone, as setTrigger does', () => {
    const before = text('nope');
    expect(setContributedTrigger(before, 'inbox:message', {})).toBe(before);
  });
});

/** The steps of `value`'s document, as plain data. */
const stepsIn = (value: string): Record<string, unknown>[] =>
  parsed(value)['steps'] as Record<string, unknown>[];

describe('a plugin activity, a code workflow and the control-flow kinds', () => {
  const BASE = text({
    name: 'flow',
    trigger: { kind: 'manual' },
    steps: [{ kind: 'sleep', duration: '1m' }],
  });

  test('are added as the shapes the engine reads, the three containers with the one list they need', () => {
    expect(
      stepsIn(
        addStep(BASE, 'activity', { handler: 'demo:echo-input', input: { text: '', loud: false } }),
      )[1],
    ).toEqual({ kind: 'activity', handler: 'demo:echo-input', input: { text: '', loud: false } });
    expect(stepsIn(addStep(BASE, 'activity', { handler: 'demo:echo-input' }))[1]).toEqual({
      kind: 'activity',
      handler: 'demo:echo-input',
    });
    expect(stepsIn(addStep(BASE, 'workflow', { workflow: 'demo:echo-workflow' }))[1]).toEqual({
      kind: 'workflow',
      workflow: 'demo:echo-workflow',
    });
    expect(stepsIn(addStep(BASE, 'branch'))[1]).toEqual({
      kind: 'branch',
      on: '',
      cases: { 'value-1': [] },
    });
    expect(stepsIn(addStep(BASE, 'parallel'))[1]).toEqual({
      kind: 'parallel',
      branches: { 'branch-1': [] },
    });
    expect(stepsIn(addStep(BASE, 'map'))[1]).toEqual({ kind: 'map', over: '', steps: [] });
  });

  test('read as the cards draw them, a container with its lists and a malformed one as a step to leave to the JSON tab', () => {
    const view = readBuilder(
      text({
        steps: [
          {
            kind: 'branch',
            on: 'status',
            cases: { approved: [{ kind: 'sleep', duration: '1m' }], rejected: [] },
            otherwise: [],
          },
          { kind: 'parallel', branches: { a: [], b: [{ kind: 'await-signal', signal: 's' }] } },
          { kind: 'map', over: 'files', concurrency: 2, steps: [] },
          { kind: 'branch', on: 'x', cases: 'nope' },
          { kind: 'map', over: 'x', steps: 'nope' },
          { kind: 'parallel', branches: { a: 'nope' } },
          { kind: 'await-signal', signal: 'go', timeout: { not: 'a duration' } },
        ],
      }),
    );
    expect(view?.steps.map((step) => step.kind)).toEqual([
      'branch',
      'parallel',
      'map',
      'other',
      'other',
      'other',
      'other',
    ]);
    const [branch, parallel, map] = view?.steps ?? [];
    expect(branch).toMatchObject({
      on: 'status',
      cases: [
        { value: 'approved', steps: [{ kind: 'wait' }] },
        { value: 'rejected', steps: [] },
      ],
      otherwise: [],
    });
    expect(parallel).toMatchObject({ branches: [{ name: 'a' }, { name: 'b' }] });
    expect(map).toMatchObject({ over: 'files', concurrency: '2', steps: [] });
  });

  test('add into a nested list, and a new review signal never repeats one a nested step already waits on', () => {
    const nested = text({
      steps: [
        {
          kind: 'branch',
          on: 'x',
          cases: { a: [{ kind: 'await-signal', signal: 'review-fixed' }] },
        },
      ],
    });
    const added = addStep(nested, 'person', {
      into: ['steps', 0, 'cases', 'a'],
      reviewSignal: 'review-fixed',
    });
    const inside = (stepsIn(added)[0] as { cases: { a: { signal: string }[] } }).cases.a;
    expect(inside.map((step) => step.signal)).toEqual(['review-fixed', 'review-fixed-2']);
    expect(addStep(nested, 'wait', { into: ['steps', 0, 'cases', 'missing'] })).toBe(nested);
    expect(addStep(nested, 'wait', { into: ['steps', 5, 'steps'] })).toBe(nested);
  });

  test('every edit reaches a nested step by its path, and nothing else in the file moves', () => {
    const base = text({
      name: 'flow',
      trigger: { kind: 'manual' },
      steps: [
        {
          kind: 'map',
          over: 'files',
          steps: [
            { kind: 'await-signal', signal: 'a', note: 'kept' },
            { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'm' } },
          ],
        },
      ],
    });
    const path = ['steps', 0, 'steps', 0] as const;
    const edited = setStepField(setStepTitle(base, path, 'Named'), path, 'signal', 'b');
    expect(stepsIn(edited)[0]).toEqual({
      kind: 'map',
      over: 'files',
      steps: [
        { title: 'Named', kind: 'await-signal', signal: 'b', note: 'kept' },
        { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'm' } },
      ],
    });
    const moved = moveStep(base, path, 1);
    expect(
      (stepsIn(moved)[0] as { steps: { kind: string }[] }).steps.map((step) => step.kind),
    ).toEqual(['activity', 'await-signal']);
    expect(moveStep(base, path, -1)).toBe(base);
    const removed = removeStep(base, ['steps', 0, 'steps', 1]);
    expect((stepsIn(removed)[0] as { steps: unknown[] }).steps).toHaveLength(1);
    expect(removeStep(base, ['steps', 0, 'steps', 9])).toBe(base);
    // A top-level step is still its own index.
    expect(setStepField(base, 0, 'over', 'rows')).toContain('"over": "rows"');
    expect(setStepField(base, path, 'over', 'rows')).toBe(base);
  });

  test('a step with no timeout writes none, a limit writes one, and clearing it removes the key', () => {
    const waiting = text({ steps: [{ kind: 'await-signal', signal: 'go' }] });
    expect(stepsIn(waiting)[0]).not.toHaveProperty('timeout');
    const limited = setTimeoutDuration(waiting, 0, '2', 'hours');
    expect(stepsIn(limited)[0]).toEqual({ kind: 'await-signal', signal: 'go', timeout: '2h' });
    expect(readBuilder(limited)?.steps[0]).toMatchObject({
      timeout: { duration: '2h', parts: { amount: '2', unit: 'hours' } },
    });
    expect(stepsIn(setTimeoutDuration(limited, 0, '', 'hours'))[0]).toEqual({
      kind: 'await-signal',
      signal: 'go',
    });
    expect(stepsIn(setStepTimeout(limited, 0, null))[0]).not.toHaveProperty('timeout');
    // A bare number is milliseconds, as a wait's is; no other kind of step takes a limit.
    expect(stepsIn(setStepTimeout(waiting, 0, '60000'))[0]?.['timeout']).toBe(60000);
    const sleeping = text({ steps: [{ kind: 'sleep', duration: '1m' }] });
    expect(setStepTimeout(sleeping, 0, '5m')).toBe(sleeping);
  });

  test('concurrency is a positive whole number or no key', () => {
    const repeating = text({ steps: [{ kind: 'map', over: 'files', steps: [] }] });
    expect(stepsIn(setStepConcurrency(repeating, 0, 3))[0]?.['concurrency']).toBe(3);
    const limited = setStepConcurrency(repeating, 0, 3);
    for (const bad of [null, 0, -1, 1.5]) {
      expect(stepsIn(setStepConcurrency(limited, 0, bad))[0]).not.toHaveProperty('concurrency');
    }
    const other = text({ steps: [{ kind: 'sleep', duration: '1m' }] });
    expect(setStepConcurrency(other, 0, 2)).toBe(other);
  });

  test('cases and lists are added, renamed in place, never merged or emptied, and removed with their steps', () => {
    const branching = text({
      steps: [
        {
          kind: 'branch',
          on: 'status',
          cases: { approved: [{ kind: 'sleep', duration: '1m' }], rejected: [] },
        },
        { kind: 'parallel', branches: { a: [], b: [] } },
      ],
    });
    const keysOf = (value: string, index: number, container: 'cases' | 'branches') =>
      Object.keys((stepsIn(value)[index] as Record<string, object>)[container] ?? {});
    const added = addCase(branching, 0);
    expect(keysOf(added, 0, 'cases')).toEqual(['approved', 'rejected', 'value-1']);
    expect(keysOf(addCase(added, 0), 0, 'cases')).toContain('value-2');
    expect(keysOf(setCaseValue(added, 0, 'approved', 'ok'), 0, 'cases')).toEqual([
      'ok',
      'rejected',
      'value-1',
    ]);
    expect(setCaseValue(added, 0, 'approved', 'rejected')).toBe(added);
    expect(setCaseValue(added, 0, 'approved', '')).toBe(added);
    expect(setCaseValue(added, 0, 'missing', 'x')).toBe(added);
    expect(setCaseValue(added, 0, 'approved', 'approved')).toBe(added);
    expect(keysOf(removeCase(added, 0, 'approved'), 0, 'cases')).toEqual(['rejected', 'value-1']);

    expect(keysOf(addBranch(branching, 1), 1, 'branches')).toEqual(['a', 'b', 'branch-1']);
    expect(keysOf(setBranchName(branching, 1, 'a', 'first'), 1, 'branches')).toEqual([
      'first',
      'b',
    ]);
    expect(setBranchName(branching, 1, 'a', 'b')).toBe(branching);
    expect(keysOf(removeBranch(branching, 1, 'a'), 1, 'branches')).toEqual(['b']);
    // A kind's own containers only: a case on a parallel and a branch on a branch change nothing.
    expect(addCase(branching, 1)).toBe(branching);
    expect(addBranch(branching, 0)).toBe(branching);
  });

  test('otherwise is added empty once and removed with its steps', () => {
    const branching = text({
      steps: [
        { kind: 'branch', on: 'x', cases: { a: [] } },
        { kind: 'sleep', duration: '1m' },
      ],
    });
    const withOtherwise = addOtherwise(branching, 0);
    expect(stepsIn(withOtherwise)[0]).toMatchObject({ otherwise: [] });
    expect(addOtherwise(withOtherwise, 0)).toBe(withOtherwise);
    expect(stepsIn(removeOtherwise(withOtherwise, 0))[0]).not.toHaveProperty('otherwise');
    expect(removeOtherwise(branching, 0)).toBe(branching);
    expect(addOtherwise(branching, 1)).toBe(branching);
  });

  test('an input is written as the form reported it, with the keys the schema does not name kept, and `kind` is only a key', () => {
    const file = text({
      steps: [
        {
          kind: 'activity',
          handler: 'demo:echo-input',
          input: { text: 'old', gone: true, kind: 'shout', extra: 1 },
        },
        { kind: 'activity', handler: 'agent', input: { agent: 'a', message: 'm' } },
        { kind: 'activity', handler: 'demo:echo-input', input: 'not an object' },
      ],
    });
    const schema = { type: 'object', properties: { text: {}, gone: {} } };
    const edited = setStepInput(file, 0, { text: 'new' }, schema);
    // `gone` was named by the schema and the form left it out, so it is removed; the rest stay.
    expect(stepsIn(edited)[0]?.['input']).toEqual({ kind: 'shout', extra: 1, text: 'new' });
    // Without a schema that names fields the form's draft is the whole input.
    expect(stepsIn(setStepInput(file, 0, { only: 1 }))[0]?.['input']).toEqual({ only: 1 });
    // An agent step has fields of its own, and an input that is not an object is the JSON tab's.
    expect(setStepInput(file, 1, { agent: 'b' }, schema)).toBe(file);
    expect(setStepInput(file, 2, { text: 'x' }, schema)).toBe(file);
  });

  test('a file with every kind is lossless: edits and their undoes leave the document as it was', () => {
    const original = parsed(EVERY_KIND);
    let next = addStep(EVERY_KIND, 'wait', { into: ['steps', 4, 'cases', 'approved'] });
    next = removeStep(next, ['steps', 4, 'cases', 'approved', 1]);
    next = setTimeoutDuration(next, 2, '', 'hours');
    next = setTimeoutDuration(next, 2, '2', 'hours');
    const notify = ['steps', 5, 'branches', 'notify', 0] as const;
    next = moveStep(moveStep(next, notify, 1), notify, -1);
    next = setStepConcurrency(setStepConcurrency(next, 6, null), 6, 2);
    expect(parsed(next)).toEqual(original);
  });

  test('visits every step at every depth, parents before the steps they hold', () => {
    const kinds: string[] = [];
    forEachStep(readBuilder(EVERY_KIND)?.steps ?? [], (step) => kinds.push(step.kind));
    expect(kinds).toEqual([
      'activity',
      'workflow',
      'signal',
      'person',
      'branch',
      'wait',
      'signal',
      'parallel',
      'agent',
      'wait',
      'map',
      'branch',
      'wait',
    ]);
  });
});
