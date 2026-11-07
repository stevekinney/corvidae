/**
 * The restart dialog (`restart-dialog.svelte`): it takes the page over while a restart runs, and
 * with `failedOnly` only for a restart that never came back, because the page shows the progress
 * itself (a chat, as Cinder's restart banner: design row 20f).
 */
import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import type { RestartPhase } from './host-restart-flow.svelte.ts';
import RestartDialog from './restart-dialog.svelte';

afterEach(() => {
  document.body.innerHTML = '';
});

/** Whether the modal's dialog is open: it is always in the document, and closed when nothing shows. */
function dialogIsOpen(): boolean {
  return document.querySelector('dialog')?.hasAttribute('open') === true;
}

/** What the dialog reads from a restart flow that is at `phase`. */
function flowAt(phase: RestartPhase) {
  return {
    phase,
    open:
      phase === 'requesting' || phase === 'stopping' || phase === 'starting' || phase === 'failed',
    intent: { changes: ['Demo'] },
    attempt: 1,
    retryInSeconds: 1,
    launchCommand: 'bun run start',
    lastError: 'No answer.',
    retryNow: () => undefined,
    keepWaiting: () => undefined,
  };
}

describe('the restart dialog', () => {
  test('takes the page over while the host restarts', () => {
    render(RestartDialog, { props: { flow: flowAt('starting') } });
    expect(dialogIsOpen()).toBe(true);
  });

  test('with failedOnly draws nothing while the restart is still under way', () => {
    for (const phase of ['requesting', 'stopping', 'starting'] as const) {
      const { unmount } = render(RestartDialog, {
        props: { flow: flowAt(phase), failedOnly: true },
      });
      expect(dialogIsOpen(), phase).toBe(false);
      unmount();
    }
  });

  test('with failedOnly still says the host did not come back', () => {
    render(RestartDialog, { props: { flow: flowAt('failed'), failedOnly: true } });
    expect(dialogIsOpen()).toBe(true);
    expect(document.querySelector('dialog')?.textContent).toContain('didn’t come back');
  });
});
