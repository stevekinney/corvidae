/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, cleanup } = await import('@testing-library/svelte');
const { default: SplitButtonFixture } =
  await import('../../test/fixtures/split-button-fixture.svelte');

afterEach(() => cleanup());

function trigger(container: HTMLElement): HTMLButtonElement {
  return requiredInstance(container.querySelector('button.trigger'), HTMLButtonElement);
}

describe('DropdownTrigger as half of a split button', () => {
  test('inside a ButtonGroup it draws as a Button of the variant and size beside it', () => {
    const { container } = render(SplitButtonFixture, {
      actionVariant: 'primary',
      actionSize: 'sm',
    });
    const element = trigger(container);
    expect(element.classList.contains('cinder-button')).toBe(true);
    expect(element.classList.contains('button-variant-primary')).toBe(true);
    expect(element.classList.contains('button-size-small')).toBe(true);
    expect(element.hasAttribute('data-cinder-variant')).toBe(false);
    expect(element.hasAttribute('data-cinder-size')).toBe(false);
  });

  test("beside a Button with no variant it takes Button's default, soft at md", () => {
    const { container } = render(SplitButtonFixture, {});
    const element = trigger(container);
    expect(element.classList.contains('button-variant-soft')).toBe(true);
    expect(element.classList.contains('button-size-medium')).toBe(true);
  });

  test('its own variant wins over the Button beside it', () => {
    const { container } = render(SplitButtonFixture, {
      actionVariant: 'primary',
      triggerVariant: 'secondary',
    });
    expect(trigger(container).classList.contains('button-variant-secondary')).toBe(true);
  });

  test('outside a group it keeps its own bordered face unless a variant is set', () => {
    const plain = render(SplitButtonFixture, { grouped: false });
    expect(trigger(plain.container).classList.contains('cinder-button')).toBe(false);
    expect(
      [...trigger(plain.container).classList].some((name) => /^button-(size|variant)-/.test(name)),
    ).toBe(false);
    cleanup();
    const styled = render(SplitButtonFixture, { grouped: false, triggerVariant: 'ghost' });
    expect(trigger(styled.container).classList.contains('cinder-button')).toBe(true);
    expect(trigger(styled.container).classList.contains('button-variant-ghost')).toBe(true);
  });
});
