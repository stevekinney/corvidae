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
    expect(element.dataset['cinderVariant']).toBe('primary');
    expect(element.dataset['cinderSize']).toBe('sm');
  });

  test("beside a Button with no variant it takes Button's default, soft at md", () => {
    const { container } = render(SplitButtonFixture, {});
    const element = trigger(container);
    expect(element.dataset['cinderVariant']).toBe('soft');
    expect(element.dataset['cinderSize']).toBe('md');
  });

  test('its own variant wins over the Button beside it', () => {
    const { container } = render(SplitButtonFixture, {
      actionVariant: 'primary',
      triggerVariant: 'secondary',
    });
    expect(trigger(container).dataset['cinderVariant']).toBe('secondary');
  });

  test('outside a group it keeps its own bordered face unless a variant is set', () => {
    const plain = render(SplitButtonFixture, { grouped: false });
    expect(trigger(plain.container).classList.contains('cinder-button')).toBe(false);
    expect(trigger(plain.container).dataset['cinderVariant']).toBeUndefined();
    cleanup();
    const styled = render(SplitButtonFixture, { grouped: false, triggerVariant: 'ghost' });
    expect(trigger(styled.container).classList.contains('cinder-button')).toBe(true);
    expect(trigger(styled.container).dataset['cinderVariant']).toBe('ghost');
  });
});
