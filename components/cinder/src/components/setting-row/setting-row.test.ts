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

  test('the control sits at the end unless controlAlign asks it to fill the column', () => {
    const control = createRawSnippet(() => ({
      render: () => '<input id="align-setting" />',
    }));
    const end = render(SettingRow, {
      props: { id: 'align-setting', label: 'Name', control },
    });
    expect(
      end.container.querySelector('.cinder-setting-row')?.hasAttribute('data-cinder-control-align'),
    ).toBe(false);
    end.unmount();

    const stretch = render(SettingRow, {
      props: { id: 'align-setting', label: 'Name', controlAlign: 'stretch', control },
    });
    expect(
      stretch.container
        .querySelector('.cinder-setting-row')
        ?.getAttribute('data-cinder-control-align'),
    ).toBe('stretch');
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

  test('keeps its status after supporting content and before the error', () => {
    const { container } = render(SettingRow, {
      props: {
        id: 'sync-setting',
        label: 'Sync',
        description: 'Updates are saved automatically.',
        status: 'saved',
        error: 'The last update could not be saved.',
        control: createRawSnippet(() => ({
          render: () => '<button id="sync-setting" type="button">Sync now</button>',
        })),
      },
    });
    const children = Array.from(container.querySelector('.cinder-form-field')!.children);
    const descriptionIndex = children.findIndex(
      (element) => element.id === 'sync-setting-description',
    );
    const statusIndex = children.findIndex((element) =>
      element.classList.contains('cinder-setting-row__status'),
    );
    const errorIndex = children.findIndex((element) => element.id === 'sync-setting-error');
    expect(descriptionIndex).toBeGreaterThan(-1);
    expect(statusIndex).toBeGreaterThan(descriptionIndex);
    expect(errorIndex).toBeGreaterThan(statusIndex);
  });

  test('caps only descriptions at the shared prose measure on wide setting rows', async () => {
    const css = await Bun.file(new URL('./setting-row.css', import.meta.url)).text();
    expect(css).toMatch(
      /\.cinder-setting-row__field \.cinder-form-field__description\s*\{[^}]*max-inline-size:\s*var\(--cinder-content-width-prose\);/,
    );
    expect(css).not.toMatch(
      /\.cinder-setting-row__field \.cinder-form-field__note\s*\{[^}]*max-inline-size:/,
    );
    expect(css).not.toMatch(
      /\.cinder-setting-row__field \.cinder-form-field__warning\s*\{[^}]*max-inline-size:/,
    );
  });
});
