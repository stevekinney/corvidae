/**
 * The run page's one header: what ran, the one status, Open chat, Cancel run, and a More menu with
 * the actions on a run the workflow engine holds, the two that cannot be undone behind a
 * confirmation.
 */
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import ToastHost from '../../../app/toast-host.svelte';
import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { router } from '../../../lib/router.svelte.ts';
import type { WorkflowContextualAction } from '../detail/workflow-status.ts';
import RunHeaderHarness from './run-header.test-harness.svelte';

afterEach(() => cleanup());

function renderHeader(props: Record<string, unknown> = {}) {
  return render(RunHeaderHarness, {
    props: { runId: 'run-1', title: 'echo', fallbackTitle: 'Run', status: 'Running', ...props },
  } as never);
}

async function openMenu(view: ReturnType<typeof renderHeader>): Promise<void> {
  await fireEvent.click(view.getByRole('button', { name: 'More actions' }));
}

describe('the run page header', () => {
  test('names what ran as an identifier, with one status and when the run started', () => {
    const view = renderHeader({ startedAt: Date.now() - 60_000, tookMilliseconds: 125_000 });

    const heading = view.getByRole('heading', { level: 1 });
    expect(heading.querySelector('code.ib-identifier')?.textContent).toBe('echo');
    expect(view.container.querySelectorAll('[data-status-word]').length).toBe(1);
    expect(view.container.querySelector('[data-status-word]')?.textContent).toContain('Running');
    expect(view.container.textContent).toContain('2m');
  });

  test('says "Run" when nothing names what ran, and shows no status', () => {
    const view = renderHeader({ title: undefined, status: undefined });

    expect(view.getByRole('heading', { level: 1, name: 'Run' })).not.toBeNull();
    expect(view.container.querySelector('[data-status-word]')).toBeNull();
  });

  test('Open chat opens in place, and a modified click is the browser’s', async () => {
    const view = renderHeader({ chat: { href: '/chats/session-1', label: 'Open chat' } });

    const link = view.getByRole('link', { name: 'Open chat' });
    expect(await fireEvent.click(link, { button: 0, metaKey: true })).toBe(true);
    expect(await fireEvent.click(link, { button: 0 })).toBe(false);
    expect(router.pathname).toContain('session-1');
  });

  test('a task offers Cancel run beside More, and the engine’s own cancel is not offered twice', async () => {
    const view = renderHeader({
      task: taskFixture({ id: 'run-1', status: 'working' }),
      engineStatus: 'running',
      onAction: () => {},
    });

    expect(view.getByRole('button', { name: 'Cancel run' })).not.toBeNull();
    await openMenu(view);
    expect(view.queryByRole('menuitem', { name: 'Cancel' })).toBeNull();
    expect(view.getByRole('menuitem', { name: 'Suspend' })).not.toBeNull();
    expect(view.getByRole('menuitem', { name: 'Force timeout' })).not.toBeNull();
  });

  test('a running run offers cancel, suspend and force timeout; a suspended one offers resume', async () => {
    const running = renderHeader({ engineStatus: 'running', onAction: () => {} });
    await openMenu(running);
    expect(running.getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual([
      'Copy run ID',
      'Cancel',
      'Suspend',
      'Force timeout',
    ]);
    cleanup();

    const suspended = renderHeader({ engineStatus: 'suspended', onAction: () => {} });
    await openMenu(suspended);
    expect(suspended.getByRole('menuitem', { name: 'Resume' })).not.toBeNull();
  });

  test('cancel asks first, and confirming sends it once', async () => {
    const actions: WorkflowContextualAction[] = [];
    const view = renderHeader({
      engineStatus: 'running',
      onAction: (a: WorkflowContextualAction) => actions.push(a),
    });

    await openMenu(view);
    await fireEvent.click(view.getByRole('menuitem', { name: 'Cancel' }));
    expect(actions).toEqual([]);
    expect(view.getByRole('dialog')).not.toBeNull();

    await fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(actions).toEqual(['cancel']);
  });

  test('keeping the run leaves the confirmation without sending anything', async () => {
    const actions: WorkflowContextualAction[] = [];
    const view = renderHeader({
      engineStatus: 'running',
      onAction: (a: WorkflowContextualAction) => actions.push(a),
    });

    await openMenu(view);
    await fireEvent.click(view.getByRole('menuitem', { name: 'Force timeout' }));
    await fireEvent.click(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Keep it' }),
    );

    expect(actions).toEqual([]);
    expect(view.queryByRole('dialog')).toBeNull();
  });

  test('suspend is sent without asking', async () => {
    const actions: WorkflowContextualAction[] = [];
    const view = renderHeader({
      engineStatus: 'running',
      onAction: (a: WorkflowContextualAction) => actions.push(a),
    });

    await openMenu(view);
    await fireEvent.click(view.getByRole('menuitem', { name: 'Suspend' }));

    expect(actions).toEqual(['suspend']);
  });

  test('another action pending disables the rest, and a caller without workflows:write cannot send any', async () => {
    const pending = renderHeader({
      engineStatus: 'running',
      pendingAction: 'suspend',
      onAction: () => {},
    });
    await openMenu(pending);
    expect(pending.getByRole('menuitem', { name: 'Cancel' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(
      pending.getByRole('menuitem', { name: 'Suspend' }).getAttribute('aria-disabled'),
    ).not.toBe('true');
    cleanup();

    const denied = renderHeader({
      engineStatus: 'running',
      onAction: () => {},
      actionGate: { disabled: true, title: 'Requires workflows:write' },
    });
    await openMenu(denied);
    expect(denied.getByRole('menuitem', { name: 'Suspend' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  test('Restart is offered for a run that is over, once a handler is wired, and calls it', async () => {
    let restarts = 0;
    const view = renderHeader({
      engineStatus: 'failed',
      onAction: () => {},
      onRestart: () => (restarts += 1),
    });

    await openMenu(view);
    await fireEvent.click(view.getByRole('menuitem', { name: 'Restart' }));
    expect(restarts).toBe(1);
    cleanup();

    const running = renderHeader({
      engineStatus: 'running',
      onAction: () => {},
      onRestart: () => {},
    });
    await openMenu(running);
    expect(running.queryByRole('menuitem', { name: 'Restart' })).toBeNull();
    cleanup();

    const unwired = renderHeader({ engineStatus: 'failed', onAction: () => {} });
    await openMenu(unwired);
    expect(unwired.queryByRole('menuitem', { name: 'Restart' })).toBeNull();
  });

  test('Copy run ID puts the ID on the clipboard', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    const toasts = render(ToastHost);
    const view = renderHeader();

    await openMenu(view);
    await fireEvent.click(view.getByRole('menuitem', { name: 'Copy run ID' }));

    expect(written).toEqual(['run-1']);
    expect(await toasts.findByText('Run ID copied')).not.toBeNull();
  });
});
