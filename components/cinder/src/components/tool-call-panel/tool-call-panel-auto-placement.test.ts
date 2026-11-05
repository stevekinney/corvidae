/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { resetEscapeStack, resetScrollLock } from '../../_internal/overlay.ts';
import { installDrawerDialogStubs } from '../drawer/drawer-test-helpers.ts';

setupHappyDom();
installDrawerDialogStubs();

// A controllable `matchMedia` that answers `(width < Npx)` against a viewport width the test sets,
// installed before the first query is read, so `placement="auto"` can be driven across its
// breakpoints: a sheet below 640px, an overlay below 1280px, and docked from 1280px.
type Listener = (event: Event) => void;
const listeners = new Set<Listener>();
let viewportWidth = 1440;
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => {
    const limit = Number.parseFloat(/width < ([\d.]+)px/.exec(query)?.[1] ?? '0');
    return {
      media: query,
      get matches() {
        return viewportWidth < limit;
      },
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
    };
  },
});

afterAll(() => {
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window, 'matchMedia');
});

const { cleanup, render } = await import('@testing-library/svelte');
const { flushSync, tick } = await import('svelte');
const { default: ToolCallPanel } = await import('./tool-call-panel.svelte');

function setWidth(next: number): void {
  viewportWidth = next;
  for (const listener of listeners) listener(new Event('change'));
  flushSync();
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  resetScrollLock();
  resetEscapeStack();
  setWidth(1440);
});

const call = {
  name: 'Send email',
  identifier: 'send-email',
  status: 'failed',
  input: { to: 'maya@example.com' },
  error: { message: 'No reply from mail.example.com after 10s' },
} as const;

/** Where the panel drew itself: beside the page, over it on a scrim, or as a bottom sheet. */
async function placementOf(container: HTMLElement): Promise<string> {
  await tick();
  if (container.querySelector('aside.cinder-tool-call-panel') !== null) return 'docked';
  const placement = container
    .querySelector('.cinder-drawer__panel')
    ?.getAttribute('data-cinder-placement');
  return placement === 'bottom' ? 'sheet' : placement === 'right' ? 'overlay' : 'none';
}

describe('ToolCallPanel placement auto', () => {
  test('docks beside the conversation at 1280px and wider', async () => {
    setWidth(1280);
    const { container } = render(ToolCallPanel, { props: { ...call, placement: 'auto' } });

    expect(await placementOf(container)).toBe('docked');
  });

  test('opens over the conversation on a scrim just under 1280px, and docks only from 1280px', async () => {
    setWidth(1279);
    const { container } = render(ToolCallPanel, { props: { ...call, placement: 'auto' } });

    expect(await placementOf(container)).toBe('overlay');
    expect(container.querySelector('dialog')?.getAttribute('data-cinder-modal')).toBe('true');
  });

  test('opens as a bottom sheet under 640px', async () => {
    setWidth(639);
    const { container } = render(ToolCallPanel, { props: { ...call, placement: 'auto' } });

    expect(await placementOf(container)).toBe('sheet');
  });

  test('switches between docked and the drawer as the viewport crosses 1280px', async () => {
    setWidth(1400);
    const { container } = render(ToolCallPanel, { props: { ...call, placement: 'auto' } });
    expect(await placementOf(container)).toBe('docked');

    setWidth(900);
    expect(await placementOf(container)).toBe('overlay');

    setWidth(1300);
    expect(await placementOf(container)).toBe('docked');

    // A drawer keeps the placement it opened with until it is reopened, so a phone sheet is
    // reached from the docked form, which draws no drawer.
    setWidth(375);
    expect(await placementOf(container)).toBe('sheet');
  });

  test('docks from the width dockedFrom names', async () => {
    setWidth(1100);
    const { container } = render(ToolCallPanel, {
      props: { ...call, placement: 'auto', dockedFrom: '1024px' },
    });

    expect(await placementOf(container)).toBe('docked');
  });

  test('a placement that is named stays where it is whatever the width', async () => {
    setWidth(375);
    const { container } = render(ToolCallPanel, { props: { ...call, placement: 'docked' } });

    expect(await placementOf(container)).toBe('docked');
  });
});
