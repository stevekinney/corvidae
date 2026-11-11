/// <reference lib="dom" />
import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  expectNoLeakedTimers,
  requiredInstance,
  setupHappyDom,
  trackTimers,
} from '@lostgradient/testing';

import type { ApprovalCardProps } from './approval-card.types.ts';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { tick } = await import('svelte');
const { default: ApprovalCard } = await import('./approval-card.svelte');

afterEach(() => {
  cleanup();
  if (jest.isFakeTimers()) {
    jest.useRealTimers();
  }
  jest.restoreAllMocks();
  document.body.replaceChildren();
});

const REASON = 'Approving is off until Interborough is reachable';
const ARM_HINT = 'Reverts in 3 seconds. Escape cancels.';
/**
 * `rerender` merges into the current props, so a reason clears only when passed as undefined. The
 * prop is `disabledReason?: string`, which exactOptionalPropertyTypes will not let a literal
 * undefined satisfy, hence the cast through unknown.
 */
const NO_REASON = { disabledReason: undefined } as unknown as Partial<ApprovalCardProps>;

type DecisionOverrides = {
  [Key in keyof ApprovalCardProps]?: ApprovalCardProps[Key] | undefined;
};

/** The refund approval of the sample world as the explicit decision surface. */
function decisionCard(overrides: DecisionOverrides = {}): ApprovalCardProps {
  const merged: DecisionOverrides = {
    layout: 'decision',
    question: 'Refund order 4471 for $42.00?',
    tool: { name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true },
    operation: {
      kind: 'command',
      command: 'refund --order 4471 --amount 42.00',
      argsPreview: { orderId: 4471, amount: '$42.00' },
    },
    pauseSentence: 'The agent is paused until you decide.',
    facts: [
      { label: 'Target', value: 'order 4471' },
      { label: 'Amount', value: '$42.00' },
    ],
    approveLabel: 'Refund $42.00',
    policyVersion: 'policy-2026-06',
    idempotencyKey: 'decision-key',
    state: 'pending',
    onResolve: () => undefined,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as ApprovalCardProps;
}

function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
  document.dispatchEvent(event);
  return event;
}

