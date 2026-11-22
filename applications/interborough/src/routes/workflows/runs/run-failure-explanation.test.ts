/**
 * COR-2533: a failed run's section on the Run page renders what `bureau.tasks.explain` answers, and
 * nothing the browser words itself: the server's sentence, the cause with its badge, the step, the
 * tries, the guardrails and the remediation, with the stack behind a disclosure.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  explainAnswers,
  FAILED_RUN_EXPLANATION,
} from '../../../lib/bureau-fixtures.test-support.ts';
import { StubFault } from '../../../lib/bureau-stub.test-support.ts';
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
    // The cause is plain text on the label's edge: a badge's fill is the alert's own tint.
    expect(cause?.querySelector('.cinder-badge')).toBeNull();
    expect(cause?.textContent?.trim()).toStartWith('application');
    // The engine's UNKNOWN is no code, and the kind of error is in the sentence: neither is shown.
    expect(cause?.textContent).not.toContain('UNKNOWN');
    expect(cause?.textContent).not.toContain('kind');

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

  test('shows a code that names something a person can act on, after the badge', async () => {
    restore = bureau(
      explainAnswers({
        ...FAILED_RUN_EXPLANATION,
        cause: { category: 'system', code: 'ECONNRESET', kind: 'tool' },
      }),
    ).restore;
    const { container, findByText } = show({ runId: 'run-1' });
    await findByText(FAILED_RUN_EXPLANATION.summary);
    expect(part(container, 'cause')?.textContent).toContain('code ECONNRESET');
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
    const items = [...(part(container, 'guardrails')?.querySelectorAll(':scope > span') ?? [])];
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

  test('AC2: the cause names the server’s category, and no sentence is the browser’s', async () => {
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
    expect(part(container, 'cause')?.textContent?.trim()).toBe('timeout');
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

const MODEL_EXPLANATION = {
  text: 'The card network declined the charge.\n\nCheck the card on file and run the agent again.',
  model: 'anthropic/claude-haiku-5-5',
  generatedAt: '2026-11-21T10:00:00.000Z',
  costUsd: 0.0012,
};

const CONNECT_A_PROVIDER =
  'Connect a provider in Settings, under Models, so a model can write the explanation; the stored explanation of the failure still reads without one.';

/** The host's providers, as Chat reads them: one provider, connected or not. */
const providersOf =
  (connected: boolean) =>
  (url: string): Response | undefined =>
    url.endsWith('/host/providers')
      ? Response.json({
          configurationRevision: null,
          providers: [{ name: 'anthropic', configured: true, hasKey: connected, connected }],
          catalog: [],
          models: [],
        })
      : undefined;

