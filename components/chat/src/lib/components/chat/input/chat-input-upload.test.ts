/// <reference lib="dom" />
/**
 * COR-1548 — the composer uploads an attachment through the host's `uploadAttachment` hook the
 * moment it is added. Each attachment moves through `uploading`, then `ready` (carrying the hook's
 * reference) or `error`, and says so in `data-state`; Send waits for every upload; and a file the
 * composer refuses (too large, or a type it does not accept) is shown as an `error` row and never
 * reaches the hook.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import type { MessageInput } from '../conversation-model.ts';
import type {
  ChatAttachment,
  ChatAttachmentFailure,
  ChatAttachmentReference,
} from './chat-attachment.ts';

setupHappyDom();

const { ChatAttachmentUploadError } = await import('./chat-attachment.ts');

const { fireEvent, cleanup } = await import('@testing-library/svelte');
const { waitUntil } = await import('@lostgradient/testing/wait-until');
const { default: ChatInput } = await import('./chat-input.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

type Upload = (file: File, context: { signal: AbortSignal }) => Promise<ChatAttachmentReference>;

/** An upload the test settles by hand. */
function heldUpload() {
  const calls: Array<{
    file: File;
    signal: AbortSignal;
    resolve: (reference: ChatAttachmentReference) => void;
    reject: (error: unknown) => void;
  }> = [];
  const upload: Upload = (file, { signal }) =>
    new Promise((resolve, reject) => {
      calls.push({ file, signal, resolve, reject });
    });
  return { upload, calls };
}

function mountInput(props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.append(target);
  const instance = mount(ChatInput, { target, props: { id: 'upload-composer', ...props } });
  return { target, instance };
}

const png = (name = 'photo.png') => new File(['png-bytes'], name, { type: 'image/png' });
const stateOf = (target: HTMLElement) =>
  [...target.querySelectorAll('.chat-attachment-preview')].map((node) =>
    node.getAttribute('data-state'),
  );

