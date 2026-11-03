/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { declarationsFor } from '../../test/css.ts';

// setupHappyDom() MUST run before any `@testing-library/svelte` import.
setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { createRawSnippet } = await import('svelte');
const { default: AccessGate } = await import('./access-gate.svelte');

const css = await Bun.file(new URL('./access-gate.css', import.meta.url)).text();

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const actions = createRawSnippet(() => ({
  render: () =>
    '<span><button type="button">See your scopes</button><button type="button">Back to Home</button></span>',
}));

const forbidden = {
  granted: false,
  variant: 'section',
  title: 'Your sign-in can’t open Hooks',
  reason: 'Settings › API reference › Your scopes shows what it can do.',
  requirement: 'hooks:read',
} as const;

describe('AccessGate section content', () => {
  test('names what is blocked in the person’s words, with the reason and the scope on its own line', () => {
    const { container, getByRole } = render(AccessGate, forbidden);

    const heading = getByRole('heading', { name: 'Your sign-in can’t open Hooks' });
    expect(heading.tagName).toBe('H3');
    const section = container.querySelector('section.cinder-access-gate');
    expect(section?.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(container.querySelector('.cinder-access-gate__section-reason')?.textContent).toBe(
      'Settings › API reference › Your scopes shows what it can do.',
    );
    const requirement = container.querySelector('.cinder-access-gate__requirement');
    expect(requirement?.textContent?.trim()).toBe('requires hooks:read');
    expect(requirement?.querySelector('code')).not.toBeNull();
    expect(section?.getAttribute('aria-describedby')).toContain(requirement!.id);
  });

  test('the title defaults to "Section locked" and headingLevel sets the heading tag', () => {
    const { getByRole } = render(AccessGate, {
      granted: false,
      variant: 'section',
      reason: 'Requires scope: storage:admin',
      headingLevel: 1,
    });
    expect(getByRole('heading', { level: 1, name: 'Section locked' })).not.toBeNull();
  });

  test('clamps an out-of-range headingLevel back to a valid tag', () => {
    const { container } = render(AccessGate, {
      ...forbidden,
      headingLevel: 9 as never,
    });
    expect(container.querySelector('.cinder-access-gate__section-title')?.tagName).toBe('H6');
  });

  test('renders no requirement line without a requirement', () => {
    const { container } = render(AccessGate, {
      granted: false,
      variant: 'section',
      reason: 'Requires admin.',
    });
    expect(container.querySelector('.cinder-access-gate__requirement')).toBeNull();
  });

  test('puts the lock in a decorative neutral disc', () => {
    const { container } = render(AccessGate, forbidden);
    const disc = container.querySelector('.cinder-access-gate__section-icon');
    expect(disc?.getAttribute('aria-hidden')).toBe('true');
    expect(disc?.querySelector('svg')).not.toBeNull();
    const rule = declarationsFor(css, '.cinder-access-gate__section-icon');
    expect(rule.get('background')).toBe('var(--cinder-surface-inset)');
    expect(rule.get('border-radius')).toBe('var(--cinder-radius-full)');
    expect(rule.get('inline-size')).toBe('var(--cinder-space-10)');
  });

  test('renders the actions snippet in a row under the gate', () => {
    const { container, getAllByRole } = render(AccessGate, { ...forbidden, actions });
    const row = container.querySelector('.cinder-access-gate__actions');
    const buttons = getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'See your scopes',
      'Back to Home',
    ]);
    expect(buttons.every((button) => row?.contains(button))).toBe(true);
  });

  test('renders no actions row without an actions snippet', () => {
    const { container } = render(AccessGate, forbidden);
    expect(container.querySelector('.cinder-access-gate__actions')).toBeNull();
  });

  test('a granted section gate renders its children and none of the placeholder', () => {
    const { container, getByText } = render(AccessGate, {
      ...forbidden,
      granted: true,
      children: createRawSnippet(() => ({ render: () => '<p>Hooks list</p>' })),
    });
    expect(getByText('Hooks list')).not.toBeNull();
    expect(container.querySelector('section')).toBeNull();
  });
});

describe('AccessGate section layouts', () => {
  test('defaults to the compact inline layout: a bordered card with a 40px disc', () => {
    const { container } = render(AccessGate, forbidden);
    expect(container.querySelector('.cinder-access-gate')?.getAttribute('data-cinder-layout')).toBe(
      'inline',
    );
    const card = declarationsFor(css, ".cinder-access-gate[data-cinder-variant='section']");
    expect(card.get('border')).toBe('1px solid var(--cinder-border)');
    expect(card.get('border-radius')).toBe('var(--cinder-radius-lg)');
    expect(card.get('align-items')).toBe('center');
  });

  test('the page layout has no card, centres in its region and grows the disc to 48px', () => {
    const { container } = render(AccessGate, { ...forbidden, layout: 'page', headingLevel: 1 });
    expect(container.querySelector('.cinder-access-gate')?.getAttribute('data-cinder-layout')).toBe(
      'page',
    );
    const page = declarationsFor(
      css,
      ".cinder-access-gate[data-cinder-variant='section'][data-cinder-layout='page']",
    );
    expect(page.get('border')).toBe('0');
    expect(page.get('justify-content')).toBe('center');
    const disc = declarationsFor(
      css,
      ".cinder-access-gate[data-cinder-layout='page'] .cinder-access-gate__section-icon",
    );
    expect(disc.get('inline-size')).toBe('var(--cinder-space-12)');
    const title = declarationsFor(
      css,
      ".cinder-access-gate[data-cinder-layout='page'] .cinder-access-gate__section-title",
    );
    expect(title.get('font-size')).toBe('var(--cinder-text-lg)');
  });

  test('an unknown layout behaves as the inline layout', () => {
    const { container } = render(AccessGate, { ...forbidden, layout: 'bogus' as never });
    expect(container.querySelector('.cinder-access-gate')?.getAttribute('data-cinder-layout')).toBe(
      'inline',
    );
  });
});