describe('ApprovalCard decision layout', () => {
  test('writes the action, the danger badge, the pause, the facts and the open command with no icon gutter', () => {
    const { container, getByRole } = render(ApprovalCard, { props: decisionCard() });
    const card = container.querySelector('.cinder-approval-card');

    expect(card?.getAttribute('data-cinder-layout')).toBe('decision');
    expect(card?.getAttribute('data-cinder-state')).toBe('pending');
    expect(container.querySelector('.cinder-approval-card__risk-icon')).toBeNull();
    expect(getByRole('article', { name: 'Refund order 4471 for $42.00?' })).toBe(
      card as HTMLElement,
    );
    expect(
      squash(container.querySelector('.cinder-approval-card__irreversible')?.textContent),
    ).toBe('Irreversible');
    expect(squash(container.querySelector('.cinder-approval-card__pause')?.textContent)).toBe(
      'The agent is paused until you decide.',
    );
    const facts = Array.from(container.querySelectorAll('.cinder-approval-card__fact'), (fact) => [
      squash(fact.querySelector('dt')?.textContent),
      squash(fact.querySelector('dd')?.textContent),
    ]);
    expect(facts.slice(0, 3)).toEqual([
      ['Tool', 'Issue refund'],
      ['Target', 'order 4471'],
      ['Amount', '$42.00'],
    ]);
    expect(facts[3]?.[0]).toBe('Command');
    expect(facts[3]?.[1]).toContain('refund --order 4471 --amount 42.00');
    expect(container.querySelector('.cinder-approval-card__fact dt')?.className).toBe(
      'cinder-sr-only',
    );
    expect(container.querySelector('.cinder-approval-card__fact--command dt')?.className).toBe(
      'cinder-sr-only',
    );
    const command = container.querySelector('.cinder-approval-card__command');
    expect(command?.closest('[hidden]')).toBeNull();
    expect(command?.querySelector('.cinder-code-block--wrap')).not.toBeNull();
  });

  test('names the tool in monospace when it has no label, and says nothing of reversibility it does not know', () => {
    const { container } = render(ApprovalCard, {
      props: decisionCard({ tool: { name: 'issue-refund', risk: 'high' } }),
    });
    const tool = container.querySelector('.cinder-approval-card__fact dd');

    expect(squash(tool?.textContent)).toBe('issue-refund');
    expect(tool?.hasAttribute('data-cinder-monospace')).toBe(true);
    expect(container.textContent).not.toContain('Reversible');
    expect(container.querySelector('.cinder-approval-card__irreversible')).toBeNull();
  });

  test('states a reversible action as a fact', () => {
    const { container } = render(ApprovalCard, {
      props: decisionCard({
        tool: {
          name: 'publish-notes',
          label: 'Publish notes',
          risk: 'medium',
          irreversible: false,
        },
      }),
    });
    const labels = Array.from(
      container.querySelectorAll('.cinder-approval-card__fact dt'),
      (term) => squash(term.textContent),
    );

    expect(labels).toContain('Reversible');
    expect(container.querySelector('.cinder-approval-card__irreversible')).toBeNull();
  });

  test('offers Add a note, then Deny as secondary on the left and the named primary on the right', () => {
    const { container, getByRole } = render(ApprovalCard, { props: decisionCard() });
    const labels = Array.from(
      container.querySelectorAll('.cinder-approval-card__row-actions button'),
      (button) => squash(button.textContent),
    );

    expect(labels).toEqual(['Add a note', 'Deny', 'Refund $42.00']);
    expect(getByRole('button', { name: 'Deny' }).getAttribute('data-cinder-variant')).toBe(
      'secondary',
    );
    expect(getByRole('button', { name: 'Refund $42.00' }).getAttribute('data-cinder-variant')).toBe(
      'primary',
    );
  });

  test('writes the live countdown while the approval waits', async () => {
    const now = new Date('2026-06-24T12:00:00.000Z');
    jest.useFakeTimers({ now });
    const { container } = render(ApprovalCard, {
      props: decisionCard({ expiresAt: new Date(now.getTime() + 250_000).toISOString() }),
    });
    await tick();

    expect(squash(container.querySelector('[data-cinder-countdown]')?.textContent)).toBe(
      'Expires in 4m 10s',
    );
  });

  test('a reversible approval commits on the first press and sends the note with it', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const { getByRole, getByLabelText } = render(ApprovalCard, {
      props: decisionCard({
        tool: {
          name: 'publish-notes',
          label: 'Publish notes',
          risk: 'medium',
          irreversible: false,
        },
        approveLabel: 'Publish',
        onResolve,
      }),
    });

    await fireEvent.click(getByRole('button', { name: 'Add a note' }));
    await fireEvent.input(getByLabelText('Note (optional)'), { target: { value: 'Looks right' } });
    await fireEvent.click(getByRole('button', { name: 'Publish' }));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith({
      decision: 'approve',
      remember: false,
      reason: 'Looks right',
    });
  });

  test('Deny commits at once, even for an irreversible action', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const { getByRole } = render(ApprovalCard, { props: decisionCard({ onResolve }) });

    await fireEvent.click(getByRole('button', { name: 'Deny' }));

    expect(onResolve).toHaveBeenCalledWith({ decision: 'deny', remember: false });
  });

  test('offers Allow for the scope and sends it with the decision', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const { getByRole } = render(ApprovalCard, {
      props: decisionCard({
        tool: {
          name: 'publish-notes',
          label: 'Publish notes',
          risk: 'medium',
          irreversible: false,
        },
        approveLabel: undefined,
        rememberScope: 'the rest of this chat',
        onResolve,
      }),
    });

    await fireEvent.click(
      getByRole('checkbox', { name: 'Allow Publish notes for the rest of this chat' }),
    );
    await fireEvent.click(getByRole('button', { name: 'Approve' }));

    expect(onResolve).toHaveBeenCalledWith({ decision: 'approve', remember: true });
  });
});