describe('an attachment with an upload hook', () => {
  test('shows uploading until the hook settles, then ready, and carries the reference', async () => {
    const { upload, calls } = heldUpload();
    const submissions: Array<{ message: MessageInput; attachments: ChatAttachment[] }> = [];
    const { target, instance } = mountInput({
      uploadAttachment: upload,
      onsubmit: (message: MessageInput, attachments: ChatAttachment[]) =>
        submissions.push({ message, attachments }),
    });

    instance.addFiles([png()]);
    await tick();

    expect(calls).toHaveLength(1);
    expect(stateOf(target)).toEqual(['uploading']);
    const send = target.querySelector<HTMLButtonElement>('.chat-input-send');
    expect(send?.disabled).toBe(true);

    calls[0]!.resolve({ id: 'asset-1', mimeType: 'image/png' });
    await tick();
    await tick();

    expect(stateOf(target)).toEqual(['ready']);
    expect(send?.disabled).toBe(false);
    await fireEvent.submit(target.querySelector('form')!);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.attachments[0]?.reference).toEqual({
      id: 'asset-1',
      mimeType: 'image/png',
    });
    unmount(instance);
  });

  test('keeps Send disabled while any one of several uploads is still going', async () => {
    const { upload, calls } = heldUpload();
    const { target, instance } = mountInput({ uploadAttachment: upload });

    instance.addFiles([png('one.png'), png('two.png')]);
    await tick();
    calls[0]!.resolve({ id: 'asset-1' });
    await tick();
    await tick();

    expect(stateOf(target)).toEqual(['ready', 'uploading']);
    expect(target.querySelector<HTMLButtonElement>('.chat-input-send')?.disabled).toBe(true);
    unmount(instance);
  });

  test('shows error with the formatted message when the hook rejects', async () => {
    const { upload, calls } = heldUpload();
    const failures: ChatAttachmentFailure[] = [];
    const { target, instance } = mountInput({
      uploadAttachment: upload,
      formatAttachmentError: (failure: ChatAttachmentFailure) => {
        failures.push(failure);
        return 'Could not upload that.';
      },
    });
    instance.addFiles([png()]);
    await tick();

    calls[0]!.reject(new Error('boom'));
    await tick();
    await tick();

    expect(stateOf(target)).toEqual(['error']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'upload-failed' });
    // The host's words are the chip's tooltip; the one line under the strip is the only text.
    expect(target.querySelector('.chat-attachment-preview')?.getAttribute('title')).toBe(
      'photo.png. Could not upload that.',
    );
    expect(target.querySelector('.chat-input-attachment-reason-text')?.textContent).toBe(
      "photo.png didn't upload.",
    );
    unmount(instance);
  });

  test('Retry, on the line under the strip, uploads a failed file again, and the message sends once it is ready', async () => {
    const { upload, calls } = heldUpload();
    const { target, instance } = mountInput({ uploadAttachment: upload });
    instance.addFiles([png()]);
    await tick();
    calls[0]!.reject(new Error('boom'));
    await tick();
    await tick();

    expect(stateOf(target)).toEqual(['error']);
    const send = target.querySelector<HTMLButtonElement>('.chat-input-send')!;
    expect(send.disabled).toBe(true);
    const preview = target.querySelector<HTMLElement>('.chat-attachment-preview')!;
    // The chip is a glyph, a name and Remove: no Retry button of its own, no sentence.
    expect(preview.querySelector('.chat-attachment-preview-name')).not.toBeNull();
    expect(preview.querySelector('.chat-input-attachment-remove')).not.toBeNull();
    expect(preview.querySelectorAll('.chat-input-attachment-remove')).toHaveLength(1);
    expect(preview.querySelector('.chat-attachment-preview-error')).toBeNull();
    const line = target.querySelector<HTMLElement>('.chat-input-attachment-reason')!;
    expect(line.querySelector('.chat-input-attachment-reason-text')?.textContent).toBe(
      "photo.png didn't upload.",
    );
    // One file: the action is a glyph named for the file, with no words of its own.
    const retry = line.querySelector<HTMLButtonElement>('button')!;
    expect(retry.getAttribute('aria-label')).toBe('Retry photo.png');
    expect(retry.textContent?.trim()).toBe('');
    expect(retry.querySelector('svg')?.getAttribute('class')).toContain('lucide-rotate-ccw');
    // Send is described by the line, not by a second sentence.
    expect(send.getAttribute('aria-describedby')).toContain(line.id);

    await fireEvent.click(retry);
    await tick();

    expect(calls).toHaveLength(2);
    expect(stateOf(target)).toEqual(['uploading']);
    expect(target.querySelector('.chat-input-attachment-reason')).toBeNull();
    // The line's Retry is gone with the failure: focus moves to the chip's own Remove.
    expect(document.activeElement).toBe(
      target.querySelector('[aria-label="Remove photo.png"]') as HTMLElement,
    );
    calls[1]!.resolve({ id: 'asset-2' });
    await tick();
    await tick();

    expect(stateOf(target)).toEqual(['ready']);
    expect(send.disabled).toBe(false);
    unmount(instance);
  });

  test('activating a failed chip’s main area retries it', async () => {
    const { upload, calls } = heldUpload();
    const { target, instance } = mountInput({ uploadAttachment: upload });
    instance.addFiles([png()]);
    await tick();
    calls[0]!.reject(new Error('boom'));
    await tick();
    await tick();

    const main = target.querySelector<HTMLButtonElement>('button.chat-attachment-preview-main')!;
    expect(main.getAttribute('aria-label')).toBe('Retry photo.png');
    await fireEvent.click(main);
    await tick();

    expect(calls).toHaveLength(2);
    expect(stateOf(target)).toEqual(['uploading']);
    unmount(instance);
  });

  test('shows the percentage the hook reports as a ring, and a ring that turns until it reports', async () => {
    let report: (fraction: number) => void = () => undefined;
    const upload = (
      _file: File,
      context: {
        signal: AbortSignal;
        onProgress?: ((fraction: number) => void) | undefined;
      },
    ): Promise<ChatAttachmentReference> => {
      report = context.onProgress ?? report;
      return new Promise<ChatAttachmentReference>(() => undefined);
    };
    const { target, instance } = mountInput({ uploadAttachment: upload });
    instance.addFiles([png()]);
    await tick();

    const ring = () => target.querySelector('.chat-attachment-preview [role="progressbar"]')!;
    expect(ring().hasAttribute('aria-valuenow')).toBe(false);
    expect(ring().hasAttribute('data-cinder-indeterminate')).toBe(true);

    report(0.42);
    await tick();

    expect(ring().getAttribute('aria-valuenow')).toBe('42');
    expect(ring().hasAttribute('data-cinder-indeterminate')).toBe(false);
    // The ring takes the glyph's place and no figure is written beside the name.
    expect(target.querySelector('.chat-attachment-preview-state')).toBeNull();
    unmount(instance);
  });

  test('aborts the upload when the attachment is removed, and shows nothing for the abort', async () => {
    const { upload, calls } = heldUpload();
    const { target, instance } = mountInput({ uploadAttachment: upload });
    instance.addFiles([png()]);
    await tick();

    await fireEvent.click(target.querySelector('.chat-input-attachment-remove')!);
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.reject(new DOMException('aborted', 'AbortError'));
    await tick();

    expect(stateOf(target)).toEqual([]);
    unmount(instance);
  });

  test('aborts every upload still going when the composer is destroyed', async () => {
    const { upload, calls } = heldUpload();
    const { instance } = mountInput({ uploadAttachment: upload });
    instance.addFiles([png()]);
    await tick();

    unmount(instance);

    expect(calls[0]!.signal.aborted).toBe(true);
  });

  test('does not upload a pasted text promotion, which is sent inline', async () => {
    const { upload, calls } = heldUpload();
    const { target, instance } = mountInput({
      uploadAttachment: upload,
      largePasteThreshold: 10,
      acceptedTypes: ['image/*', 'text/*'],
    });
    const editor = target.querySelector<HTMLTextAreaElement>('textarea')!;
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], getData: () => 'a long pasted block of text' },
    });
    editor.dispatchEvent(paste);
    await tick();

    expect(calls).toHaveLength(0);
    expect(stateOf(target)).toEqual(['ready']);
    unmount(instance);
  });

  test('keeps the previous behaviour without a hook: a file is ready at once', async () => {
    const { target, instance } = mountInput({});
    instance.addFiles([png()]);
    await tick();

    expect(stateOf(target)).toEqual(['ready']);
    unmount(instance);
  });
});

