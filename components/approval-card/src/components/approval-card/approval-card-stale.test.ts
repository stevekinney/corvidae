/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import type { ApprovalCardProps } from './approval-card.types.ts';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: StaleFixture } = await import('./approval-card-stale-fixture.test.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function card(overrides: Partial<ApprovalCardProps> = {}): ApprovalCardProps {
  return {
    tool: { name: 'issue-refund', risk: 'medium' },
    sandbox: { provider: 'codex', name: 'workspace-write', workingDir: '/workspace/project' },
    operation: { kind: 'command', command: 'refund 4471', filesTouched: [], argsPreview: {} },
    env: [],
    snapshotId: 'snapshot-1',
    policyVersion: 'policy-1',
    idempotencyKey: 'key-1',
    state: 'pending',
    ...overrides,
  };
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no ${name} button`);
  return found;
}

describe('ApprovalCard under a stale region', () => {
  test('Approve and Deny go inert, stay focusable and ignore the press while the data is old', async () => {
    const onResolve = mock(() => {});
    const { container } = render(StaleFixture, { card: card({ onResolve }) });
    for (const name of ['Approve', 'Deny']) {
      const control = button(container, name);
      expect(control.getAttribute('aria-disabled')).toBe('true');
      expect(control.hasAttribute('disabled')).toBe(false);
      control.focus();
      expect(document.activeElement).toBe(control);
      await fireEvent.click(control);
    }
    expect(onResolve).not.toHaveBeenCalled();
  });

  test('they come back by themselves when the region stops being stale', async () => {
    const onResolve = mock(() => {});
    const { container, rerender } = render(StaleFixture, { card: card({ onResolve }) });
    await rerender({ card: card({ onResolve }), stale: false });
    const approve = button(container, 'Approve');
    expect(approve.getAttribute('aria-disabled')).not.toBe('true');
    await fireEvent.click(approve);
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  for (const layout of ['row', 'decision'] as const) {
    for (const irreversible of [false, true]) {
      const kind = irreversible ? 'irreversible' : 'reversible';
      test(`the ${layout} layout's ${kind} primary ignores the press while stale and works once fresh`, async () => {
        const onResolve = mock(() => {});
        const props = card({
          layout,
          onResolve,
          tool: { name: 'issue-refund', risk: 'medium', irreversible },
        });
        const { container, rerender } = render(StaleFixture, { card: props });
        const primary = button(container, 'Approve');
        expect(primary.getAttribute('aria-disabled')).toBe('true');
        await fireEvent.click(primary);
        await fireEvent.click(primary);
        expect(onResolve).not.toHaveBeenCalled();

        await rerender({ card: props, stale: false });
        const fresh = button(container, 'Approve');
        await fireEvent.click(fresh);
        if (irreversible) await fireEvent.click(button(container, 'Press again to approve'));
        expect(onResolve).toHaveBeenCalledTimes(1);
      });
    }
  }

  test('the card itself stays readable', () => {
    const { container } = render(StaleFixture, { card: card({ onResolve: () => {} }) });
    expect(container.textContent).toContain('issue-refund');
  });
});
