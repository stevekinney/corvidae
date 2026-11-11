import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

// happy-dom does not implement HTMLDialogElement.showModal / close, which the lightbox's Modal
// relies on; stub them the way image-lightbox.test.ts does.
if (typeof HTMLDialogElement !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      value: function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
      configurable: true,
      writable: true,
    });
  }
  if (!HTMLDialogElement.prototype.close) {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      value: function (this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
      configurable: true,
      writable: true,
    });
  }
}

const { render, cleanup, fireEvent, waitFor } = await import('@testing-library/svelte');
const { default: MessageAttachments } = await import('./message-attachments.svelte');

afterEach(() => cleanup());

const source = readFileSync(resolve(import.meta.dir, 'message-attachments.svelte'), 'utf8');

describe('MessageAttachments image layout contract', () => {
  test('renders a resting placeholder box without changing the image element shape', () => {
    const { container } = render(MessageAttachments, {
      props: {
        images: [
          { type: 'image', source: { kind: 'remote-url', url: 'portrait.png' }, alt: 'Portrait' },
        ],
      },
    });
    const figure = container.querySelector<HTMLElement>('.message-attachment');
    const button = container.querySelector('.message-attachment-button');
    const image = container.querySelector('.message-attachment-image');

    expect(figure?.hasAttribute('data-cinder-image-placeholder')).toBe(true);
    expect(figure?.style.aspectRatio).toBe('');
    expect(button?.contains(image)).toBe(true);
    expect(image?.getAttribute('width')).toBeNull();
    expect(image?.getAttribute('height')).toBeNull();
  });

  test('reserves intrinsic image geometry and has a fallback placeholder ratio', () => {
    expect(source).toContain('aspect-ratio: 4 / 3');
    expect(source).toContain('aspect-ratio: ${dimensions.width} / ${dimensions.height}');
    expect(source).toContain('width={dimensions?.width}');
    expect(source).toContain('height={dimensions?.height}');
    expect(source).toContain('background: var(--cinder-surface-inset)');
  });

  test('bounds a single image without reserving a second grid column', () => {
    expect(source).toContain('inline-size: fit-content;');
    expect(source).toContain('max-inline-size: min(32rem, 100%)');
    expect(source).toContain('inline-size: min(20rem, 100%);');
    expect(source).toContain('max-block-size: 24rem');
    expect(source).toContain('object-fit: contain');
  });

  test('keeps lazy asynchronous image loading', () => {
    expect(source).toContain("loading?: 'lazy' | 'eager'");
    expect(source).toContain('{loading}');
    expect(source).toContain('decoding="async"');
  });

  test('provides a keyboard-operable maximize affordance', () => {
    expect(source).toMatch(/import \{[^}]*\bMaximize2\b[^}]*\} from '@lostgradient\/cinder'/);
    expect(source).toContain('aria-label={`View image: ${alt}`}');
    expect(source).toContain('title="Maximize image"');
    expect(source).toContain(
      '.message-attachment-button:focus-visible .message-attachment-maximize',
    );
    expect(source).toContain('aria-hidden="true"');
    expect(source).toContain('opacity: 1;');
  });

  test('a failed image keeps its dashed footprint with its name, Retry and no zoom', async () => {
    const onimageerror = mock(() => {});
    const { container } = render(MessageAttachments, {
      props: {
        images: [
          { type: 'image', source: { kind: 'remote-url', url: 'missing.png' }, alt: 'receipt.png' },
        ],
        onimageerror,
      },
    });
    const image = container.querySelector('.message-attachment-image');
    if (image === null) throw new Error('The thumbnail did not render.');
    await fireEvent.error(image);

    const figure = container.querySelector('.message-attachment');
    await waitFor(() => expect(figure?.hasAttribute('data-unavailable')).toBe(true));
    expect(onimageerror).toHaveBeenCalledTimes(1);
    expect(figure?.querySelector('.message-attachment-button')).toBeNull();
    expect(figure?.querySelector('img')).toBeNull();
    expect(figure?.querySelector('.message-attachment-maximize')).toBeNull();
    expect(figure?.querySelector('.message-attachment-unavailable-text')?.textContent).toMatch(
      /receipt\.png\s+didn't load/,
    );
    expect(figure?.querySelector('.message-attachment-retry')?.textContent).toContain('Retry');
    expect(source).toContain('border: 1px dashed var(--cinder-border-strong)');
  });

  test('Retry requests the image again in a fresh element', async () => {
    const { container } = render(MessageAttachments, {
      props: {
        images: [{ type: 'image', source: { kind: 'remote-url', url: 'flaky.png' }, alt: 'Flaky' }],
      },
    });
    const image = container.querySelector('.message-attachment-image');
    if (image === null) throw new Error('The thumbnail did not render.');
    await fireEvent.error(image);
    const retry = await waitFor(() => {
      const button = container.querySelector('.message-attachment-retry');
      if (button === null) throw new Error('Retry is not shown yet.');
      return button;
    });
    await fireEvent.click(retry);

    await waitFor(() =>
      expect(container.querySelector('.message-attachment-image')?.getAttribute('src')).toBe(
        'flaky.png',
      ),
    );
    expect(container.querySelector('.message-attachment-image')).not.toBe(image);
    expect(container.querySelector('[data-unavailable]')).toBeNull();
  });

  test('a new address in the failed slot loads normally', async () => {
    const view = render(MessageAttachments, {
      props: {
        images: [{ type: 'image', source: { kind: 'remote-url', url: 'old.png' }, alt: 'Chart' }],
      },
    });
    const image = view.container.querySelector('.message-attachment-image');
    if (image === null) throw new Error('The thumbnail did not render.');
    await fireEvent.error(image);
    await waitFor(() => expect(view.container.querySelector('[data-unavailable]')).not.toBeNull());

    await view.rerender({
      images: [{ type: 'image', source: { kind: 'remote-url', url: 'new.png' }, alt: 'Chart' }],
    });
    expect(view.container.querySelector('[data-unavailable]')).toBeNull();
    expect(view.container.querySelector('.message-attachment-image')?.getAttribute('src')).toBe(
      'new.png',
    );
    expect(view.container.querySelector('.message-attachment-button')).not.toBeNull();
  });

  test('a healthy neighbour opens at its place in a lightbox that skips the failed image', async () => {
    const { container } = render(MessageAttachments, {
      props: {
        images: [
          { type: 'image', source: { kind: 'remote-url', url: 'a.png' }, alt: 'Image A' },
          { type: 'image', source: { kind: 'remote-url', url: 'b.png' }, alt: 'Image B' },
          { type: 'image', source: { kind: 'remote-url', url: 'c.png' }, alt: 'Image C' },
        ],
      },
    });
    const first = container.querySelector('.message-attachment-image');
    if (first === null) throw new Error('The thumbnails did not render.');
    await fireEvent.error(first);
    await waitFor(() => expect(container.querySelectorAll('[data-unavailable]')).toHaveLength(1));

    const buttons = container.querySelectorAll<HTMLButtonElement>('.message-attachment-button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute('aria-label')).toBe('View image: Image B');
    await fireEvent.click(buttons[1]!);

    await waitFor(() =>
      expect(container.querySelector('.lightbox-image')?.getAttribute('alt')).toBe('Image C'),
    );
    expect(container.querySelector('.lightbox-counter')?.textContent?.trim()).toBe('2 of 2');
    await fireEvent.click(container.querySelector('[aria-label="Next image"]')!);
    // Navigation wraps through the healthy images only, never reaching the failed one.
    expect(container.querySelector('.lightbox-image')?.getAttribute('alt')).not.toBe('Image A');
  });

  test('disables affordance transitions for reduced motion', () => {
    expect(source).toContain('@media (prefers-reduced-motion: reduce)');
    expect(source).toContain('.message-attachment-maximize');
    expect(source).toContain('transition: none');
  });
});
