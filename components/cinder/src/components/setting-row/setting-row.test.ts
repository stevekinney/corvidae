import { setupHappyDom } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';
setupHappyDom();
const { render } = await import('@testing-library/svelte');
const { default: SettingRow } = await import('./setting-row.svelte');
const { default: SettingRowInputFixture } = await import('./setting-row-input-fixture.svelte');

describe('SettingRow', () => {
  test('publishes FormField context to Input, including policy description', () => {
    const { container } = render(SettingRowInputFixture);
    expect(container.querySelector('.cinder-setting-row')).not.toBeNull();
    expect(container.querySelector('#setting')?.getAttribute('aria-describedby')).toBeTruthy();
    expect(container.textContent).toContain('Organization policy');
  });

  test('renders supported Toggle controls in the row', () => {
    const { container } = render(SettingRow, {
      props: {
        id: 'toggle-setting',
        label: 'Enabled',
        control: createRawSnippet(() => ({
          render: () => '<button role="switch" id="toggle-setting"></button>',
        })),
      },
    });
    expect(container.querySelector('.cinder-setting-row')).not.toBeNull();
  });

  test('draws a description action after the description, inside the described paragraph', () => {
    const { container } = render(SettingRow, {
      props: {
        id: 'space-used',
        label: 'Space used',
        description: 'Health lists this under Needs attention.',
        descriptionAction: createRawSnippet(() => ({
          render: () => '<a href="/health">Open Health</a>',
        })),
        control: createRawSnippet(() => ({
          render: () => '<span id="space-used">1.6 GB</span>',
        })),
      },
    });
    const description = container.querySelector('p.cinder-form-field__description');
    expect(description?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Health lists this under Needs attention. Open Health',
    );
    expect(description?.querySelector('a')?.getAttribute('href')).toBe('/health');
  });
});
