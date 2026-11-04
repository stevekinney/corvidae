import { rejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';

import { chooseFilterOption, requireElement } from './dom.test-support.ts';

describe('requireElement', () => {
  test('returns an element of the requested constructor and names both sides of a mismatch', () => {
    const button = document.createElement('button');
    expect(requireElement(button, HTMLButtonElement)).toBe(button);

    expect(() => requireElement(document.createElement('span'), HTMLButtonElement)).toThrow(
      new TypeError('Expected HTMLButtonElement, received HTMLSpanElement'),
    );
    expect(() => requireElement(null, HTMLButtonElement)).toThrow(
      new TypeError('Expected HTMLButtonElement, received nothing'),
    );
  });
});

describe('chooseFilterOption', () => {
  function viewForOptions(labels: string[]) {
    const combobox = document.createElement('button');
    const options = labels.map((label) => {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = label;
      return option;
    });
    let clickedOption: HTMLElement | undefined;
    combobox.addEventListener('click', () => {
      combobox.setAttribute('data-open', 'true');
    });
    for (const option of options) {
      option.addEventListener('click', () => {
        clickedOption = option;
      });
    }

    return {
      view: {
        findByRole: async (role: string, { name }: { name: string }) => {
          if (role === 'combobox' && name === 'Status') return combobox;
          throw new Error(`Unexpected role lookup: ${role} ${name}`);
        },
        findAllByRole: async (role: string) => {
          if (role === 'option') return options;
          throw new Error(`Unexpected role lookup: ${role}`);
        },
      },
      combobox,
      get clickedOption() {
        return clickedOption;
      },
    };
  }

  test('opens the filter and clicks the option matching the requested prefix', async () => {
    const fixture = viewForOptions(['Succeeded', 'Failed (3)']);

    await chooseFilterOption(fixture.view, 'Status', 'Failed');

    expect(fixture.combobox.dataset['open']).toBe('true');
    expect(fixture.clickedOption?.textContent).toBe('Failed (3)');
  });

  test('reports the requested option and available labels when no option matches', async () => {
    const fixture = viewForOptions(['Succeeded', 'Failed (3)']);

    expect(await rejectionOf(chooseFilterOption(fixture.view, 'Status', 'Pending'))).toEqual(
      new Error('No "Pending" option under Status: Succeeded, Failed (3)'),
    );
    expect(fixture.combobox.dataset['open']).toBe('true');
  });
});
