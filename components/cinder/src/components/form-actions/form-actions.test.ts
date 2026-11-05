/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: FormActions } = await import('./form-actions.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const buttons = createRawSnippet(() => ({
  render: () =>
    '<span><button type="button">Reset to default</button><button type="submit">Save</button></span>',
}));
const summary = createRawSnippet(() => ({
  render: () => '<span>Saving raises the policy revision.</span>',
}));
const start = createRawSnippet(() => ({ render: () => '<button type="button">Delete</button>' }));

function bar(container: HTMLElement): HTMLElement {
  return requiredInstance(container.querySelector('.cinder-form-actions'), HTMLElement);
}

describe('FormActions', () => {
  test('is a named group with the summary on the left and the buttons on the right', () => {
    const { container } = render(FormActions, { props: { summary, end: buttons } });
    const group = bar(container);
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Form actions');
    const row = requiredInstance(group.querySelector('.cinder-form-actions__row'), HTMLElement);
    const [first, last] = [row.firstElementChild, row.lastElementChild];
    expect(first?.className).toContain('cinder-form-actions__summary');
    expect(first?.textContent?.trim()).toBe('Saving raises the policy revision.');
    expect(last?.className).toContain('cinder-form-actions__end');
    // Secondary first, the primary submit last, so it sits rightmost.
    const labels = [...(last?.querySelectorAll('button') ?? [])].map(
      (button) => button.textContent,
    );
    expect(labels).toEqual(['Reset to default', 'Save']);
  });

  test('a custom label names the group', () => {
    const { container } = render(FormActions, { props: { label: 'Agent actions', end: buttons } });
    expect(bar(container).getAttribute('aria-label')).toBe('Agent actions');
  });

  test('the unsaved-change count reads in neutral text and joins the summary (rows 49g, 47o)', () => {
    const many = render(FormActions, { props: { unsavedChanges: 2, summary, end: buttons } });
    const text = many.container.querySelector('.cinder-form-actions__summary')?.textContent ?? '';
    expect(text.replace(/\s+/g, ' ').trim()).toBe(
      '2 unsaved changes · Saving raises the policy revision.',
    );
    cleanup();
    const one = render(FormActions, { props: { unsavedChanges: 1, end: buttons } });
    expect(one.container.querySelector('.cinder-form-actions__summary')?.textContent?.trim()).toBe(
      '1 unsaved change',
    );
  });

  test('says nothing at zero changes, and keeps its live region mounted', () => {
    const { container } = render(FormActions, { props: { unsavedChanges: 0, end: buttons } });
    const region = requiredInstance(
      container.querySelector('.cinder-form-actions__summary'),
      HTMLElement,
    );
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent?.trim()).toBe('');
  });

  test('a failed save draws a danger alert above the buttons and keeps Save as the retry (row 50w)', () => {
    const { container } = render(FormActions, {
      props: {
        unsavedChanges: 2,
        errorTitle: 'Couldn’t save.',
        error: 'Interborough didn’t answer. Your choices are still here.',
        end: buttons,
      },
    });
    const alert = requiredInstance(container.querySelector('[role="alert"]'), HTMLElement);
    expect(alert.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Couldn’t save. Interborough didn’t answer. Your choices are still here.',
    );
    expect(alert.querySelector('strong')?.textContent).toBe('Couldn’t save.');
    const group = bar(container);
    expect(alert.compareDocumentPosition(group.querySelector('.cinder-form-actions__row')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(group.querySelector('button[type="submit"]')?.textContent).toBe('Save');
  });

  test('without an error there is no alert', () => {
    const { container } = render(FormActions, { props: { end: buttons } });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test('start controls sit between the summary and the buttons', () => {
    const { container } = render(FormActions, { props: { summary, start, end: buttons } });
    const row = requiredInstance(container.querySelector('.cinder-form-actions__row'), HTMLElement);
    expect([...row.children].map((child) => child.className.split(' ').pop())).toEqual([
      'cinder-form-actions__summary',
      'cinder-form-actions__start',
      'cinder-form-actions__end',
    ]);
  });

  test('sticky is a marker the stylesheet pins, and it is off by default (row 41b)', () => {
    const plain = render(FormActions, { props: { end: buttons } });
    expect(bar(plain.container).hasAttribute('data-cinder-sticky')).toBe(false);
    cleanup();
    const sticky = render(FormActions, { props: { sticky: true, end: buttons } });
    expect(bar(sticky.container).hasAttribute('data-cinder-sticky')).toBe(true);
  });

  test('a sticky bar publishes its height for the toast region while it is mounted', () => {
    const { unmount } = render(FormActions, { props: { sticky: true, end: buttons } });
    // happy-dom lays nothing out, so the height is zero, but the property is published.
    expect(
      document.documentElement.style.getPropertyValue('--_cinder-docked-action-bar-height'),
    ).toBe('0px');
    unmount();
    expect(
      document.documentElement.style.getPropertyValue('--_cinder-docked-action-bar-height'),
    ).toBe('');
  });
});
