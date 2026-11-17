import { describe, expect, it } from 'bun:test';

import {
  applyLabel,
  canApply,
  changedCount,
  checkHashOffer,
  definitionFromCanonicalText,
  isProposalResult,
  isResult,
  isWorkflow,
  revisionRows,
  statusText,
  statusVariant,
  structured,
  structuredResult,
  valueText,
  type Definition,
  type RevisionState,
} from './model.ts';

const current: Definition = {
  title: 'Nightly',
  agent: 'worker',
  trigger: { kind: 'schedule', cron: '0 2 * * *' },
  steps: [{ id: 'one', run: 'a' }],
};

describe('the comparison rows', () => {
  it('names each field, the trigger and each step, and says how each differs', () => {
    const proposed: Definition = {
      title: 'Nightly',
      description: 'New words',
      trigger: { kind: 'schedule', cron: '0 3 * * *' },
      steps: [
        { id: 'one', run: 'a' },
        { id: 'two', run: 'b' },
      ],
    };
    const rows = revisionRows(current, proposed);
    expect(rows.map((row) => row.label)).toEqual([
      'title',
      'description',
      'agent',
      'paused',
      'inputSchema',
      'outputSchema',
      'Trigger',
      'Step 1',
      'Step 2',
    ]);
    const states = Object.fromEntries(rows.map((row) => [row.label, row.state]));
    expect(states).toEqual({
      title: 'unchanged',
      description: 'added',
      agent: 'removed',
      paused: 'unchanged',
      inputSchema: 'unchanged',
      outputSchema: 'unchanged',
      Trigger: 'changed',
      'Step 1': 'unchanged',
      'Step 2': 'added',
    });
    expect(changedCount(rows)).toBe(4);
    const agent = rows.find((row) => row.label === 'agent')!;
    expect(agent.marker).toBe('Removed');
    expect(agent.current).toBe('worker');
    expect(agent.proposed).toBe('None');
    expect(rows.find((row) => row.label === 'Trigger')!.proposed).toContain('"0 3 * * *"');
  });

  it('counts none when the definitions are the same', () => {
    expect(changedCount(revisionRows(current, current))).toBe(0);
  });

  it('shows absence in words and structure as indented JSON', () => {
    expect(valueText(undefined)).toBe('Not present');
    expect(valueText(null)).toBe('None');
    expect(valueText('text')).toBe('text');
    expect(valueText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe('reading a definition and the host’s answers', () => {
  it('takes the definition out of a workflow’s canonical text, without its name', () => {
    const text = JSON.stringify({ name: 'nightly', ...current });
    const definition = definitionFromCanonicalText(text);
    expect(definition).toEqual(current);
    expect(definition).not.toHaveProperty('name');
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['no trigger', JSON.stringify({ steps: [] })],
    ['no steps', JSON.stringify({ trigger: {} })],
    ['a step that is not an object', JSON.stringify({ trigger: {}, steps: [1] })],
  ])('refuses text that is %s', (_name, text) => {
    expect(definitionFromCanonicalText(text)).toBeUndefined();
  });

  it('reads structured content, a JSON string of it, or the first text block as JSON', () => {
    expect(structuredResult({ structuredContent: { a: 1 } })).toEqual({ a: 1 });
    expect(structuredResult({ structuredContent: '{"a":2}' })).toEqual({ a: 2 });
    expect(structuredResult({ structuredContent: '{' })).toBeUndefined();
    expect(structuredResult({ content: [{ type: 'text', text: '{"a":3}' }] })).toEqual({ a: 3 });
    expect(structuredResult({ content: [{ type: 'text', text: 'no' }] })).toBeUndefined();
    expect(structuredResult({ content: [{ type: 'image' }] })).toBeUndefined();
    expect(structuredResult({})).toBeUndefined();
  });

  it('answers only what the guard accepts, and nothing for an error result', () => {
    const workflow = { id: 'w', hash: 'h', text: '{}' };
    expect(structured({ structuredContent: workflow }, isWorkflow)).toEqual(workflow);
    expect(structured({ structuredContent: workflow, isError: true }, isWorkflow)).toBeUndefined();
    expect(structured({ structuredContent: { id: 'w' } }, isWorkflow)).toBeUndefined();
  });

  it('recognizes an update outcome and a proposal', () => {
    expect(isResult({ status: 'conflict' })).toBe(true);
    expect(isResult({ hash: 'h' })).toBe(true);
    expect(isResult({})).toBe(false);
    expect(isResult(null)).toBe(false);
    const proposal = { status: 'ok', id: 'w', baseHash: 'h', proposedText: '{}' };
    expect(isProposalResult(proposal)).toBe(true);
    expect(isProposalResult({ ...proposal, status: 'error' })).toBe(false);
    expect(isProposalResult({ ...proposal, baseHash: 1 })).toBe(false);
  });
});

describe('what the page says and offers in each state', () => {
  const states: readonly RevisionState[] = [
    'loading',
    'changed',
    'no-changes',
    'applying',
    'applied',
    'conflict',
    'denied',
    'offline',
    'unknown',
    'retryable',
  ];

  it('has words for every state, and a message replaces them', () => {
    for (const state of states)
      expect(statusText(state, 2, undefined).length, state).toBeGreaterThan(0);
    expect(statusText('changed', 1, undefined)).toBe('Review 1 visible change before applying.');
    expect(statusText('changed', 3, undefined)).toBe('Review 3 visible changes before applying.');
    expect(statusText('applied', 0, 'Applied. New hash: h')).toBe('Applied. New hash: h');
  });

  it('colors a state by what it means', () => {
    expect(states.map((state) => [state, statusVariant(state)])).toEqual([
      ['loading', 'neutral'],
      ['changed', 'info'],
      ['no-changes', 'neutral'],
      ['applying', 'neutral'],
      ['applied', 'success'],
      ['conflict', 'danger'],
      ['denied', 'danger'],
      ['offline', 'warning'],
      ['unknown', 'warning'],
      ['retryable', 'info'],
    ]);
  });

  it('offers Apply only to a revision that has changes to apply, or a retry that is safe', () => {
    expect(states.filter(canApply)).toEqual(['changed', 'retryable']);
    expect(applyLabel('applying')).toBe('Applying…');
    expect(applyLabel('applied')).toBe('Applied');
    expect(applyLabel('retryable')).toBe('Retry Apply');
    expect(applyLabel('changed')).toBe('Apply');
  });

  it('offers a hash check after a failure, and disables it once the hash is known to be current', () => {
    expect(states.filter((state) => checkHashOffer(state).offered)).toEqual([
      'offline',
      'unknown',
      'retryable',
    ]);
    expect(checkHashOffer('retryable').disabled).toBe(true);
    expect(checkHashOffer('offline').disabled).toBe(false);
  });
});
