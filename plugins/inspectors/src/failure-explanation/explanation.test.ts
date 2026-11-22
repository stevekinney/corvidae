/// <reference lib="dom" />
import {
  buildExplanationModel,
  type Explanation as Answer,
} from '@lostgradient/failure-explanation';
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'bun:test';
import { tick } from 'svelte';

import Explanation from './explanation.svelte';
import { createExplanationView, type ExplanationState } from './view.svelte.ts';

const answer: Answer = {
  summary: 'The step "charge-<b>card</b>" failed because the code it ran raised an error.',
  cause: { category: 'application', code: 'UNKNOWN', kind: 'tool' },
  step: { index: 1, label: 'charge-card' },
  tries: 3,
  verdicts: [{ name: 'sentinel-card', kind: 'tripwire', outcome: 'tripwire', step: 1 }],
  remediation: 'Read the run’s failure message, then start the run again.',
  nextCommands: [],
};

function open(state: ExplanationState, announcement = '') {
  const view = createExplanationView();
  view.state = state;
  view.announcement = announcement;
  const rendered = render(Explanation, { props: { view } });
  return { view, ...rendered };
}

const part = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-part="${name}"]`);
const shared = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-explanation="${name}"]`);

describe('the failure explanation page, drawn with Cinder (COR-2543)', () => {
  it('AC1: draws the sentence, the cause, the step, the tries, the guardrails and the remediation', () => {
    const { container } = open({ kind: 'explained', model: buildExplanationModel(answer) });
    // The sentence goes in as text, never as markup.
    expect(container.querySelector('b')).toBeNull();
    expect(shared(container, 'summary')?.textContent).toBe(answer.summary);
    expect(shared(container, 'cause')?.textContent).toContain('application');
    expect(shared(container, 'cause')?.querySelector('.cinder-badge')).not.toBeNull();
    // The engine's UNKNOWN is no code, and the kind of error is in the sentence: neither is shown.
    expect(shared(container, 'cause')?.textContent).not.toContain('UNKNOWN');
    expect(shared(container, 'cause')?.textContent).not.toContain('kind');
    const facts = container.querySelector('dl')?.textContent ?? '';
    expect(facts).toContain('charge-card');
    expect(facts).not.toContain('step 2');
    expect(facts).toContain('Tries');
    expect(facts).toContain('3');
    expect(shared(container, 'guardrails')?.textContent).toContain('sentinel-card stopped the run');
    expect(shared(container, 'remediation')?.textContent).toContain(answer.remediation);
    expect(shared(container, 'remediation')?.textContent).toContain('What to do next.');
  });

  it('draws the answer with the one component the Run page draws it with', () => {
    const { container } = open({ kind: 'explained', model: buildExplanationModel(answer) });
    expect(shared(container, 'root')).not.toBeNull();
    // Cinder's parts, not parts of its own: a two-column list under the sentence.
    expect(
      container.querySelector('.cinder-description-list')?.getAttribute('data-cinder-variant'),
    ).toBe('two-column');
    expect(container.querySelector('section')).toBeNull();
  });

  it('lists a guardrail that fired more than once, each time (a repeated verdict is no duplicate key)', () => {
    const fired = { name: 'pii', kind: 'guardrail', outcome: 'redact', step: 1 } as const;
    const { container } = open({
      kind: 'explained',
      model: buildExplanationModel({
        ...answer,
        verdicts: [fired, fired, { ...fired, step: null }],
      }),
    });
    const items = [...(shared(container, 'guardrails')?.querySelectorAll(':scope > span') ?? [])];
    expect(items.map((item) => item.textContent)).toEqual([
      'pii redacted the step',
      'pii redacted the step',
      'pii redacted the step',
    ]);
  });

  it('is a main landmark under its heading, and its live region is visually hidden', () => {
    const { container } = open(
      { kind: 'explained', model: buildExplanationModel(answer) },
      'Explanation loaded.',
    );
    expect(container.querySelector('main[aria-labelledby="explanation-title"]')).not.toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('Why this run failed');
    const status = container.querySelector('[role="status"][aria-live="polite"]');
    expect(status?.textContent?.trim()).toBe('Explanation loaded.');
    // Cinder's VisuallyHidden holds it, so the words are read and never drawn above the title.
    expect(status?.classList.contains('cinder-sr-only')).toBe(true);
    expect(container.querySelector('button')).toBeNull();
  });

  it('leaves out the step, the tries and the guardrails the Bureau did not store', () => {
    const { container } = open({
      kind: 'explained',
      model: buildExplanationModel({
        ...answer,
        cause: { category: null, code: null, kind: null },
        step: null,
        tries: null,
        verdicts: [],
      }),
    });
    const facts = container.querySelector('dl')?.textContent ?? '';
    expect(facts).toContain('uncategorized');
    expect(facts).not.toContain('Step');
    expect(facts).not.toContain('Tries');
    expect(shared(container, 'guardrails')).toBeNull();
  });

  it('AC3: shows the Bureau’s own message, and what it said to do, for a run that did not fail', () => {
    const message =
      'Run "run-1" has not failed (its status is "completed"), so there is no failure to explain';
    const { container } = open(
      {
        kind: 'refused',
        refusal: { message, remediation: 'Explain a run only after it has failed.' },
      },
      'Why this run failed',
    );
    expect(part(container, 'message')?.textContent).toContain('has not failed');
    expect(part(container, 'remediation')?.textContent).toBe(
      'Explain a run only after it has failed.',
    );
    expect(shared(container, 'summary')).toBeNull();
    expect(container.querySelector('dl')).toBeNull();
    // The live region says the heading, never the message the page already shows: the words are
    // there once to a person who reads them and once to one who hears them.
    expect(container.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      'Why this run failed',
    );
    expect(container.querySelector('[role="status"]')?.textContent).not.toContain(message);
  });

  it('says nothing to do when the Bureau said nothing', () => {
    const { container } = open({
      kind: 'refused',
      refusal: { message: 'Not found', remediation: null },
    });
    expect(part(container, 'message')?.textContent).toBe('Not found');
    expect(part(container, 'remediation')).toBeNull();
  });

  it('says what it is doing while it reads, and when no run is named, and when the host does not answer', () => {
    // No identifier of the run in the words: a person asked why a run failed, not for its id.
    expect(part(open({ kind: 'reading', runId: 'run-1' }).container, 'reading')?.textContent).toBe(
      'Reading why this run failed.',
    );
    expect(part(open({ kind: 'waiting' }).container, 'waiting')?.textContent).toContain(
      'No run is named',
    );
    expect(
      part(open({ kind: 'unreadable', reason: 'no-answer' }).container, 'unreadable')?.textContent,
    ).toContain('did not answer');
    expect(
      part(open({ kind: 'unreadable', reason: 'no-server-tools' }).container, 'unreadable')
        ?.textContent,
    ).toContain('does not let the page read');
  });

  it('redraws in place when the view changes, and keeps the live region', async () => {
    const { view, container } = open({ kind: 'reading', runId: 'run-1' });
    const status = container.querySelector('[role="status"]');
    view.state = { kind: 'explained', model: buildExplanationModel(answer) };
    view.announcement = 'Explanation loaded.';
    await tick();
    expect(shared(container, 'summary')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent?.trim()).toBe('Explanation loaded.');
  });
});