describe('a file the composer refuses', () => {
  test('over the limit shows an error row, tells the failure hook, and is never uploaded', async () => {
    const { upload, calls } = heldUpload();
    const failed: Array<{ file: File; error: string }> = [];
    const formatted: ChatAttachmentFailure[] = [];
    const { target, instance } = mountInput({
      uploadAttachment: upload,
      maxFileSize: 4,
      formatAttachmentError: (failure: ChatAttachmentFailure) => {
        formatted.push(failure);
        return 'Over the limit.';
      },
      onAttachmentFailure: (file: File, error: string) => failed.push({ file, error }),
    });

    instance.addFiles([png()]);
    await tick();

    expect(calls).toHaveLength(0);
    expect(stateOf(target)).toEqual(['error']);
    expect(formatted[0]).toMatchObject({ kind: 'too-large', maxFileSize: 4 });
    expect(failed[0]?.error).toBe('Over the limit.');
    expect(target.querySelector('.chat-attachment-preview')?.getAttribute('title')).toBe(
      'photo.png. Over the limit.',
    );
    expect(target.querySelector('.chat-input-attachment-reason-text')?.textContent).toBe(
      'photo.png is over the 4 B limit.',
    );
    // A file the composer refused is removed, never retried.
    const action = target.querySelector('.chat-input-attachment-reason button');
    expect(action?.getAttribute('aria-label')).toBe('Remove photo.png');
    expect(action?.textContent?.trim()).toBe('');
    unmount(instance);
  });

  test('of a type it does not accept shows an error row and is never uploaded', async () => {
    const { upload, calls } = heldUpload();
    const formatted: ChatAttachmentFailure[] = [];
    const { target, instance } = mountInput({
      uploadAttachment: upload,
      acceptedTypes: ['application/pdf'],
      formatAttachmentError: (failure: ChatAttachmentFailure) => {
        formatted.push(failure);
        return 'Not that type.';
      },
    });

    instance.addFiles([png()]);
    await tick();

    expect(calls).toHaveLength(0);
    expect(stateOf(target)).toEqual(['error']);
    expect(formatted[0]).toMatchObject({
      kind: 'type-not-accepted',
      acceptedTypes: ['application/pdf'],
    });
    expect(target.querySelector('.chat-input-attachment-reason-text')?.textContent).toBe(
      "photo.png can't be attached. Attach a PDF.",
    );
    const action = target.querySelector('.chat-input-attachment-reason button');
    expect(action?.getAttribute('aria-label')).toBe('Remove photo.png');
    expect(action?.textContent?.trim()).toBe('');
    unmount(instance);
  });

  // COR-2277: a refused file blocks Send until it is removed, as any failed file does.
  test('says why in the default words when no formatter is given, and blocks Send until it is removed', async () => {
    const { target, instance } = mountInput({ maxFileSize: 4, value: 'hello' });

    instance.addFiles([png()]);
    await tick();

    expect(stateOf(target)).toEqual(['error']);
    expect(target.querySelector('.chat-attachment-preview')?.getAttribute('title')).toContain(
      'exceeds',
    );
    expect(target.querySelector<HTMLButtonElement>('.chat-input-send')?.disabled).toBe(true);

    await fireEvent.click(
      target.querySelector<HTMLButtonElement>('[aria-label="Remove photo.png"]')!,
    );
    await tick();
    expect(target.querySelector<HTMLButtonElement>('.chat-input-send')?.disabled).toBe(false);
    unmount(instance);
  });
});

