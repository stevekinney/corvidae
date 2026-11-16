/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import.
setupHappyDom();

const { render, cleanup, fireEvent } = await import('@testing-library/svelte');
const { default: PayloadInspector } = await import('./payload-inspector.svelte');
const { headerCount, jsonOnlyKeysOf, withoutKeys } = await import('./payload-inspector-model.ts');

beforeEach(() => document.body.replaceChildren());
afterEach(() => cleanup());

const INPUT = { question: 'Where is order 4472?', maximumSteps: 8, runId: 'run-71c9d0' };

describe('the fields only the JSON view shows (jsonOnly)', () => {
  test('leave the Fields view with the others, and end it with a muted "1 more in JSON" line', () => {
    const view = render(PayloadInspector, { value: INPUT, label: 'Input', jsonOnly: ['runId'] });

    const terms = [...view.container.querySelectorAll('dt')].map((term) =>
      term.textContent?.trim(),
    );
    expect(terms).toEqual(['Question', 'Maximum steps']);
    expect(view.container.textContent).not.toContain('run-71c9d0');
    expect(view.container.querySelector('.cinder-payload-inspector__more')?.textContent).toBe(
      '1 more in JSON',
    );
  });

  test('count every top-level field in the header and say how many are JSON only', () => {
    const view = render(PayloadInspector, { value: INPUT, label: 'Input', jsonOnly: ['runId'] });

    expect(view.container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
      '3 fields, 1 in JSON only',
    );
  });

  test('are all there in the JSON view, so nothing is lost', async () => {
    const view = render(PayloadInspector, { value: INPUT, label: 'Input', jsonOnly: ['runId'] });

    await fireEvent.click(view.getByRole('radio', { name: 'JSON' }));

    expect(view.container.textContent).toContain('run-71c9d0');
    expect(view.container.querySelector('.cinder-payload-inspector__more')).toBeNull();
  });

  test('say nothing when the value has none of the names, or is not an object', () => {
    const none = render(PayloadInspector, { value: INPUT, label: 'Input', jsonOnly: ['trace'] });
    expect(none.container.querySelector('.cinder-payload-inspector__more')).toBeNull();
    expect(none.container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
      '3 fields',
    );
    cleanup();

    const list = render(PayloadInspector, { value: [1, 2], label: 'Items', jsonOnly: ['runId'] });
    expect(list.container.querySelector('.cinder-payload-inspector__more')).toBeNull();
  });
});

describe('the model of the fields only the JSON view shows', () => {
  test('finds the names a value has, and writes the value without them', () => {
    expect(jsonOnlyKeysOf(INPUT, ['runId', 'trace'])).toEqual(['runId']);
    expect(jsonOnlyKeysOf('text', ['runId'])).toEqual([]);
    expect(jsonOnlyKeysOf(INPUT, undefined)).toEqual([]);
    expect(withoutKeys(INPUT, ['runId'])).toEqual({
      question: 'Where is order 4472?',
      maximumSteps: 8,
    });
    expect(withoutKeys(INPUT, [])).toBe(INPUT);
  });

  test('counts the fields before saying how many are JSON only, and the size after', () => {
    expect(headerCount(INPUT, { jsonOnly: 1 })).toBe('3 fields, 1 in JSON only');
    expect(headerCount(INPUT, { jsonOnly: 0 })).toBe('3 fields');
    expect(headerCount(INPUT, { jsonOnly: 1, bytes: 2048 })).toBe('3 fields, 1 in JSON only, 2 KB');
  });
});
