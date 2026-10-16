import { afterEach, describe, expect, test } from 'bun:test';

import { destroyAllHarnesses, mountHarness } from '../../../test/mount-harness.ts';
import { reactiveProps } from '../../../test/reactive-props.svelte.ts';
import Harness from '../../../test/terminal-spread-harness.svelte';
import { createFakeController } from './terminal-attachment-test-support.ts';
import { waitFor } from './terminal-test-support.ts';
import type { TerminalState } from './terminal.types.ts';

afterEach(async () => {
  await destroyAllHarnesses();
});

const encoder = new TextEncoder();

describe('turning optional props on and off', () => {
  for (const state of ['writable', 'exited'] as const satisfies readonly TerminalState[]) {
    test(`keeps the engine, the subscription and the retained output of a ${state} session`, async () => {
      const controller = createFakeController();
      const props = reactiveProps({
        state,
        controller,
        links: false,
        titles: false,
        recovery: false,
        announce: false,
      });
      const harness = mountHarness(Harness, props);
      const engineHost = () => harness.target.querySelector<HTMLElement>('.xterm');
      await waitFor(
        () =>
          engineHost() !== null &&
          !harness.target.querySelector('.cinder-terminal__viewport')?.hasAttribute('inert'),
        'the engine to mount',
      );
      controller.emit(encoder.encode('kept output'));
      const rows = () => harness.target.querySelector('.xterm-rows')?.textContent ?? '';
      await waitFor(() => rows().includes('kept output'), 'the output to be drawn');
      const engine = engineHost();
      expect(controller.subscriptions).toBe(1);

      for (const key of ['links', 'titles', 'recovery', 'announce'] as const) {
        props[key] = true;
        harness.flush();
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(engineHost()).toBe(engine);
        expect(rows()).toContain('kept output');
        props[key] = false;
        harness.flush();
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(engineHost()).toBe(engine);
        expect(rows()).toContain('kept output');
      }
      expect(controller.subscriptions).toBe(1);
      expect(controller.unsubscriptions).toBe(0);
    });
  }
});
