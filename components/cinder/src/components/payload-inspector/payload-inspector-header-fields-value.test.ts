/// <reference lib="dom" />
/**
 * The card's header and its Fields-only value: the count is a muted line under the label at the
 * start, never a line of its own at the inline end beside the copy button; and `fieldsValue` is laid
 * out and counted by the Fields view only, while the JSON view and Copy keep the stored payload.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import.
setupHappyDom();

const { render, cleanup, fireEvent, waitFor } = await import('@testing-library/svelte');
const { readFileSync } = await import('node:fs');
const { default: PayloadInspector } = await import('./payload-inspector.svelte');

const stylesheet = readFileSync(new URL('./payload-inspector.css', import.meta.url), 'utf8');

beforeEach(() => document.body.replaceChildren());
afterEach(() => cleanup());

const STORED = {
  kind: 'schedule',
  scheduleId: 'release-notes-digest',
  input: { branch: 'main' },
  workspaceAuthority: { workspaceId: 'workspace-1' },
};
const FIELDS = {
  branch: 'main',
  kind: 'schedule',
  scheduleId: 'release-notes-digest',
  workspaceAuthority: { workspaceId: 'workspace-1' },
};
const ENVELOPE_KEYS = ['kind', 'scheduleId', 'workspaceAuthority'];

describe('the header', () => {
  test('sets the count under the label, start-aligned, and keeps only the copy button at the end', () => {
    const view = render(PayloadInspector, { value: { a: 1, b: 2 }, label: 'Input' });
    const title = view.container.querySelector('.cinder-payload-inspector__title');
    expect(title?.querySelector('.cinder-payload-inspector__label')?.textContent).toBe('Input');
    expect(title?.querySelector('.cinder-payload-inspector__size')?.textContent).toBe('2 fields');
    const actions = view.container.querySelector('.cinder-payload-inspector__header-actions');
    expect(actions?.querySelector('.cinder-payload-inspector__size')).toBeNull();
    expect(actions?.querySelector('.cinder-copy-button')).not.toBeNull();
    expect(stylesheet).toMatch(
      /\.cinder-payload-inspector__title \{[^}]*flex-direction: column;[^}]*align-items: flex-start;/,
    );
  });

  test('a bare payload draws no count', () => {
    const view = render(PayloadInspector, { value: { a: 1 }, label: 'Input', bare: true });
    expect(view.container.querySelector('.cinder-payload-inspector__size')).toBeNull();
  });
});

describe('fieldsValue', () => {
  test('is what the Fields view lays out and counts, with its JSON-only keys in the JSON view', () => {
    const view = render(PayloadInspector, {
      value: STORED,
      fieldsValue: FIELDS,
      jsonOnly: ENVELOPE_KEYS,
      label: 'Input',
    });
    const panel = view.container.querySelector('.cinder-payload-inspector__panel');
    expect(panel?.textContent).toContain('Branch');
    expect(panel?.textContent).toContain('main');
    // The envelope's keys are JSON only, and the stored `input` key is never a field.
    expect(panel?.textContent).not.toContain('workspace-1');
    expect(panel?.textContent).not.toContain('Schedule ID');
    expect(view.container.querySelector('.cinder-payload-inspector__more')?.textContent).toBe(
      '3 more in JSON',
    );
    expect(view.container.querySelector('.cinder-payload-inspector__size')?.textContent).toContain(
      '4 fields, 3 in JSON only',
    );
  });

  test('never reaches the JSON view or Copy, which show the payload as stored', async () => {
    const view = render(PayloadInspector, {
      value: STORED,
      fieldsValue: FIELDS,
      jsonOnly: ENVELOPE_KEYS,
      label: 'Input',
    });
    let written = '';
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written = text;
        },
      },
    });
    try {
      const copy = view.container.querySelector<HTMLButtonElement>('.cinder-copy-button');
      await fireEvent.click(copy!);
      await waitFor(() => expect(written).not.toBe(''));
      expect(JSON.parse(written)).toEqual(STORED);
    } finally {
      if (clipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard');
      else Object.defineProperty(navigator, 'clipboard', clipboard);
    }
    await fireEvent.click(view.getByRole('radio', { name: 'JSON' }));
    // The stored envelope: `input` nested, as the engine keeps it, and no Fields-only flattening.
    expect(view.container.textContent).toContain('input');
  });
});
