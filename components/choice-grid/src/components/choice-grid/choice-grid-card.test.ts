/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: Fixture } = await import('./choice-grid-card-fixture.test.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function radios(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'));
}

describe('ChoiceGrid card variant (row 33e)', () => {
  test('a host sets a minimum card height with --_cinder-choice-card-min-block-size, and the default is none', async () => {
    const css = await Bun.file(
      new URL('../choice-grid-item/choice-grid-item.css', import.meta.url),
    ).text();
    const card = /\.cinder-choice-grid-item\[data-cinder-variant='card'\] \{([^}]*)\}/u.exec(
      css,
    )?.[1];

    expect(card).toContain('min-block-size: var(--_cinder-choice-card-min-block-size, 0);');
  });

  test('each card has an indicator, an icon, a title and a description', () => {
    const { container } = render(Fixture);
    const [mcp, openapi] = radios(container);
    for (const card of [mcp, openapi]) {
      expect(card?.getAttribute('data-cinder-variant')).toBe('card');
      expect(card?.querySelector('.cinder-choice-grid-item__indicator')).not.toBeNull();
      expect(card?.querySelector('.cinder-choice-grid-item__icon svg')).not.toBeNull();
    }
    expect(mcp?.querySelector('.cinder-choice-grid-item__title')?.textContent?.trim()).toBe(
      'MCP server',
    );
    expect(mcp?.querySelector('.cinder-choice-grid-item__description')?.textContent).toBe(
      'A server that offers tools, such as GitHub or a database.',
    );
    expect(openapi?.querySelector('.cinder-choice-grid-item__description')?.textContent).toBe(
      'A web API described by an OpenAPI 3 file.',
    );
  });

  test('the description names the card for assistive technology', () => {
    const { container } = render(Fixture);
    const [mcp] = radios(container);
    const describedBy = mcp?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(
      'A server that offers tools, such as GitHub or a database.',
    );
  });

  test('the default choice is selected and choosing the other card moves the selection', async () => {
    const { container } = render(Fixture);
    const [mcp, openapi] = radios(container);
    expect(mcp?.getAttribute('aria-checked')).toBe('true');
    expect(mcp?.hasAttribute('data-cinder-selected')).toBe(true);
    expect(openapi?.getAttribute('aria-checked')).toBe('false');
    await fireEvent.click(requiredInstance(openapi, HTMLElement));
    expect(radios(container)[0]?.getAttribute('aria-checked')).toBe('false');
    expect(radios(container)[1]?.getAttribute('aria-checked')).toBe('true');
  });

  test('a multiple grid keeps checkbox roles and marks itself for the square indicator', () => {
    const { container } = render(Fixture, { props: { multiple: true, values: ['mcp'] } });
    const grid = requiredInstance(container.querySelector('[role="group"]'), HTMLElement);
    expect(grid.hasAttribute('data-cinder-multiple')).toBe(true);
    expect(container.querySelectorAll('[role="checkbox"]').length).toBe(2);
  });

  test('the tile variant ignores icon and description, so existing grids do not change', () => {
    const { container } = render(Fixture, { props: { variant: 'tile' } });
    const [mcp] = radios(container);
    expect(mcp?.hasAttribute('data-cinder-variant')).toBe(false);
    expect(mcp?.querySelector('.cinder-choice-grid-item__indicator')).toBeNull();
    expect(mcp?.querySelector('.cinder-choice-grid-item__description')).toBeNull();
    expect(mcp?.hasAttribute('aria-describedby')).toBe(false);
  });

  test('a card rests on the muted hairline, centres a label without a description, and the group shares one row height', async () => {
    const squash = (text: string) => text.replace(/\s+/gu, ' ');
    const itemCss = squash(
      await Bun.file(new URL('../choice-grid-item/choice-grid-item.css', import.meta.url)).text(),
    );
    expect(itemCss).toContain(':not(:focus-visible) { border-color: var(--cinder-border-muted); }');
    expect(itemCss).toContain(
      ':not( :has(.cinder-choice-grid-item__description) ) { align-items: center; }',
    );
    const gridCss = squash(await Bun.file(new URL('./choice-grid.css', import.meta.url)).text());
    expect(gridCss).toContain("[data-cinder-variant='card'] { grid-auto-rows: 1fr; }");
  });
});
