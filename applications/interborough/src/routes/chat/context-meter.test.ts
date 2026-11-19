/**
 * The chat's one context meter (COR-2438): a bar and its percentage by Send, the tokens behind it in
 * a tooltip, and the breakdown it opens to. The report is the Bureau's (`bureau.contexts.window`);
 * the meter only draws it.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy/chat.ts';
import type { ContextWindow } from '../../lib/bureau-client.ts';
import ContextMeter from './context-meter.svelte';

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
  const found = container.querySelector<HTMLElement>('button.weft-context-meter');
  if (found === null) throw new Error('The meter did not render.');
  return found;
}

describe('the context meter', () => {
  test('reads the share of the window as a percentage, and names it in full on its button', () => {
    const { container } = render(ContextMeter, { props: { report: REPORT } });

    expect(container.querySelector('.weft-context-meter__reading')?.textContent).toBe('42%');
    expect(trigger(container).getAttribute('aria-label')).toBe(
      COPY.trigger(42, '84,000', '200,000'),
    );
    expect(trigger(container).getAttribute('data-tone')).toBe('normal');
    expect(container.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('42');
  });

  test('says the tokens behind the percentage on hover and focus, never as its reading', async () => {
    const { container } = render(ContextMeter, { props: { report: REPORT } });

    await fireEvent.focus(trigger(container));
    await waitFor(() => expect(document.body.textContent).toContain('84K of 200K tokens'));
    expect(container.querySelector('.weft-context-meter__reading')?.textContent).not.toContain(
      'tokens',
    );
  });

  test('changes its tone as the window fills', () => {
    const { container, rerender } = render(ContextMeter, { props: { report: REPORT } });

    void rerender({ report: { ...REPORT, usedEstimated: 150_000 } });
    expect(trigger(container).getAttribute('data-tone')).toBe('warning');
    void rerender({ report: { ...REPORT, usedEstimated: 190_000 } });
    expect(trigger(container).getAttribute('data-tone')).toBe('danger');
  });

  test('reads the token count, with an empty bar, when the model’s window is not known', () => {
    const { container } = render(ContextMeter, {
      props: { report: { ...REPORT, maxTokens: null } },
    });

    expect(container.querySelector('.weft-context-meter__reading')?.textContent).toBe('84K tokens');
    expect(trigger(container).getAttribute('aria-label')).toBe(COPY.trigger(null, '84,000', null));
    expect(trigger(container).getAttribute('data-tone')).toBe('unknown');
    expect(container.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('0');
  });

  test('opens to what fills the window, one meter for each, in the Bureau’s order', async () => {
    const { container, findByTestId } = render(ContextMeter, { props: { report: REPORT } });

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
    const meters = [...panel.querySelectorAll('[role="meter"]')];
    expect(meters.map((meter) => meter.getAttribute('aria-label'))).toEqual([
      COPY.category('Instructions', '4,000'),
      COPY.category('Tools', '10,000'),
      COPY.category('Messages', '60,000'),
      COPY.category('Memory', '6,000'),
      COPY.category('Attachments', '4,000'),
    ]);
    expect(panel.textContent).toContain(COPY.reported('80,500'));
  });

  test('draws its track with the contrast rule, so an empty window still reads as a meter in both themes (18c)', async () => {
    const css = await Bun.file(new URL('../../styles/chat.css', import.meta.url)).text();
    const start = css.indexOf('.weft-context-meter .cinder-meter__track {');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(css.slice(start, css.indexOf('}', start))).toContain(
      'box-shadow: inset 0 0 0 1px var(--cinder-border-contrast);',
    );
    const tokens = await Bun.file(
      new URL('../../../../../components/cinder/src/styles/tokens-base.css', import.meta.url),
    ).text();
    expect(tokens).toContain('--cinder-border-contrast:');
  });

  test('says the window is unavailable when the report could not be read, and shows nothing while it is being read', () => {
    const failed = render(ContextMeter, { props: { report: undefined, failed: true } });
    expect(failed.container.textContent).toContain(COPY.unavailable);
    cleanup();

    const pending = render(ContextMeter, { props: { report: undefined } });
    expect(pending.container.textContent?.trim()).toBe('');
  });
});