describe('a failed agent run’s longer explanation, written by a model on request (COR-2534)', () => {
  test('AC5: "Explain further" asks for it and shows the text under the model’s name, with the stored facts still drawn', async () => {
    let stored: typeof MODEL_EXPLANATION | null = null;
    const stub = bureau(
      {
        ...explainAnswers(),
        'bureau.tasks.explanation.get': () => ({ explanation: stored }),
        'bureau.tasks.explanation.generate': () => {
          stored = MODEL_EXPLANATION;
          return { explanation: MODEL_EXPLANATION };
        },
      },
      providersOf(true),
    );
    restore = stub.restore;
    const { container, findByRole, findByText } = show({ runId: 'run-1', explainFurther: true });
    await findByText(FAILED_RUN_EXPLANATION.summary);
    const action = await findByRole('button', { name: 'Explain further' });
    // The note says in one sentence what the model reads, before there is an explanation.
    expect(part(container, 'further-note')?.textContent).toBe(
      'A model reads the explanation above and each step’s name, status and error message, never what a tool took in or gave back.',
    );
    // Reading what is stored asks no model: only the click does.
    await waitFor(() =>
      expect(stub.calls.map((call) => call.method)).toContain('bureau.tasks.explanation.get'),
    );
    expect(stub.calls.map((call) => call.method)).not.toContain(
      'bureau.tasks.explanation.generate',
    );
    expect(container.querySelector('[data-explanation="model-text"]')).toBeNull();

    await fireEvent.click(action);

    await findByText('The card network declined the charge.');
    expect(stub.calls).toContainEqual({
      method: 'bureau.tasks.explanation.generate',
      params: { runId: 'run-1' },
    });
    const label = part(container, 'model-name')?.textContent?.trim() ?? '';
    // A phrase, never "on Today, 4:00 AM": the day and the clock are joined by "at".
    expect(label).toMatch(/^Written by anthropic\/claude-haiku-5-5 .+ at \d{1,2}:\d{2} [AP]M$/);
    expect(label).not.toContain(' on ');
    // The note is for the first explanation only: the answer already shows what it cost.
    expect(part(container, 'further-note')).toBeNull();
    expect(part(container, 'model-cost')?.textContent).toContain('Cost of this explanation');
    // The text is paragraphs of plain text, and the stored facts are still on the page.
    expect(container.querySelector('[data-explanation="model-text"]')?.textContent).toContain(
      'Check the card on file and run the agent again.',
    );
    expect(part(container, 'summary')?.textContent).toBe(FAILED_RUN_EXPLANATION.summary);
    expect(part(container, 'remediation')?.textContent).toContain(
      FAILED_RUN_EXPLANATION.remediation,
    );
    expect(await findByRole('button', { name: 'Explain again' })).toBeTruthy();
  });

  test('AC3: a stored explanation is on the page when it opens, with no model asked', async () => {
    const stub = bureau(
      {
        ...explainAnswers(),
        'bureau.tasks.explanation.get': () => ({ explanation: MODEL_EXPLANATION }),
      },
      providersOf(true),
    );
    restore = stub.restore;
    const { container, findByText } = show({ runId: 'run-1', explainFurther: true });

    await findByText('The card network declined the charge.');

    expect(part(container, 'model-name')?.textContent).toContain('anthropic/claude-haiku-5-5');
    expect(stub.calls.map((call) => call.method)).not.toContain(
      'bureau.tasks.explanation.generate',
    );
  });

  test('AC4: with no provider connected the page is in its own state, in Chat’s words, with the way to connect one and no action that cannot work', async () => {
    const stub = bureau(
      {
        ...explainAnswers(),
        'bureau.tasks.explanation.get': () => ({ explanation: null }),
      },
      providersOf(false),
    );
    restore = stub.restore;
    const { container, findByText, queryByRole, getByRole } = show({
      runId: 'run-1',
      explainFurther: true,
    });
    await findByText(FAILED_RUN_EXPLANATION.summary);

    const state = await waitFor(() => {
      const found = container.querySelector('[data-explanation="no-provider"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    // One title, in Chat's words, and no second sentence saying it again.
    expect(state.querySelector('h3')?.textContent).toBe('Connect a provider first');
    expect(state.querySelectorAll('p')).toHaveLength(0);
    const link = getByRole('link', { name: 'Connect a provider' });
    expect(link.getAttribute('href')).toContain('/settings/models');
    // The action that could not work is not offered, and no model is asked.
    expect(queryByRole('button', { name: 'Explain further' })).toBeNull();
    expect(container.querySelector('[data-explanation="further-fault"]')).toBeNull();
    expect(stub.calls.map((call) => call.method)).not.toContain(
      'bureau.tasks.explanation.generate',
    );
    expect(part(container, 'summary')?.textContent).toBe(FAILED_RUN_EXPLANATION.summary);
  });

  test('AC4: a Bureau that answers no model can write it is the same state, not a generic fault', async () => {
    restore = bureau(
      {
        ...explainAnswers(),
        'bureau.tasks.explanation.get': () => ({ explanation: null }),
        'bureau.tasks.explanation.generate': () => {
          throw new StubFault(
            'UnsupportedCapability',
            501,
            'No model is connected to write the explanation',
            { remediation: CONNECT_A_PROVIDER },
          );
        },
      },
      providersOf(true),
    ).restore;
    const { container, findByRole, findByText } = show({ runId: 'run-1', explainFurther: true });
    await findByText(FAILED_RUN_EXPLANATION.summary);

    await fireEvent.click(await findByRole('button', { name: 'Explain further' }));

    await waitFor(() =>
      expect(container.querySelector('[data-explanation="no-provider"]')).not.toBeNull(),
    );
    expect(container.textContent).not.toContain('No model is connected');
    expect(container.textContent).not.toContain('Not supported');
    expect(container.querySelector('[data-explanation="further-fault"]')).toBeNull();
    // Nothing is written, and the stored facts are still drawn.
    expect(container.querySelector('[data-explanation="model-text"]')).toBeNull();
    expect(part(container, 'summary')?.textContent).toBe(FAILED_RUN_EXPLANATION.summary);
  });

  test('another fault of the ask is drawn as a fault, and the action stays to ask again', async () => {
    restore = bureau(
      {
        ...explainAnswers(),
        'bureau.tasks.explanation.get': () => ({ explanation: null }),
        'bureau.tasks.explanation.generate': () => {
          throw new StubFault(
            'Unprocessable',
            422,
            'The run changed while the explanation was being written, so it was not kept',
            { reason: 'run-changed' },
          );
        },
      },
      providersOf(true),
    ).restore;
    const { container, findByRole, findByText } = show({ runId: 'run-1', explainFurther: true });
    await findByText(FAILED_RUN_EXPLANATION.summary);

    await fireEvent.click(await findByRole('button', { name: 'Explain further' }));

    await findByText(/changed while the explanation was being written/);
    expect(container.querySelector('[data-explanation="no-provider"]')).toBeNull();
    expect(container.querySelector('[data-explanation="model-text"]')).toBeNull();
  });

  test('offers no action for a run that is not an agent run’s, and reads no stored explanation for it', async () => {
    const stub = bureau(explainAnswers());
    restore = stub.restore;
    const { container, findByText, queryByRole } = show({ runId: 'run-1' });
    await findByText(FAILED_RUN_EXPLANATION.summary);
    expect(queryByRole('button', { name: 'Explain further' })).toBeNull();
    expect(container.querySelector('[data-explanation="further"]')).toBeNull();
    expect(stub.calls.map((call) => call.method)).toEqual(['bureau.tasks.explain']);
  });
});
