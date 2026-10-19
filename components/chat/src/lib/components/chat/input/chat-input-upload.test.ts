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

const { fireEvent, cleanup } = await import('@testing-library/svelte');
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

  test('shows error with the formatted message when the hook rejects, and still lets text send', async () => {
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
    expect(target.textContent).toContain('Could not upload that.');
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
    expect(target.textContent).toContain('Over the limit.');
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
    unmount(instance);
  });

  test('says why in the default words when no formatter is given, and does not block Send', async () => {
    const { target, instance } = mountInput({ maxFileSize: 4, value: 'hello' });

    instance.addFiles([png()]);
    await tick();

    expect(stateOf(target)).toEqual(['error']);
    expect(target.textContent).toContain('exceeds');
    expect(target.querySelector<HTMLButtonElement>('.chat-input-send')?.disabled).toBe(false);
    unmount(instance);
  });
});