describe('ApprovalCard decision layout: arming an irreversible action', () => {
  test('the first press arms a danger button and writes the hint, and the second press commits', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const { getByRole, getByText } = render(ApprovalCard, { props: decisionCard({ onResolve }) });

    await fireEvent.click(getByRole('button', { name: 'Refund $42.00' }));

    expect(onResolve).not.toHaveBeenCalled();
    const armed = getByRole('button', { name: 'Press again to refund $42.00' });
    expect(armed.getAttribute('data-cinder-variant')).toBe('danger');
    // Each Button keeps its own empty loading live region, so the hint is found by its text and
    // its status role is asserted on it.
    const hint = getByText(
      (_, element) => element?.classList.contains('cinder-approval-card__arm-hint') ?? false,
    );
    expect(hint.getAttribute('role')).toBe('status');
    expect(squash(hint.textContent)).toBe(ARM_HINT);
    expect(armed.getAttribute('aria-describedby')).toBe(hint.id);

    await fireEvent.click(armed);

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith({ decision: 'approve', remember: false });
  });

  test('keeps a long armed label in its own button while preserving the Deny target', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const { container, getByRole } = render(ApprovalCard, {
      props: decisionCard({
        approveLabel: 'Refund this order for $42.00 immediately',
        onResolve,
      }),
    });

    await fireEvent.click(
      getByRole('button', { name: 'Refund this order for $42.00 immediately' }),
    );

    const armed = getByRole('button', {
      name: 'Press again to refund this order for $42.00 immediately',
    });
    const deny = getByRole('button', { name: 'Deny' });
    expect(armed.querySelector('.cinder-button__label')?.textContent).toBe(
      'Press again to refund this order for $42.00 immediately',
    );
    expect(
      Array.from(container.querySelectorAll('.cinder-approval-card__row-actions .cinder-button')),
    ).toEqual([deny, armed]);

    await fireEvent.click(armed);
    expect(onResolve).toHaveBeenCalledWith({ decision: 'approve', remember: false });
  });

  test('reverts after three seconds without committing', async () => {
    jest.useFakeTimers();
    const onResolve = mock((_resolution: unknown) => undefined);
    const { getByRole, queryByRole, queryByText } = render(ApprovalCard, {
      props: decisionCard({ onResolve }),
    });

    await fireEvent.click(getByRole('button', { name: 'Refund $42.00' }));
    expect(getByRole('button', { name: 'Press again to refund $42.00' })).not.toBeNull();

    jest.advanceTimersByTime(2_999);
    await tick();
    expect(getByRole('button', { name: 'Press again to refund $42.00' })).not.toBeNull();

    jest.advanceTimersByTime(1);
    await tick();
    expect(queryByRole('button', { name: 'Press again to refund $42.00' })).toBeNull();
    expect(queryByText(ARM_HINT)).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Refund $42.00' }));
    expect(onResolve).not.toHaveBeenCalled();
  });

  test('Escape cancels the arm and nothing else, and the keystroke is handled', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const { getByRole, queryByRole } = render(ApprovalCard, { props: decisionCard({ onResolve }) });

    await fireEvent.click(getByRole('button', { name: 'Refund $42.00' }));
    const event = pressEscape();
    await tick();

    expect(event.defaultPrevented).toBe(true);
    expect(queryByRole('button', { name: 'Press again to refund $42.00' })).toBeNull();
    expect(getByRole('button', { name: 'Refund $42.00' })).not.toBeNull();
    expect(onResolve).not.toHaveBeenCalled();
  });

  test('Escape is left alone while nothing is armed', async () => {
    render(ApprovalCard, { props: decisionCard() });

    expect(pressEscape().defaultPrevented).toBe(false);
  });

  test('a reason that appears after arming drops the arm and holds the answer, and it works again once the reason clears', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const view = render(ApprovalCard, { props: decisionCard({ onResolve }) });

    await fireEvent.click(view.getByRole('button', { name: 'Refund $42.00' }));
    await view.rerender(decisionCard({ onResolve, disabledReason: REASON }));

    expect(view.queryByRole('button', { name: 'Press again to refund $42.00' })).toBeNull();
    const reason = view.getByText(REASON);
    const primary = view.getByRole('button', { name: 'Refund $42.00' });
    expect(primary.getAttribute('aria-disabled')).toBe('true');
    expect(primary.getAttribute('aria-describedby')).toBe(reason.id);
    await fireEvent.click(primary);
    await fireEvent.click(primary);
    expect(onResolve).not.toHaveBeenCalled();
    expect(view.queryByRole('button', { name: 'Press again to refund $42.00' })).toBeNull();

    await view.rerender({ ...decisionCard({ onResolve }), ...NO_REASON });
    await fireEvent.click(view.getByRole('button', { name: 'Refund $42.00' }));
    await fireEvent.click(view.getByRole('button', { name: 'Press again to refund $42.00' }));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  test('a new request starts disarmed', async () => {
    const view = render(ApprovalCard, { props: decisionCard() });

    await fireEvent.click(view.getByRole('button', { name: 'Refund $42.00' }));
    await view.rerender(decisionCard({ idempotencyKey: 'another-request' }));

    expect(view.queryByRole('button', { name: 'Press again to refund $42.00' })).toBeNull();
  });

  test('clears its timer and its Escape handler on destroy', async () => {
    const timers = trackTimers();

    try {
      const view = render(ApprovalCard, { props: decisionCard() });
      await fireEvent.click(view.getByRole('button', { name: 'Refund $42.00' }));
      expect(timers.active().size).toBeGreaterThan(0);

      view.unmount();

      expectNoLeakedTimers(timers.active());
      expect(pressEscape().defaultPrevented).toBe(false);
    } finally {
      timers.release();
    }
  });
});

