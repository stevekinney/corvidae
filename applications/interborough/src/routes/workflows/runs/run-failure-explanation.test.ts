/**
 * COR-2533: a failed run's section on the Run page renders what `bureau.tasks.explain` answers, and
 * nothing the browser words itself: the server's sentence, the cause with its badge, the step, the
 * tries, the guardrails and the remediation, with the stack behind a disclosure.
 */
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { bureau } from '../../chat/pages.test-support.ts';
import Harness from './run-failure-explanation.test-harness.svelte';
import { explainAnswers, FAILED_RUN_EXPLANATION } from './run-failure-explanation.test-support.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const part = (container: HTMLElement, name: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-explanation="${name}"]`);

describe('a failed run’s explanation', () => {
  test('AC1: reads the summary, the cause, the step, the tries, the guardrails and the remediation', async () => {
    const stub = bureau(explainAnswers());
    restore = stub.restore;
    const { container, findByText } = render(Harness, {
      props: { runId: 'run-1', category: 'application' },
    });

    await findByText(FAILED_RUN_EXPLANATION.summary);
    expect(stub.calls).toEqual([{ method: 'bureau.tasks.explain', params: { runId: 'run-1' } }]);
    expect(part(container, 'summary')?.textContent).toBe(FAILED_RUN_EXPLANATION.summary);

    const cause = part(container, 'cause');
    expect(cause?.querySelector('.cinder-badge')?.textContent?.trim()).toBe('application');
    expect(cause?.querySelector('.cinder-badge')?.getAttribute('data-cinder-variant')).toBe(
      'danger',
    );
    expect(cause?.textContent).toContain('code UNKNOWN, kind tool');

    const facts = container.querySelector('dl')?.textContent ?? '';
    expect(facts).toContain('charge-card (step 2)');
    expect(facts).toContain('Tries');
    expect(facts).toContain('3');

    expect(part(container, 'guardrails')?.textContent).toContain(
      'sentinel-card stopped the run at step 2',
    );
    expect(part(container, 'remediation')?.textContent).toContain(
      FAILED_RUN_EXPLANATION.remediation,
    );
    expect(part(container, 'remediation')?.textContent).toContain('What to do next.');
  });

  test('AC1: carries the anchor Chat links to, and a name for the region', async () => {
    restore = bureau(explainAnswers()).restore;
    const { container, findByText } = render(Harness, { props: { runId: 'run-1' } });
    await findByText(FAILED_RUN_EXPLANATION.summary);
    const region = container.querySelector('[data-run-explanation]');
    expect(region?.id).toBe('failure-explanation');
    expect(region?.getAttribute('aria-label')).toBe('Why this run failed');
  });

  test('AC1: puts the stack behind a disclosure, and leaves it out when there is none', async () => {
    restore = bureau(explainAnswers()).restore;
    const stack = 'Error: boom\n    at doThing (file.ts:1:1)';
    const withStack = render(Harness, { props: { runId: 'run-1', errorStack: stack } });
    await withStack.findByText(FAILED_RUN_EXPLANATION.summary);
    // Cinder's Collapsible toggles through a transition happy-dom cannot drive: the trigger is the
    // disclosure, and the stack is never in the open text of the section.
    const trigger = withStack.getByRole('button', { name: 'Show the error details' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(part(withStack.container, 'summary')?.textContent).not.toContain('doThing');
    expect(part(withStack.container, 'remediation')?.textContent).not.toContain('doThing');
    withStack.unmount();

    const without = render(Harness, { props: { runId: 'run-1' } });
    await without.findByText(FAILED_RUN_EXPLANATION.summary);
    expect(without.queryByRole('button', { name: 'Show the error details' })).toBeNull();
  });

  test('AC2: the badge’s tone follows the server’s category, and no sentence is the browser’s', async () => {
    restore = bureau(
      explainAnswers({
        ...FAILED_RUN_EXPLANATION,
        cause: { category: 'timeout', code: null, kind: null },
        step: null,
        tries: null,
        verdicts: [],
      }),
    ).restore;
    const { container, findByText } = render(Harness, {
      props: { runId: 'run-1', category: 'application' },
    });
    await findByText(FAILED_RUN_EXPLANATION.summary);
    const badge = part(container, 'cause')?.querySelector('.cinder-badge');
    expect(badge?.textContent?.trim()).toBe('timeout');
    expect(badge?.getAttribute('data-cinder-variant')).toBe('warning');
    // No code, kind, step, tries or guardrail row for a stored fact that is not there.
    expect(container.querySelector('dl')?.textContent).not.toContain('Tries');
    expect(container.querySelector('dl')?.textContent).not.toContain('Step');
    expect(part(container, 'guardrails')).toBeNull();
    expect(part(container, 'cause')?.textContent).not.toContain('code');
  });

  test('shows the engine’s category as a badge and invents nothing when the Bureau cannot explain', async () => {
    const stub = bureau({}, () => new Response('{}', { status: 404 }));
    restore = stub.restore;
    const { container } = render(Harness, { props: { runId: 'run-1', category: 'system' } });
    await waitFor(() =>
      expect(container.querySelector('[data-run-failure-category]')?.textContent?.trim()).toBe(
        'system',
      ),
    );
    expect(container.querySelector('[data-explanation="summary"]')).toBeNull();
    expect(container.querySelector('[data-explanation="remediation"]')).toBeNull();
  });

  test('draws nothing for a run with no category while the answer is on its way', () => {
    restore = bureau({
      'bureau.tasks.explain': () => new Promise(() => undefined),
    }).restore;
    const { container } = render(Harness, { props: { runId: 'run-1' } });
    expect(container.querySelector('[data-explanation]')).toBeNull();
    expect(container.querySelector('.cinder-badge')).toBeNull();
  });
});
