/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render, waitFor } = await import('@testing-library/svelte');
const { default: InputButtonGroupFixture } =
  await import('../../test/fixtures/input-button-group-fixture.svelte');

afterEach(() => cleanup());

const sizes = ['sm', 'md', 'lg'] as const;

const sourceDirectory = resolve(import.meta.dir, '../..');

/** The value of `property` in the first rule whose selector is exactly `selector`. */
function declarationValue(path: string, selector: string, property: string): string | undefined {
  const root = parse(readFileSync(resolve(sourceDirectory, path), 'utf8'));
  let found: string | undefined;
  root.walkRules((rule) => {
    if (found !== undefined || rule.selector.replace(/\s+/g, ' ') !== selector) return;
    rule.walkDecls(property, (declaration) => {
      found ??= declaration.value.replace(/\s+/g, ' ');
    });
  });
  return found;
}

describe('ButtonGroup with an Input and a Button', () => {
  for (const size of sizes) {
    test(`the field and the Button are group members at size ${size}`, async () => {
      const { container } = render(InputButtonGroupFixture, { props: { size } });
      const group = container.querySelector('[role="group"]');
      expect(group?.getAttribute('aria-labelledby')).toBe('api-key-label');
      expect(container.querySelector('#api-key-label')?.textContent?.trim()).toBe('API key');

      const field = group?.querySelector(':scope > .cinder-input-field');
      const button = group?.querySelector(':scope > .cinder-button');
      expect(field).not.toBeNull();
      expect(button).not.toBeNull();
      await waitFor(() => {
        expect(field?.hasAttribute('data-cinder-button-group-item')).toBe(true);
        expect(button?.hasAttribute('data-cinder-button-group-item')).toBe(true);
      });

      // Both controls take their height from the same step of the shared scale,
      // so naming the same size is what makes them match.
      expect(field?.querySelector('input')?.getAttribute('data-cinder-size')).toBe(size);
      expect(button?.getAttribute('data-cinder-size')).toBe(size);

      // The group's label comes from the enclosing FormField, so the field
      // inside it adds no label that would make it taller than the Button.
      expect(group?.querySelector('label')).toBeNull();
    });
  }

  for (const size of sizes) {
    test(`the Input and the Button resolve to the same control height token at size ${size}`, () => {
      const controlHeight = `var(--cinder-control-height-${size})`;
      expect(
        declarationValue('styles/tokens-base.css', ':root', `--cinder-button-height-${size}`),
      ).toBe(controlHeight);
      expect(
        declarationValue(
          'components/button/button.css',
          `.cinder-button[data-cinder-size='${size}']`,
          'min-height',
        ),
      ).toBe(`var(--cinder-button-height-${size})`);

      const inputHeight = `--_cinder-input-height`;
      if (size === 'md') {
        expect(declarationValue('components/input/input.css', '.cinder-input', inputHeight)).toBe(
          controlHeight,
        );
      } else {
        expect(
          declarationValue(
            'components/input/input.css',
            `.cinder-input[data-cinder-size='${size}']`,
            inputHeight,
          ),
        ).toBe(controlHeight);
      }
    });
  }

  test('an Input with addons lands on the same height: the frame border makes up the 2px the input drops', () => {
    expect(
      declarationValue(
        'components/input/input.css',
        '.cinder-input-group > .cinder-input',
        'min-height',
      ),
    ).toBe('calc(var(--_cinder-input-height) - 2px)');
  });

  test('the group flattens the field corners that meet a neighbour and stops stretching members', () => {
    const css = readFileSync(
      resolve(sourceDirectory, 'components/button-group/button-group.css'),
      'utf8',
    );
    expect(
      declarationValue(
        'components/button-group/button-group.css',
        '.cinder-button-group:has(> .cinder-input-field)',
        'align-items',
      ),
    ).toBe('flex-start');
    for (const surface of ['.cinder-input', '.cinder-input-group']) {
      expect(css).toContain(surface);
    }
    expect(css).toMatch(
      /:not\(:last-child\)\s+:is\(\.cinder-input, \.cinder-input-group\)\s*\{\s*border-start-end-radius: 0;\s*border-end-end-radius: 0;/,
    );
    expect(css).toMatch(
      /:not\(:first-child\)\s+:is\(\.cinder-input, \.cinder-input-group\)\s*\{\s*border-start-start-radius: 0;\s*border-end-start-radius: 0;/,
    );
  });
});
