/// <reference lib="dom" />
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'bun:test';
import { tick } from 'svelte';

import Explanation from './explanation.svelte';
import { buildExplanationModel, type Explanation as Answer } from './model.ts';
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

describe('the failure explanation page, drawn with Cinder (COR-2543)', () => {
  it('AC1: draws the sentence, the cause, the step, the tries, the guardrails and the remediation', () => {
    const { container } = open({ kind: 'explained', model: buildExplanationModel(answer) });
    // The sentence goes in as text, never as markup.
    expect(container.querySelector('b')).toBeNull();
    expect(part(container, 'summary')?.textContent).toBe(answer.summary);
    expect(part(container, 'cause')?.textContent).toContain('application');
    expect(part(container, 'cause')?.textContent).toContain('code UNKNOWN, kind tool');
    expect(part(container, 'cause')?.querySelector('.cinder-badge')).not.toBeNull();
    const facts = container.querySelector('dl')?.textContent ?? '';
    expect(facts).toContain('charge-card');
    expect(facts).not.toContain('step 2');
    expect(facts).toContain('Tries');
    expect(facts).toContain('3');
    expect(part(container, 'verdicts')?.textContent).toContain('sentinel-card stopped the run');
    expect(part(container, 'remediation')?.textContent).toBe(answer.remediation);
  });

  it('is a main landmark with one labelled section for each part, and a live region', () => {
    const { container } = open({ kind: 'explained', model: buildExplanationModel(answer) });
    expect(container.querySelector('main[aria-labelledby="explanation-title"]')).not.toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('Why this run failed');
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    const sections = [...container.querySelectorAll('section')];
    expect(sections.map((node) => node.querySelector('h2')?.textContent)).toEqual([
      'Details',
      'Guardrails',
      'What to do next',
    ]);
    for (const node of sections) {
      expect(container.querySelector(`#${node.getAttribute('aria-labelledby')}`)?.tagName).toBe(
        'H2',
      );
    }
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
    expect(facts).toContain('not classified');
    expect(facts).not.toContain('Step');
    expect(facts).not.toContain('Tries');
    expect(part(container, 'verdicts')).toBeNull();
    expect(
      [...container.querySelectorAll('section')].map(
        (node) => node.querySelector('h2')?.textContent,
      ),
    ).toEqual(['Details', 'What to do next']);
  });

  it('AC3: shows the Bureau’s own message, and what it said to do, for a run that did not fail', () => {
    const { container } = open({
      kind: 'refused',
      refusal: {
        message:
          'Run "run-1" has not failed (its status is "completed"), so there is no failure to explain',
        remediation: 'Explain a run only after it has failed.',
      },
    });
    expect(part(container, 'message')?.textContent).toContain('has not failed');
    expect(part(container, 'remediation')?.textContent).toBe(
      'Explain a run only after it has failed.',
    );
    expect(part(container, 'summary')).toBeNull();
    expect(container.querySelector('dl')).toBeNull();
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
    expect(
      part(open({ kind: 'reading', runId: 'run-1' }).container, 'reading')?.textContent,
    ).toContain('run-1');
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
    expect(part(container, 'summary')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent?.trim()).toBe('Explanation loaded.');
  });
});
