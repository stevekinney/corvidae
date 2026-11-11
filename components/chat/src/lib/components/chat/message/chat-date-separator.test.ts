/**
 * COR-2281 M1: the date separator reads as a sentence-case word ("Today"), muted, with no capitals
 * or letter spacing.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, cleanup } = await import('@testing-library/svelte');
const { default: ChatDateSeparator } = await import('./chat-date-separator.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const source = readFileSync(join(import.meta.dir, 'chat-date-separator.svelte'), 'utf8');

function textRule(): string {
  const start = source.indexOf('.chat-date-separator-text {');
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('}', start));
}

describe('ChatDateSeparator', () => {
  test('names today in sentence case', () => {
    const { container } = render(ChatDateSeparator, { props: { date: new Date() } });
    expect(container.querySelector('.chat-date-separator-text')?.textContent?.trim()).toBe('Today');
  });

  test('names a past day with the formatter it was given, unchanged', () => {
    const { container } = render(ChatDateSeparator, {
      props: { date: '2026-11-02T12:00:00.000Z', dateFormatter: () => 'Monday, November 2' },
    });
    expect(container.querySelector('.chat-date-separator-text')?.textContent?.trim()).toBe(
      'Monday, November 2',
    );
  });

  test('draws the day muted, with no capitals and no letter spacing', () => {
    const rule = textRule();
    expect(rule).toContain('color: var(--cinder-text-muted)');
    expect(rule).not.toContain('text-transform');
    expect(rule).not.toContain('letter-spacing');
  });
});
