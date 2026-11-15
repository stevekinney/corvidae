/// <reference lib="dom" />
/**
 * An attached file is a chip: the glyph of its kind of file, its name with the extension kept
 * whole, and a ring in the glyph's place while it uploads. A failed chip says nothing itself: its
 * glyph and outline are all, and the line under the strip is the one place the words go.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { default: ChatAttachmentPreview } = await import('./chat-attachment-preview.svelte');

const fileName = 'quarterly-financial-statement-final-revision.pdf';

afterEach(() => {
  document.body.replaceChildren();
});

function mountPreview(
  attachment: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
  name = fileName,
  type = 'application/pdf',
) {
  const target = document.createElement('div');
  document.body.append(target);
  const instance = mount(ChatAttachmentPreview, {
    target,
    props: {
      attachment: {
        id: 'a',
        file: new File([new Uint8Array(10)], name, { type }),
        previewUrl: '',
        kind: 'document',
        status: 'ready',
        ...attachment,
      } as never,
      ...extra,
    },
  });
  return { target, instance };
}

const glyphClass = (target: HTMLElement) =>
  target.querySelector('.chat-attachment-preview-glyph svg')?.getAttribute('class') ?? '';

describe('chat attachment chip', () => {
  test('is a glyph, the whole name in two spans and nothing else', async () => {
    const { target, instance } = mountPreview();
    await tick();
    const chip = target.querySelector('.chat-attachment-preview')!;
    expect(chip.querySelector('.chat-attachment-preview-stem')?.textContent).toBe(
      'quarterly-financial-statement-final-revision',
    );
    expect(chip.querySelector('.chat-attachment-preview-extension')?.textContent).toBe('.pdf');
    expect(chip.querySelector('.chat-attachment-preview-name')?.textContent).toBe(fileName);
    // No type badge, no size and no sentence: the chip is the glyph and the name.
    expect(chip.querySelector('.chat-attachment-preview-badge')).toBeNull();
    expect(chip.querySelector('.chat-attachment-preview-size')).toBeNull();
    expect(chip.textContent).not.toContain('PDF');
    expect(chip.textContent).not.toContain('…');
    expect(chip.getAttribute('title')).toBe(fileName);
    unmount(instance);
  });

  test('wears the glyph of its kind of file', async () => {
    const cases: [string, string, string, string][] = [
      ['brief.pdf', 'application/pdf', 'document', 'lucide-file-text'],
      ['photo.png', 'image/png', 'image', 'lucide-file-image'],
      ['numbers.xlsx', '', 'document', 'lucide-file-spreadsheet'],
      ['bundle.zip', 'application/zip', 'document', 'lucide-file-archive'],
      ['song.mp3', 'audio/mpeg', 'document', 'lucide-file-headphone'],
      ['clip.mov', 'video/quicktime', 'document', 'lucide-file-video-camera'],
      ['index.ts', 'text/typescript', 'code', 'lucide-file-code'],
      ['thing.bin', 'application/octet-stream', 'document', 'lucide-file'],
    ];
    for (const [name, type, kind, glyph] of cases) {
      const { target, instance } = mountPreview({ kind }, {}, name, type);
      await tick();
      expect(glyphClass(target), name).toContain(glyph);
      unmount(instance);
    }
  });

  test('shows a determinate ring in the glyph’s place while it uploads', async () => {
    const { target, instance } = mountPreview({ status: 'uploading', progress: 0.42 });
    await tick();
    const ring = target.querySelector('.chat-attachment-preview-glyph [role="progressbar"]')!;
    expect(ring.getAttribute('aria-valuenow')).toBe('42');
    expect(ring.getAttribute('data-cinder-size')).toBe('xs');
    expect(ring.getAttribute('aria-label')).toBe('Uploading file');
    expect(target.querySelector('.chat-attachment-preview-glyph svg.lucide')).toBeNull();
    unmount(instance);
  });

  test('shows an indeterminate ring when its progress is unknown', async () => {
    const { target, instance } = mountPreview({ status: 'uploading' });
    await tick();
    const ring = target.querySelector('.chat-attachment-preview-glyph [role="progressbar"]')!;
    expect(ring.hasAttribute('aria-valuenow')).toBe(false);
    expect(ring.hasAttribute('data-cinder-indeterminate')).toBe(true);
    unmount(instance);
  });

  test('a failed upload that can be retried wears the retry glyph, and the main area retries', async () => {
    let activated = 0;
    const { target, instance } = mountPreview(
      { status: 'error', retryable: true, failureKind: 'network', error: 'Upload failed.' },
      { onactivate: () => (activated += 1), activateLabel: 'Retry the report' },
    );
    await tick();
    const chip = target.querySelector('.chat-attachment-preview')!;
    expect(chip.hasAttribute('data-error')).toBe(true);
    expect(chip.getAttribute('data-failure-kind')).toBe('network');
    expect(glyphClass(target)).toContain('lucide-rotate-ccw');
    const main = chip.querySelector<HTMLButtonElement>('button.chat-attachment-preview-main')!;
    expect(main.getAttribute('aria-label')).toBe('Retry the report');
    main.click();
    expect(activated).toBe(1);
    // The reason is a tooltip, never a sentence in the chip.
    expect(chip.getAttribute('title')).toBe(`${fileName}. Upload failed.`);
    expect(chip.textContent?.trim()).toBe(fileName);
    unmount(instance);
  });

  test('a file that cannot be retried wears a warning glyph and has no activating main area', async () => {
    const { target, instance } = mountPreview({ status: 'error', failureKind: 'too-large' });
    await tick();
    expect(glyphClass(target)).toContain('lucide-triangle-alert');
    expect(target.querySelector('button.chat-attachment-preview-main')).toBeNull();
    unmount(instance);
  });

  test('is one height and one line, with the stem shortening at its end and the extension whole', async () => {
    const preview = await Bun.file(
      new URL('./chat-attachment-preview.svelte', import.meta.url),
    ).text();
    expect(preview).toMatch(
      /\.chat-attachment-preview\s*\{[^}]*block-size: var\(--_cinder-painted-height-sm, 1\.75rem\);/s,
    );
    const name = preview.match(/\.chat-attachment-preview-name\s*\{[^}]*\}/)?.[0];
    expect(name).toMatch(/white-space: nowrap;/);
    const stem = preview.match(/\.chat-attachment-preview-stem\s*\{[^}]*\}/)?.[0];
    expect(stem).toMatch(/overflow: hidden;/);
    expect(stem).toMatch(/text-overflow: ellipsis;/);
    const extension = preview.match(/\.chat-attachment-preview-extension\s*\{[^}]*\}/)?.[0];
    expect(extension).toMatch(/flex: none;/);
    // The glyph is 1rem, never taller than the name's line.
    expect(preview).toMatch(
      /\.chat-attachment-preview-glyph\s*\{[^}]*inline-size: 1rem;[^}]*block-size: 1rem;/s,
    );
    // The name is not measured or rewritten by script.
    expect(preview).not.toContain('ResizeObserver');
    expect(preview).not.toContain('measureText');
  });
});
