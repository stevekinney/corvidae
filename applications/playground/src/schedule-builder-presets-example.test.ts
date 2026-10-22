/// <reference lib="dom" />
/**
 * The "Presets mode" ScheduleBuilder example says Presets is the default authoring mode, and
 * ScheduleBuilder opens a seeded cron value on Cron. Seeding the example with a cron value moved
 * it off Presets, so the example leaves `value` unset and this test pins that it opens on Presets.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: PresetsExample } = await import(
  './examples/schedule-builder/presets.example.svelte'
);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('ScheduleBuilder "Presets mode" example', () => {
  test('opens on the Presets tab', () => {
    const { container, getByRole } = render(PresetsExample, {});

    expect(container.querySelector('[data-sb-panel="presets"]')).not.toBeNull();
    expect(container.querySelector('[data-sb-panel="cron"]')).toBeNull();
    expect(getByRole('tab', { name: 'Presets' }).getAttribute('aria-selected')).toBe('true');
  });

  test('the published example source does not seed a cron value', () => {
    const entries: { id: string; code: string }[] = JSON.parse(
      readFileSync(
        new URL(
          '../../../components/cinder/src/components/schedule-builder/schedule-builder.examples.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).examples;
    const presets = entries.find((entry) => entry.id === 'presets');

    expect(presets).toBeDefined();
    expect(presets?.code).not.toContain("mode: 'cron'");
  });
});
