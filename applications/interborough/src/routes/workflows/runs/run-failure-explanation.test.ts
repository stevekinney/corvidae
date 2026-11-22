/**
 * COR-2533: a failed run's section on the Run page renders what `bureau.tasks.explain` answers, and
 * nothing the browser words itself: the server's sentence, the cause with its badge, the step, the
 * tries, the guardrails and the remediation, with the stack behind a disclosure.
 */
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  explainAnswers,
  FAILED_RUN_EXPLANATION,
} from '../../../lib/bureau-fixtures.test-support.ts';
import { failureExplanationPath, router } from '../../../lib/router.svelte.ts';
import { bureau, landAt } from '../../chat/pages.test-support.ts';
import QueryPage from '../../chat/query-page.test-harness.svelte';
import RunFailureExplanation from './run-failure-explanation.svelte';

/** The section below a query client, as the Run page shows it. */
const show = (pageProps: Record<string, unknown>) =>
  render(QueryPage, { props: { page: RunFailureExplanation, pageProps } } as never);

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
    const { container, findByText } = show({ runId: 'run-1', category: 'application' });

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
    // The step by its label alone: the server's index is the engine's, not the page's step number.
    expect(facts).toContain('charge-card');
    expect(facts).not.toContain('step 2');
    expect(facts).toContain('Tries');
    expect(facts).toContain('3');

    expect(part(container, 'guardrails')?.textContent).toContain('sentinel-card stopped the run');
    expect(part(container, 'remediation')?.textContent).toContain(
      FAILED_RUN_EXPLANATION.remediation,
    );
    expect(part(container, 'remediation')?.textContent).toContain('What to do next.');
  });

  test('lists a guardrail that fired more than once, each time (a repeated verdict is no duplicate key)', async () => {
    const fired = { name: 'pii', kind: 'guardrail', outcome: 'redact', step: 1 } as const;
    restore = bureau(
      explainAnswers({
        ...FAILED_RUN_EXPLANATION,
        verdicts: [fired, fired, { ...fired, step: 2 }],
      }),
    ).restore;
    const { container, findByText } = show({ runId: 'run-1' });
    await findByText(FAILED_RUN_EXPLANATION.summary);
    const items = [...(part(container, 'guardrails')?.querySelectorAll('li') ?? [])];
    expect(items.map((item) => item.textContent)).toEqual([
      'pii redacted the step',
      'pii redacted the step',
      'pii redacted the step',
    ]);
  });

  test('scrolls itself into view after a client-side navigation to its fragment, once it has mounted and again when its answer arrives', async () => {
    const scrolled: Element[] = [];
    const original = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      restore = bureau(explainAnswers()).restore;
      // The link Chat draws navigates through the router, which never scrolls as a page load does.
      landAt('/runs/run-1');
      router.navigate(failureExplanationPath('run-1'));
      expect(router.hash).toBe('#failure-explanation');
      const { container, findByText } = show({ runId: 'run-1' });
      const region = container.querySelector('[data-run-explanation]');
      await waitFor(() => expect(scrolled).toContain(region as Element));
      const before = scrolled.length;
      await findByText(FAILED_RUN_EXPLANATION.summary);
      await waitFor(() => expect(scrolled.length).toBeGreaterThan(before));
      expect(new Set(scrolled)).toEqual(new Set([region as Element]));
    } finally {
      window.HTMLElement.prototype.scrollIntoView = original;
    }
  });

  test('does not scroll when the address names no fragment', async () => {
    const scrolled: Element[] = [];
    const original = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      restore = bureau(explainAnswers()).restore;
      landAt('/runs/run-1');
      expect(router.hash).toBe('');
      const { findByText } = show({ runId: 'run-1' });
      await findByText(FAILED_RUN_EXPLANATION.summary);
      expect(scrolled).toEqual([]);
    } finally {
      window.HTMLElement.prototype.scrollIntoView = original;
    }
  });

  test('AC1: carries the anchor Chat links to, and a name for the region', async () => {
    restore = bureau(explainAnswers()).restore;
    const { container, findByText } = show({ runId: 'run-1' });
    await findByText(FAILED_RUN_EXPLANATION.summary);
    const region = container.querySelector('[data-run-explanation]');
    expect(region?.id).toBe('failure-explanation');
    expect(region?.getAttribute('aria-label')).toBe('Why this run failed');
  });

  test('AC1: puts the stack behind a disclosure, and leaves it out when there is none', async () => {
    restore = bureau(explainAnswers()).restore;
    const stack = 'Error: boom\n    at doThing (file.ts:1:1)';
    const withStack = show({ runId: 'run-1', errorStack: stack });
    await withStack.findByText(FAILED_RUN_EXPLANATION.summary);
    // Cinder's Collapsible toggles through a transition happy-dom cannot drive: the trigger is the
    // disclosure, and the stack is never in the open text of the section.
    const trigger = withStack.getByRole('button', { name: 'Show the error details' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(part(withStack.container, 'summary')?.textContent).not.toContain('doThing');
    expect(part(withStack.container, 'remediation')?.textContent).not.toContain('doThing');
    withStack.unmount();

    const without = show({ runId: 'run-1' });
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
    const { container, findByText } = show({ runId: 'run-1', category: 'application' });
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
    const { container } = show({ runId: 'run-1', category: 'system' });
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
    const { container } = show({ runId: 'run-1' });
    expect(container.querySelector('[data-explanation]')).toBeNull();
    expect(container.querySelector('.cinder-badge')).toBeNull();
  });
});
