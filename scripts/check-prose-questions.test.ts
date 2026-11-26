import { describe, expect, test } from 'bun:test';

import { decide, reason } from './check-prose-questions';

const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const toolResult = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
};
const assistant = (...blocks: object[]) => ({
  type: 'assistant',
  message: { role: 'assistant', content: blocks },
});
const text = (value: string) => ({ type: 'text', text: value });
const askTool = { type: 'tool_use', id: 'a', name: 'AskUserQuestion', input: {} };

const transcript = (...entries: object[]) =>
  entries.map((entry) => JSON.stringify(entry)).join('\n');
const run = (body: string, payload: object = {}) => decide(payload, body);

describe('check-prose-questions', () => {
  test('blocks a trailing "Want me to merge it?" with no AskUserQuestion', () => {
    const result = run(
      transcript(user('go'), assistant(text('Checks are green. Want me to merge it?'))),
    );
    expect(result).toEqual({ decision: 'block', reason });
  });

  test('blocks "needs your OK" buried at the end of a long status update', () => {
    const status = Array.from({ length: 30 }, (_, index) => `Step ${index} finished cleanly.`).join(
      '\n',
    );
    const result = run(
      transcript(user('go'), assistant(text(`${status}\n\nDeleting them needs your OK.`))),
    );
    expect(result?.decision).toBe('block');
  });

  test('allows the same text when an AskUserQuestion tool_use appears in the turn', () => {
    const result = run(
      transcript(
        user('go'),
        assistant(text('Want me to merge it?'), askTool),
        toolResult,
        assistant(text('Waiting.')),
      ),
    );
    expect(result).toBeUndefined();
  });

  test('allows a status-only turn', () => {
    const result = run(
      transcript(
        user('go'),
        assistant(text('## Done\n\nMerged the branch. Tests pass. What changed: the hook.')),
      ),
    );
    expect(result).toBeUndefined();
  });

  test('allows a question inside a code block or a > quote', () => {
    const body = 'Output:\n```\nWant me to merge it?\n```\n> Should I continue?\n\nAll done.';
    expect(run(transcript(user('go'), assistant(text(body))))).toBeUndefined();
  });

  test('ignores a rhetorical question in a heading', () => {
    expect(
      run(transcript(user('go'), assistant(text('## Which one failed?\n\nThe lint step.')))),
    ).toBeUndefined();
  });

  test('allows when stop_hook_active is true', () => {
    const body = transcript(user('go'), assistant(text('Want me to merge it?')));
    expect(run(body, { stop_hook_active: true })).toBeUndefined();
  });

  test('fails open on malformed transcript JSON', () => {
    expect(() => run('not json')).toThrow();
  });

  test('only reads text since the last genuine user message', () => {
    const result = run(
      transcript(
        user('first'),
        assistant(text('Should I delete it?')),
        user('no'),
        assistant(text('Okay, left it alone.')),
      ),
    );
    expect(result).toBeUndefined();
  });

  test('a tool result is not a user turn boundary', () => {
    const result = run(
      transcript(
        user('go'),
        assistant(text('Want me to merge it?')),
        toolResult,
        assistant(text('Done.')),
      ),
    );
    expect(result?.decision).toBe('block');
  });

  // P-COR-128: a leased chef coordinator is denied AskUserQuestion (scripts/chef/session-fences.ts),
  // and this hook demanded it, so the two contradicted each other. A leased session returns
  // needs-decision by ending its turn, so its prose question is allowed.
  test('allows a leased session to end its turn with a needs-decision question', () => {
    const body = transcript(
      user('go'),
      assistant(text('Needs decision: fold the install into the CI lane. Should I do that?')),
    );
    expect(decide({}, body, { leased: true })).toBeUndefined();
    expect(decide({}, body, { leased: false })?.decision).toBe('block');
    expect(reason).toContain('needs-decision');
  });

  test('blocks the real turn that triggered this hook', () => {
    const final =
      'Item 12 requires deleting the remote branches that the earlier runs left behind, and the review says that needs your OK.';
    const result = run(transcript(user('finish the list'), assistant(text(final))));
    expect(result?.decision).toBe('block');
  });
});
