/**
 * COR-1548 — Chat forwards the upload hook, the limits and the error words to its composer, and
 * `capabilities.attachments` turns the attach button off.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import type { ChatAttachmentFailure } from './input/chat-attachment.ts';

setupHappyDom();

class TestObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
const originalResizeObserver = globalThis.ResizeObserver;
const originalIntersectionObserver = globalThis.IntersectionObserver;
globalThis.ResizeObserver = TestObserver;
globalThis.IntersectionObserver = TestObserver as unknown as typeof IntersectionObserver;
afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

const { cleanup } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function mountChat(props: Record<string, unknown>) {
  const now = new Date().toISOString();
  const target = document.createElement('div');
  document.body.append(target);
  const instance = mount(Chat, {
    target,
    props: {
      id: 'chat-upload',
      conversation: {
        schemaVersion: 4,
        id: 'upload-test',
        status: 'active',
        metadata: {},
        ids: [],
        messages: {},
        createdAt: now,
        updatedAt: now,
      },
      ...props,
    },
  }) as Record<string, unknown> & { addFiles?: unknown };
  return { target, instance };
}

describe('Chat attachments', () => {
  test('hands the upload hook, the limit, the accepted types and the words to the composer', async () => {
    const uploaded: string[] = [];
    const failures: ChatAttachmentFailure[] = [];
    const { target, instance } = mountChat({
      uploadAttachment: async (file: File) => {
        uploaded.push(file.name);
        return { id: 'asset-1' };
      },
      maxFileSize: 8,
      acceptedTypes: ['image/*'],
      formatAttachmentError: (failure: ChatAttachmentFailure) => {
        failures.push(failure);
        return 'Refused.';
      },
    });
    await tick();

    const picker = target.querySelector<HTMLInputElement>('input[type="file"]');
    expect(picker?.getAttribute('accept')).toBe('image/*');
    const files = [
      new File(['ok'], 'ok.png', { type: 'image/png' }),
      new File(['a long body of bytes'], 'big.png', { type: 'image/png' }),
      new File(['text'], 'note.txt', { type: 'text/plain' }),
    ];
    Object.defineProperty(picker, 'files', { value: files, configurable: true });
    picker?.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    await tick();

    expect(uploaded).toEqual(['ok.png']);
    expect(failures.map((failure) => failure.kind)).toEqual(['too-large', 'type-not-accepted']);
    expect(
      [...target.querySelectorAll('.chat-attachment-preview')].map((node) =>
        node.getAttribute('data-state'),
      ),
    ).toEqual(['ready', 'error', 'error']);
    unmount(instance);
  });

  test('has no attach button when capabilities.attachments is off', async () => {
    const { target, instance } = mountChat({ capabilities: { attachments: false } });
    await tick();

    expect(target.querySelector('input[type="file"]')).toBeNull();
    expect(target.querySelector('[aria-label="Attach file"]')).toBeNull();
    unmount(instance);
  });
});
