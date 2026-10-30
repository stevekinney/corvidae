/// <reference lib="dom" />
/**
 * The "Default schedule" ScheduleBuilder example says an omitted value opens on every day at
 * 9:00 AM in the browser's time zone. Seeding the example with a value would hide that, so the
 * example leaves `value` unset and this test pins what it opens on.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: DefaultExample } =
  await import('./examples/schedule-builder/default.example.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('ScheduleBuilder "Default schedule" example', () => {
  test('opens on every day at 9:00 AM', () => {
    const { container, getByLabelText } = render(DefaultExample, {});

    expect(container.querySelector('[data-sb-repeats="daily"]')).not.toBeNull();
    expect((getByLabelText('Repeats') as HTMLSelectElement).value).toBe('daily');
    expect(
      container.querySelector('.cinder-schedule-builder__summary-text')?.textContent,
    ).toContain('Every day at 9:00 AM');
  });

  test('the published example source does not seed a value', () => {
    const entries: { id: string; code: string }[] = JSON.parse(
      readFileSync(
        new URL(
          '../../../components/cinder/src/components/schedule-builder/schedule-builder.examples.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).examples;
    const example = entries.find((entry) => entry.id === 'default');

    expect(example).toBeDefined();
    expect(example?.code).toContain('$state<ScheduleValue>()');
  });
});
