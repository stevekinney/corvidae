/**
 * The ring in a chat's header: what it reads, what its trigger is named, and the breakdown it opens
 * to. The report is the Bureau's (`bureau.contexts.window`); the ring only draws it.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy.ts';
import type { ContextWindow } from '../../lib/bureau-client.ts';
import ContextWindowRing from './context-window-ring.svelte';

afterEach(cleanup);

const COPY = CHAT_COPY.contextWindow;

const REPORT: ContextWindow = {
  maxTokens: 200_000,
  usedEstimated: 84_000,
  usedReported: 80_500,
  categories: [
    { name: 'system', tokens: 4_000 },
    { name: 'tools', tokens: 10_000 },
    { name: 'messages', tokens: 60_000 },
    { name: 'memory', tokens: 6_000 },
    { name: 'attachments', tokens: 4_000 },
  ],
};

function trigger(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('.weft-context-ring');
  if (found === null) throw new Error('The ring did not render.');
  return found;
}

describe('the ring', () => {
  test('names the share of the window in use, in whole percent, on its trigger', () => {
    const { container } = render(ContextWindowRing, { props: { report: REPORT } });

    expect(trigger(container).getAttribute('aria-label')).toBe(
      COPY.trigger(42, '84,000', '200,000'),
    );
    expect(trigger(container).textContent).toContain('42%');
    expect(trigger(container).getAttribute('data-tone')).toBe('normal');
  });

  test('draws the share as an arc of the ring, and changes its tone as the window fills', () => {
    const { container, rerender } = render(ContextWindowRing, { props: { report: REPORT } });
    const arc = () => container.querySelector('.weft-context-ring__fill');
    const circumference = 2 * Math.PI * 7;
    const [drawn] = (arc()?.getAttribute('stroke-dasharray') ?? '').split(' ');
    expect(Number(drawn)).toBeCloseTo(0.42 * circumference, 5);

    void rerender({ report: { ...REPORT, usedEstimated: 150_000 } });
    expect(trigger(container).getAttribute('data-tone')).toBe('warning');
    void rerender({ report: { ...REPORT, usedEstimated: 190_000 } });
    expect(trigger(container).getAttribute('data-tone')).toBe('danger');
  });

  test('says the token count alone, with an empty ring, when the model’s window is not known', () => {
    const { container } = render(ContextWindowRing, {
      props: { report: { ...REPORT, maxTokens: null } },
    });

    expect(trigger(container).getAttribute('aria-label')).toBe(COPY.trigger(null, '84,000', null));
    expect(trigger(container).textContent).toContain('84,000 tokens');
    expect(trigger(container).getAttribute('data-tone')).toBe('unknown');
    const [drawn] = (
      container.querySelector('.weft-context-ring__fill')?.getAttribute('stroke-dasharray') ?? ''
    ).split(' ');
    expect(Number(drawn)).toBe(0);
  });

  test('opens to what fills the window, one meter for each, in the Bureau’s order', async () => {
    const { container, findByTestId } = render(ContextWindowRing, { props: { report: REPORT } });

    await fireEvent.click(trigger(container));

    const panel = await findByTestId('context-window');
    expect(panel.textContent).toContain(COPY.summary('84,000', '200,000'));
    const rows = [...panel.querySelectorAll('[data-category]')];
    expect(rows.map((row) => row.getAttribute('data-category'))).toEqual([
      'system',
      'tools',
      'messages',
      'memory',
      'attachments',
    ]);
    expect(
      rows.map((row) => row.querySelector('.weft-context-window__tokens')?.textContent),
    ).toEqual(['4,000', '10,000', '60,000', '6,000', '4,000']);
    const meters = [...panel.querySelectorAll('[role="meter"]')];
    expect(meters.map((meter) => meter.getAttribute('aria-label'))).toEqual([
      COPY.category('Instructions', '4,000'),
      COPY.category('Tools', '10,000'),
      COPY.category('Messages', '60,000'),
      COPY.category('Memory', '6,000'),
      COPY.category('Attachments', '4,000'),
    ]);
    expect(meters[2]?.getAttribute('aria-valuenow')).toBe('60000');
  });

  test('adds the provider’s own count, or says there is none yet', async () => {
    const { container, findByTestId, rerender } = render(ContextWindowRing, {
      props: { report: REPORT },
    });
    await fireEvent.click(trigger(container));
    const panel = await findByTestId('context-window');
    expect(panel.textContent).toContain(COPY.reported('80,500'));

    void rerender({ report: { ...REPORT, usedReported: null } });
    await waitFor(() => expect(panel.textContent).toContain(COPY.notReported));
  });

  test('says the window is unavailable when the report could not be read, and shows nothing while it is being read', () => {
    const failed = render(ContextWindowRing, { props: { report: undefined, failed: true } });
    expect(failed.container.textContent).toContain(COPY.unavailable);
    cleanup();

    const pending = render(ContextWindowRing, { props: { report: undefined } });
    expect(pending.container.textContent?.trim()).toBe('');
  });
});