describe('the failure line under the strip', () => {
  const lineText = (target: HTMLElement) =>
    target.querySelector('.chat-input-attachment-reason-text')?.textContent;
  const lineAction = (target: HTMLElement) =>
    target.querySelector<HTMLButtonElement>('.chat-input-attachment-reason button');
  // One file's action is a glyph with no words, named for the file; several files keep words.
  const expectGlyphAction = (target: HTMLElement, name: string) => {
    const action = lineAction(target);
    expect(action?.getAttribute('aria-label')).toBe(name);
    expect(action?.textContent?.trim()).toBe('');
    expect(action?.querySelector('svg')).not.toBeNull();
  };

  async function settleFailures(
    errors: unknown[],
    files = errors.map((_, index) => png(`file-${index + 1}.png`)),
    props: Record<string, unknown> = {},
  ) {
    const { upload, calls } = heldUpload();
    const { target, instance } = mountInput({ uploadAttachment: upload, ...props });
    instance.addFiles(files);
    await tick();
    errors.forEach((error, index) => calls[index]!.reject(error));
    await tick();
    await tick();
    return { target, instance, calls };
  }

  test('a rejection that is not a failure of the network or a named kind is unknown, with Retry', async () => {
    const { target, instance } = await settleFailures([new Error('boom')]);
    expect(
      target.querySelector('.chat-attachment-preview')?.getAttribute('data-failure-kind'),
    ).toBe('unknown');
    expect(lineText(target)).toBe("file-1.png didn't upload.");
    expectGlyphAction(target, 'Retry file-1.png');
    unmount(instance);
  });

  test('a TypeError, which is what fetch rejects with, says to check the connection and offers Retry', async () => {
    const { target, instance } = await settleFailures([new TypeError('Failed to fetch')]);
    expect(lineText(target)).toBe("file-1.png didn't upload. Check your connection.");
    expectGlyphAction(target, 'Retry file-1.png');
    // A retry glyph stands where the file's glyph was.
    expect(
      target.querySelector('.chat-attachment-preview-glyph svg')?.getAttribute('class'),
    ).toContain('lucide-rotate-ccw');
    unmount(instance);
  });

  test('a host that says the file is too large carries its limit, and the file is removed, not retried', async () => {
    const { target, instance } = await settleFailures([
      new ChatAttachmentUploadError('too-large', { maxFileSize: 25 * 1024 * 1024 }),
    ]);
    expect(lineText(target)).toBe('file-1.png is over the 25 MB limit.');
    expectGlyphAction(target, 'Remove file-1.png');
    expect(
      target.querySelector('.chat-attachment-preview-glyph svg')?.getAttribute('class'),
    ).toContain('lucide-triangle-alert');
    expect(target.querySelector('button.chat-attachment-preview-main')).toBeNull();
    await fireEvent.click(lineAction(target)!);
    await tick();
    expect(stateOf(target)).toEqual([]);
    expect(target.querySelector('.chat-input-attachment-reason')).toBeNull();
    // With nothing left to remove, focus lands in the text field.
    expect(document.activeElement).toBe(target.querySelector('textarea'));
    unmount(instance);
  });

  test('a host that says the type is unsupported offers Remove only', async () => {
    const { target, instance } = await settleFailures([
      new ChatAttachmentUploadError('unsupported-type'),
    ]);
    // The next step the old line had: what the composer takes, here its default list, kept short.
    expect(lineText(target)).toBe(
      "file-1.png can't be attached. Attach an image, a text file, a JSON file or another kind of file.",
    );
    expectGlyphAction(target, 'Remove file-1.png');
    unmount(instance);
  });

  test('a host’s own accept list is what an unsupported file is told to attach instead', async () => {
    const { target, instance } = await settleFailures(
      [new ChatAttachmentUploadError('unsupported-type')],
      undefined,
      { acceptedTypes: ['image/*', 'application/pdf'] },
    );
    expect(lineText(target)).toBe("file-1.png can't be attached. Attach an image or a PDF.");
    unmount(instance);
  });

  const lineActions = (target: HTMLElement) =>
    [...target.querySelectorAll<HTMLButtonElement>('.chat-input-attachment-reason button')].map(
      (button) => ({
        text: button.textContent?.trim(),
        name: button.getAttribute('aria-label') ?? button.textContent?.trim(),
      }),
    );

  test('several files with one shared reason say it once, and offer Retry all when every one can be retried', async () => {
    const { target, instance, calls } = await settleFailures([
      new TypeError('offline'),
      new TypeError('offline'),
    ]);
    expect(lineText(target)).toBe("2 files didn't upload. Check your connection.");
    expect(lineActions(target)).toEqual([{ text: 'Retry all', name: 'Retry all' }]);
    await fireEvent.click(lineAction(target)!);
    await tick();
    expect(calls).toHaveLength(4);
    expect(stateOf(target)).toEqual(['uploading', 'uploading']);
    unmount(instance);
  });

  test('every worded action of the notice is the compact secondary Button, never a bare accent link', async () => {
    for (const errors of [
      [new TypeError('offline'), new TypeError('offline')],
      [new TypeError('offline'), new ChatAttachmentUploadError('unsupported-type')],
      [
        new ChatAttachmentUploadError('unsupported-type'),
        new ChatAttachmentUploadError('too-large'),
      ],
    ]) {
      const { target, instance } = await settleFailures(errors);
      const buttons = [
        ...target.querySelectorAll<HTMLButtonElement>('.chat-input-attachment-reason button'),
      ];
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.getAttribute('data-cinder-variant')).toBe('secondary');
        expect(button.getAttribute('data-cinder-size')).toBe('sm');
      }
      unmount(instance);
    }
  });

  test('files that failed for different reasons read as one sentence for each reason', async () => {
    const { target, instance } = await settleFailures([
      new TypeError('offline'),
      new ChatAttachmentUploadError('too-large', { maxFileSize: 1024 }),
      new TypeError('offline'),
    ]);
    expect(lineText(target)).toBe(
      "2 files didn't upload. Check your connection. 1 file is over the 1 KB limit.",
    );
    unmount(instance);
  });

  test('when only some files can be retried the action says how many, and Remove failed takes the rest', async () => {
    const { target, instance, calls } = await settleFailures([
      new TypeError('offline'),
      new ChatAttachmentUploadError('too-large', { maxFileSize: 1024 }),
      new ChatAttachmentUploadError('unsupported-type'),
    ]);
    // Remove first and the recovery last: the trailing-most control is the primary one.
    expect(lineActions(target)).toEqual([
      { text: 'Remove failed', name: 'Remove failed: 2 files that can’t be retried' },
      { text: 'Retry 1', name: 'Retry 1 failed file' },
    ]);
    const buttons = [
      ...target.querySelectorAll<HTMLButtonElement>('.chat-input-attachment-reason button'),
    ];
    await fireEvent.click(buttons[0]!);
    await tick();
    // The two that cannot work are gone; the one that can is still failed.
    expect(stateOf(target)).toEqual(['error']);
    expect(lineText(target)).toBe("file-1.png didn't upload. Check your connection.");
    expect(calls).toHaveLength(3);
    unmount(instance);
  });

  test('Retry N tries again only the files that can be retried and leaves the rest failed', async () => {
    const { target, instance, calls } = await settleFailures([
      new TypeError('offline'),
      new ChatAttachmentUploadError('too-large', { maxFileSize: 1024 }),
    ]);
    const retry = lineActions(target).findIndex((action) => action.text === 'Retry 1');
    const buttons = [
      ...target.querySelectorAll<HTMLButtonElement>('.chat-input-attachment-reason button'),
    ];
    await fireEvent.click(buttons[retry]!);
    await tick();
    expect(calls).toHaveLength(3);
    expect(stateOf(target)).toEqual(['uploading', 'error']);
    unmount(instance);
  });

  test('several failures are counted, retried together, and each file keeps its reason', async () => {
    const { target, instance, calls } = await settleFailures([
      new TypeError('offline'),
      new ChatAttachmentUploadError('too-large', { maxFileSize: 1024 }),
      new Error('boom'),
    ]);
    const several =
      "1 file didn't upload. Check your connection. 1 file is over the 1 KB limit. 1 file didn't upload.";
    expect(lineText(target)).toBe(several);
    expect(lineActions(target).map((action) => action.text)).toEqual(['Remove failed', 'Retry 2']);
    // Activating a failed chip makes the line speak of that file alone, and again goes back.
    const chips = [...target.querySelectorAll<HTMLElement>('.chat-attachment-preview')];
    const second = chips[1]!.querySelector<HTMLButtonElement>(
      'button.chat-attachment-preview-main',
    )!;
    expect(second.getAttribute('aria-label')).toBe('Why file-2.png failed');
    await fireEvent.click(second);
    await tick();
    expect(lineText(target)).toBe('file-2.png is over the 1 KB limit.');
    expectGlyphAction(target, 'Remove file-2.png');
    await fireEvent.click(second);
    await tick();
    expect(lineText(target)).toBe(several);

    const retryTwo = [
      ...target.querySelectorAll<HTMLButtonElement>('.chat-input-attachment-reason button'),
    ].find((button) => button.textContent?.trim() === 'Retry 2')!;
    await fireEvent.click(retryTwo);
    await tick();
    // Only the two that can be tried again are; the one over the limit stays failed.
    expect(calls).toHaveLength(5);
    expect(stateOf(target)).toEqual(['uploading', 'error', 'uploading']);
    expect(lineText(target)).toBe('file-2.png is over the 1 KB limit.');
    unmount(instance);
  });

  test('several failures that cannot be retried offer to remove them all', async () => {
    const { target, instance } = await settleFailures([
      new ChatAttachmentUploadError('unsupported-type'),
      new ChatAttachmentUploadError('too-large'),
    ]);
    // Several files: one short sentence for each reason; only a single file is told what to attach.
    expect(lineText(target)).toBe("1 file is over the limit. 1 file can't be attached.");
    expect(lineActions(target)).toEqual([{ text: 'Remove all failed', name: 'Remove all failed' }]);
    await fireEvent.click(lineAction(target)!);
    await tick();
    expect(stateOf(target)).toEqual([]);
    unmount(instance);
  });

  test('is told once, through the composer’s live region, and the chip says nothing', async () => {
    const { target, instance } = await settleFailures([new TypeError('offline')]);
    const told = () =>
      [...document.querySelectorAll('[aria-live]')]
        .map((node) => node.textContent)
        .join(' ')
        .match(/file-1\.png didn't upload\. Check your connection\./g);
    await waitUntil(() => told() !== null);
    expect(told()).toHaveLength(1);
    expect(target.querySelector('.chat-input-attachment-reason')?.hasAttribute('aria-live')).toBe(
      false,
    );
    unmount(instance);
  });

  test('removing a chip moves focus to the next chip’s Remove, else the previous, else the text field', async () => {
    const { upload } = heldUpload();
    const { target, instance } = mountInput({ uploadAttachment: upload });
    instance.addFiles([png('one.png'), png('two.png'), png('three.png')]);
    await tick();
    const remove = (name: string) =>
      target.querySelector<HTMLButtonElement>(`[aria-label="Remove ${name}"]`)!;
    remove('two.png').focus();
    await fireEvent.click(remove('two.png'));
    await tick();
    expect(document.activeElement).toBe(remove('three.png'));
    await fireEvent.click(remove('three.png'));
    await tick();
    expect(document.activeElement).toBe(remove('one.png'));
    await fireEvent.click(remove('one.png'));
    await tick();
    expect(document.activeElement).toBe(target.querySelector('textarea'));
    unmount(instance);
  });
});