describe('ApprovalCard decision layout: why the agent wants to do this', () => {
  test('offers the host reason as a disclosure that opens in place', async () => {
    const { getByRole, container } = render(ApprovalCard, {
      props: decisionCard({ why: 'The customer reported the parcel arrived damaged.' }),
    });
    const toggle = getByRole('button', { name: 'Why the agent wants to do this' });
    const body = container.querySelector('.cinder-approval-card__why-body');

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(body?.hasAttribute('hidden')).toBe(true);
    expect(toggle.getAttribute('aria-controls')).toBe(body?.id ?? '');

    await fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(body?.hasAttribute('hidden')).toBe(false);
    expect(squash(body?.textContent)).toBe('The customer reported the parcel arrived damaged.');
  });

  test('offers no disclosure when the host gave no reason', () => {
    const { queryByRole } = render(ApprovalCard, { props: decisionCard() });

    expect(queryByRole('button', { name: 'Why the agent wants to do this' })).toBeNull();
  });
});

describe('ApprovalCard decision layout: the retained receipt', () => {
  // C#6 (chat stress sweep): a receipt repeated the question it asked ("Refund order 4471 for
  // $42.00?") beside "Approved", and never said what was approved.
  test('an approval stays as what was approved, a check badge, who decided and when', () => {
    const { container, getByRole, queryByRole } = render(ApprovalCard, {
      props: decisionCard({
        state: 'approved',
        decidedBy: 'you',
        decidedAt: '2026-11-02T10:46:00.000Z',
      }),
    });
    const badge = container.querySelector('.cinder-approval-card__receipt-head .cinder-badge');

    expect(squash(badge?.textContent)).toBe('Approved');
    expect(badge?.querySelector('svg')).not.toBeNull();
    expect(badge?.getAttribute('aria-hidden')).toBe('true');
    const title = container.querySelector('.cinder-approval-card__decision-title');
    expect(squash(title?.textContent)).toBe('Approved: Refund $42.00, order 4471');
    expect(title?.querySelector('.cinder-sr-only')?.textContent).toBe('Approved: ');
    expect(getByRole('article', { name: 'Approved: Refund $42.00, order 4471' })).toBeTruthy();
    expect(container.textContent).not.toContain('Refund order 4471 for $42.00?');
    expect(squash(container.querySelector('.cinder-approval-card__receipt-by')?.textContent)).toBe(
      'by you, 10:46 AM',
    );
    expect(queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(queryByRole('button', { name: 'Refund $42.00' })).toBeNull();
  });

  test('a decision made elsewhere names the actor and links the surface, with a comma and no middle dot', () => {
    const { container, getByRole } = render(ApprovalCard, {
      props: decisionCard({
        state: 'approved',
        decidedBy: 'Priya Raman',
        decidedIn: 'Reviews',
        decidedInHref: '/reviews',
        decidedAt: '2026-11-02T10:46:00.000Z',
      }),
    });
    const by = container.querySelector('.cinder-approval-card__receipt-by');

    expect(squash(by?.textContent)).toBe('by Priya Raman in Reviews, 10:46 AM');
    expect(by?.textContent).not.toContain(String.fromCodePoint(0xb7));
    const link = getByRole('link', { name: 'Reviews' });
    expect(link.getAttribute('href')).toBe('/reviews');
    expect(by?.contains(link)).toBe(true);
  });

  test('writes the place as plain text when it has no link', () => {
    const { container, queryByRole } = render(ApprovalCard, {
      props: decisionCard({
        state: 'approved',
        decidedBy: 'Priya Raman',
        decidedIn: 'Reviews',
        decidedAt: '2026-11-02T10:46:00.000Z',
      }),
    });

    expect(queryByRole('link')).toBeNull();
    expect(squash(container.querySelector('.cinder-approval-card__receipt-by')?.textContent)).toBe(
      'by Priya Raman in Reviews, 10:46 AM',
    );
  });

  test('a denial quotes its reason inline in neutral text', () => {
    const { container } = render(ApprovalCard, {
      props: decisionCard({
        state: 'denied',
        decidedBy: 'you',
        decidedAt: '2026-11-02T10:40:00.000Z',
        decisionNote: 'Refund it through the original card instead',
      }),
    });
    const badge = container.querySelector('.cinder-approval-card__receipt-head .cinder-badge');

    expect(squash(badge?.textContent)).toBe('Denied');
    expect(badge?.getAttribute('data-cinder-variant')).toBe('neutral');
    expect(
      squash(container.querySelector('.cinder-approval-card__receipt-quote')?.textContent),
    ).toBe('“Refund it through the original card instead”');
  });

  test('expands to the note, the result and the command, and shows none of them until asked', async () => {
    const { container, getByRole } = render(ApprovalCard, {
      props: decisionCard({
        state: 'approved',
        decidedBy: 'you',
        decidedAt: '2026-11-02T10:46:00.000Z',
        decisionNote: 'Checked the order first',
        result: 'Refunded $42.00 to the original card.',
      }),
    });
    const toggle = getByRole('button', { name: 'Details' });
    const details = container.querySelector('.cinder-approval-card__receipt-details');

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(details?.hasAttribute('hidden')).toBe(true);
    expect(toggle.getAttribute('aria-controls')).toBe(details?.id ?? '');

    await fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(details?.hasAttribute('hidden')).toBe(false);
    expect(squash(details?.textContent)).toContain('Your note Checked the order first');
    expect(squash(details?.textContent)).toContain('Result: Refunded $42.00 to the original card.');
    expect(squash(details?.querySelector('.cinder-approval-card__command')?.textContent)).toContain(
      'refund --order 4471 --amount 42.00',
    );
  });

  test('offers no disclosure when there is nothing more to show', () => {
    const { queryByRole } = render(ApprovalCard, {
      props: decisionCard({
        state: 'approved',
        decidedBy: 'you',
        operation: { kind: 'other' },
      }),
    });

    expect(queryByRole('button', { name: 'Details' })).toBeNull();
  });

  test('an expired approval says it expired before a decision on what, with the notice and no actions', () => {
    const { container, queryByRole } = render(ApprovalCard, {
      props: decisionCard({ state: 'expired', notice: 'This approval expired.' }),
    });

    expect(
      squash(container.querySelector('.cinder-approval-card__decision-title')?.textContent),
    ).toBe('Expired before a decision: Refund $42.00, order 4471');
    // The title carries the state, so no second "Expired" word or Irreversible badge follows it.
    expect(container.querySelector('[data-cinder-state-word]')).toBeNull();
    expect(container.querySelector('.cinder-approval-card__irreversible')).toBeNull();
    expect(container.textContent).toContain('This approval expired.');
    expect(queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  test('a denial with a target but no named action titles itself with the tool and the target', () => {
    const { container, getByRole } = render(ApprovalCard, {
      props: decisionCard({
        state: 'denied',
        decidedBy: 'you',
        approveLabel: undefined,
        tool: { name: 'issue_refund', risk: 'high' },
      }),
    });

    expect(
      squash(container.querySelector('.cinder-approval-card__decision-title')?.textContent),
    ).toBe('Denied: Issue refund, order 4471');
    expect(getByRole('article', { name: 'Denied: Issue refund, order 4471' })).toBeTruthy();
  });

  test('with neither a named action nor a target, a decided card keeps its question', () => {
    const { container } = render(ApprovalCard, {
      props: decisionCard({
        state: 'denied',
        decidedBy: 'you',
        approveLabel: undefined,
        tool: { name: 'issue_refund', risk: 'high' },
        facts: [{ label: 'Amount', value: '$42.00' }],
      }),
    });

    expect(
      squash(container.querySelector('.cinder-approval-card__decision-title')?.textContent),
    ).toBe('Denied: Refund order 4471 for $42.00?');
  });

  test('an unavailable approval still asks its question, with the state word beside it', () => {
    const { container } = render(ApprovalCard, {
      props: decisionCard({ state: 'unavailable', unavailableReason: 'Held by a plugin.' }),
    });

    expect(
      squash(container.querySelector('.cinder-approval-card__decision-title')?.textContent),
    ).toBe('Refund order 4471 for $42.00?');
    expect(squash(container.querySelector('[data-cinder-state-word]')?.textContent)).toBe(
      'Unavailable',
    );
  });

  test('keeps the answer from firing when the host has not wired a resolver', () => {
    const { queryByRole } = render(ApprovalCard, {
      props: decisionCard({ onResolve: undefined }),
    });

    expect(queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(queryByRole('button', { name: 'Refund $42.00' })).toBeNull();
  });

  test('holds the input disclosure for what the open anatomy leaves out', async () => {
    const { getByRole, container } = render(ApprovalCard, { props: decisionCard() });
    const toggle = requiredInstance(getByRole('button', { name: /^Input/ }), HTMLButtonElement);

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(toggle);
    expect(
      container.querySelector('.cinder-approval-card__row-input')?.hasAttribute('hidden'),
    ).toBe(false);
  });

  // C#14 (chat stress sweep): "Input: Command refund order 4471" repeated the Command fact.
  test('leaves out an Input disclosure whose only field is already shown as a fact', () => {
    const { queryByRole } = render(ApprovalCard, {
      props: decisionCard({
        operation: {
          kind: 'command',
          command: 'refund --order 4471 --amount 42.00',
          argsPreview: { command: 'refund --order 4471 --amount 42.00' },
        },
      }),
    });

    expect(queryByRole('button', { name: /^Input/ })).toBeNull();
  });
});

describe('ApprovalCard decision layout stylesheet', () => {
  test('keeps the facts in a definition grid and the command free of a box of its own', () => {
    const css = readFileSync(new URL('./approval-card.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.cinder-approval-card__fact \{\s*display: grid;/);
    expect(css).not.toMatch(/\.cinder-approval-card__command \{[^}]*background:/);
    expect(css).not.toMatch(/\.cinder-approval-card__command \{[^}]*border:/);
    expect(css).toMatch(
      /\.cinder-approval-card--decision\[data-cinder-state='expired'\] \{[^}]*border-color:\s*var\(--cinder-status-warning-border\)/s,
    );
    expect(css).toMatch(/@media \(any-pointer: coarse\) \{[^}]*__arm-escape \{\s*display: none;/s);
    expect(css).toMatch(
      /\.cinder-approval-card__row-actions \.cinder-button__label \{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(css).toMatch(
      /\.cinder-approval-card__row-actions \.cinder-button \{[^}]*block-size:\s*auto;[^}]*align-self:\s*stretch;/s,
    );
    expect(css).toMatch(/\.cinder-approval-card__row-actions \{[^}]*align-items:\s*center;/s);
    expect(css).toMatch(
      /\.cinder-approval-card__row-actions \.cinder-inline-confirm__two-press \{[^}]*display:\s*contents;/s,
    );
    expect(css).toMatch(/\.cinder-inline-confirm__two-press-hint \{[^}]*flex:\s*1 0 100%;/s);
    expect(css).toMatch(
      /@container \(inline-size < 32rem\) \{[^}]*\.cinder-approval-card__input-toggle \{\s*align-items:\s*center;/s,
    );
    expect(css).toMatch(
      /\.cinder-approval-card__why ~ \.cinder-approval-card__decision-tools \{[^}]*margin-block-start:\s*calc\(-1 \* var\(--cinder-space-2\)\)/s,
    );
  });

  // C#14 (chat stress sweep): at 320 the label column left a long tool identifier a few
  // characters a line.
  test('below 20rem each fact stacks its label above its value', () => {
    const css = readFileSync(new URL('./approval-card.css', import.meta.url), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    const narrow = css.slice(css.indexOf('@container (inline-size < 20rem)'));
    expect(narrow).toMatch(
      /^@container \(inline-size < 20rem\) \{ \.cinder-approval-card__fact \{ grid-template-columns: minmax\(0, 1fr\); \}/,
    );
  });

  // C#3 (chat stress sweep): the disclosures and "Add a note" were text-sized on a phone.
  test('on a coarse pointer the disclosures and Add a note are 44px targets', () => {
    const css = readFileSync(new URL('./approval-card.css', import.meta.url), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(coarse).toContain(
      '.cinder-approval-card__input-toggle, .cinder-approval-card__said-toggle, .cinder-approval-card__note-toggle { min-block-size: var(--cinder-touch-target-min); }',
    );
  });
});