describe('attachments already in the composer when its limits change', () => {
  async function mountFixture(props: Record<string, unknown>) {
    const { default: Fixture } = await import('./chat-input-upload-fixture.svelte');
    const target = document.createElement('div');
    document.body.append(target);
    const instance = mount(Fixture, {
      target,
      props: { acceptedTypes: ['image/*'], maxFileSize: 1024, ...props },
    }) as unknown as {
      setLimits(next: { acceptedTypes?: string[]; maxFileSize?: number }): void;
      addFiles(files: File[]): void;
    };
    return { target, instance };
  }

  test('a ready attachment the new limits refuse becomes an error row, is not sent, and tells the failure hook', async () => {
    const failed: Array<{ file: File; error: string }> = [];
    const submitted: ChatAttachment[][] = [];
    const { target, instance } = await mountFixture({
      uploadAttachment: async () => ({ id: 'asset-1' }),
      formatAttachmentError: (failure: ChatAttachmentFailure) => `refused ${failure.kind}`,
      onAttachmentFailure: (file: File, error: string) => failed.push({ file, error }),
      onsubmit: (_message: MessageInput, attachments: ChatAttachment[]) =>
        submitted.push(attachments),
      value: 'hello',
    });
    instance.addFiles([png()]);
    await tick();
    await tick();
    expect(stateOf(target)).toEqual(['ready']);

    instance.setLimits({ acceptedTypes: ['application/pdf'] });
    await tick();

    expect(stateOf(target)).toEqual(['error']);
    expect(target.querySelector('.chat-attachment-preview')?.getAttribute('title')).toContain(
      'refused type-not-accepted',
    );
    expect(failed.map((entry) => entry.error)).toEqual(['refused type-not-accepted']);
    // COR-2277: the refused file blocks Send until it is removed, and then the text sends alone.
    await fireEvent.submit(target.querySelector('form')!);
    expect(submitted).toEqual([]);
    await fireEvent.click(
      target.querySelector<HTMLButtonElement>('[aria-label="Remove photo.png"]')!,
    );
    await tick();
    await fireEvent.submit(target.querySelector('form')!);
    expect(submitted).toEqual([[]]);
  });

  test('an upload still going is aborted when the new limits refuse its file', async () => {
    const { upload, calls } = heldUpload();
    const { target, instance } = await mountFixture({ uploadAttachment: upload });
    instance.addFiles([png()]);
    await tick();

    instance.setLimits({ acceptedTypes: [] });
    await tick();

    expect(calls[0]!.signal.aborted).toBe(true);
    expect(stateOf(target)).toEqual(['error']);
    calls[0]!.resolve({ id: 'late' });
    await tick();
    expect(stateOf(target)).toEqual(['error']);
  });

  test('a file over a smaller size limit is refused, and one the limits still take is left alone', async () => {
    const { target, instance } = await mountFixture({
      uploadAttachment: async () => ({ id: 'asset-1' }),
      maxFileSize: 1024,
    });
    const small = new File(['xx'], 'small.png', { type: 'image/png' });
    const bigger = new File([new Uint8Array(512)], 'bigger.png', { type: 'image/png' });
    instance.addFiles([small, bigger]);
    await tick();
    await tick();

    instance.setLimits({ maxFileSize: 100 });
    await tick();

    expect(stateOf(target)).toEqual(['ready', 'error']);
  });

  test('an attachment that was already an error keeps its own words', async () => {
    const { target, instance } = await mountFixture({ acceptedTypes: ['image/*'] });
    instance.addFiles([new File(['x'], 'a.zip', { type: 'application/zip' })]);
    await tick();
    const before = target.textContent;

    instance.setLimits({ acceptedTypes: [] });
    await tick();

    expect(stateOf(target)).toEqual(['error']);
    expect(target.textContent).toBe(before);
  });
});
