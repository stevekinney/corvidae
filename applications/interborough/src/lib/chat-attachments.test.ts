/**
 * COR-1548 — what the selected agent's model lets a person attach, how a refusal or a fault is
 * worded, and the upload hook Chat's composer calls.
 */
import { ChatRunFailureError, type ChatAttachment } from '@lostgradient/chat';
import { rejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../app/copy.ts';
import { AttachmentUploadError } from './bureau-assets.ts';
import type { Fetcher } from './bureau-client.ts';
import {
  attachmentSettings,
  chatAttachmentErrorMessage,
  createAttachmentUpload,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  messageWithAttachments,
  runFailureMessage,
  type AgentMedia,
} from './chat-attachments.ts';

const MIB = 1024 * 1024;

function media(overrides: Partial<AgentMedia> = {}): AgentMedia {
  return {
    modalities: {
      text: { input: true, output: true },
      image: { input: true, output: false },
      document: { input: true, output: false },
      audio: { input: false, output: false },
      video: { input: false, output: false },
      file: { input: false, output: false },
    },
    mimeFamilies: ['text', 'image', 'document'],
    mediaLimits: [{ modality: 'image', maxBytes: 10 * MIB }],
    ...overrides,
  };
}

const file = (type: string, size = 4) => new File([new Uint8Array(size)], 'a', { type });

describe('attachmentSettings', () => {
  test('is null when the agent names no model, so nothing can be attached', () => {
    expect(attachmentSettings(null)).toBeNull();
    expect(attachmentSettings(undefined)).toBeNull();
  });

  test('maps each family the model takes to the types the file picker accepts', () => {
    expect(attachmentSettings(media())?.acceptedTypes).toEqual([
      'text/*',
      'image/*',
      'application/pdf',
    ]);
    expect(
      attachmentSettings(
        media({
          mimeFamilies: ['image', 'audio', 'video', 'document', 'text'],
          modalities: {
            text: { input: true, output: true },
            image: { input: true, output: false },
            audio: { input: true, output: false },
            video: { input: true, output: false },
            document: { input: true, output: false },
          },
        }),
      )?.acceptedTypes,
    ).toEqual(['image/*', 'audio/*', 'video/*', 'application/pdf', 'text/*']);
  });

  test('leaves out a family whose modality the model does not take as input, and one it has no type for', () => {
    const settings = attachmentSettings(
      media({ mimeFamilies: ['image', 'audio', 'font', 'model', 'application'] }),
    );

    expect(settings?.acceptedTypes).toEqual(['image/*']);
  });

  test('is null when no family is left to accept', () => {
    expect(attachmentSettings(media({ mimeFamilies: ['font'] }))).toBeNull();
  });

  test('limits a file by the per-part limit of its modality, and by the Bureau’s ceiling when none is stated', () => {
    const settings = attachmentSettings(media())!;

    expect(settings.limitFor(file('image/png'))).toBe(10 * MIB);
    expect(settings.limitFor(file('application/pdf'))).toBe(DEFAULT_MAX_ATTACHMENT_BYTES);
    expect(settings.limitFor(file('text/plain'))).toBe(DEFAULT_MAX_ATTACHMENT_BYTES);
    expect(settings.limitFor(file('application/octet-stream'))).toBe(DEFAULT_MAX_ATTACHMENT_BYTES);
  });

  test('asks Chat for the largest limit of any type it accepts, so the hook can apply each type’s own', () => {
    expect(attachmentSettings(media())?.maxFileSize).toBe(DEFAULT_MAX_ATTACHMENT_BYTES);
    expect(
      attachmentSettings(
        media({ mimeFamilies: ['image'], mediaLimits: [{ modality: 'image', maxBytes: 3 * MIB }] }),
      )?.maxFileSize,
    ).toBe(3 * MIB);
  });
});

describe('a text file, which is sent as a document part (A1)', () => {
  const noTextButDocument = () =>
    media({
      modalities: {
        text: { input: false, output: false },
        image: { input: false, output: false },
        document: { input: true, output: false },
      },
      mimeFamilies: ['text', 'document'],
      mediaLimits: [{ modality: 'document', maxBytes: MIB }],
    });

  test('is accepted by a model that takes documents and has no text input, and checked against the document limit', () => {
    const settings = attachmentSettings(noTextButDocument())!;

    expect(settings.acceptedTypes).toEqual(['text/*', 'application/pdf']);
    expect(settings.limitFor(file('text/plain'))).toBe(MIB);
    expect(settings.limitFor(file('application/pdf'))).toBe(MIB);
    expect(settings.maxFileSize).toBe(MIB);
  });

  test('is not accepted by a model that takes text input but no documents, because it is sent as a document', () => {
    const settings = attachmentSettings(
      media({
        modalities: {
          text: { input: true, output: true },
          image: { input: true, output: false },
          document: { input: false, output: false },
        },
      }),
    )!;

    expect(settings.acceptedTypes).toEqual(['image/*']);
  });

  test('is refused by the upload hook over the document limit, before the Bureau hears of it', async () => {
    const calls: string[] = [];
    const send: Fetcher = async (_input, init) => {
      calls.push(typeof init?.body === 'string' ? init.body : '');
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
    };
    const upload = createAttachmentUpload(attachmentSettings(noTextButDocument())!, {
      fetch: send,
    });

    const refusal = await rejectionOf(
      upload(file('text/plain', MIB + 1), { signal: new AbortController().signal }),
    );

    expect(refusal).toMatchObject({ kind: 'too-large', limit: MIB });
    expect(calls).toEqual([]);
  });
});

describe('the words for an attachment that cannot be attached', () => {
  const big = file('image/png');

  test('tooLarge names the limit', () => {
    expect(CHAT_COPY.attachments.tooLarge(10 * MIB)).toBe(
      'This file is larger than the 10 MB this agent accepts.',
    );
    expect(
      chatAttachmentErrorMessage({ kind: 'too-large', file: big, maxFileSize: 10 * MIB }),
    ).toBe(CHAT_COPY.attachments.tooLarge(10 * MIB));
  });

  test('typeNotAccepted', () => {
    expect(
      chatAttachmentErrorMessage({ kind: 'type-not-accepted', file: big, acceptedTypes: [] }),
    ).toBe(CHAT_COPY.attachments.typeNotAccepted);
  });

  test('uploadFailed, for a fault that is not one the page named', () => {
    expect(
      chatAttachmentErrorMessage({ kind: 'upload-failed', file: big, error: new Error('x') }),
    ).toBe(CHAT_COPY.attachments.uploadFailed);
    expect(
      chatAttachmentErrorMessage({
        kind: 'upload-failed',
        file: big,
        error: new AttachmentUploadError('upload-failed'),
      }),
    ).toBe(CHAT_COPY.attachments.uploadFailed);
  });

  test('rejected', () => {
    expect(
      chatAttachmentErrorMessage({
        kind: 'upload-failed',
        file: big,
        error: new AttachmentUploadError('rejected'),
      }),
    ).toBe(CHAT_COPY.attachments.rejected);
  });

  test('expired', () => {
    expect(
      chatAttachmentErrorMessage({
        kind: 'upload-failed',
        file: big,
        error: new AttachmentUploadError('expired'),
      }),
    ).toBe(CHAT_COPY.attachments.expired);
  });

  test('a limit found by the hook is worded as tooLarge, with the hook’s limit', () => {
    expect(
      chatAttachmentErrorMessage({
        kind: 'upload-failed',
        file: big,
        error: new AttachmentUploadError('too-large', { limit: 3 * MIB }),
      }),
    ).toBe(CHAT_COPY.attachments.tooLarge(3 * MIB));
  });
});

describe('the words for a run that was refused over an attachment', () => {
  const runError = (backendCode: string) =>
    new ChatRunFailureError({
      name: 'AGUIRunError',
      message: 'Asset "asset-9" is deleted',
      kind: 'generate',
      code: 'UNKNOWN',
      backendCode,
    });

  test.each(['UNSUPPORTED_MEDIA_TYPE', 'MEDIA_NOT_ADMITTED'])(
    'modelRefusedMedia, for %s',
    (code) => {
      expect(runFailureMessage(runError(code), { hadAttachments: false })).toBe(
        CHAT_COPY.attachments.modelRefusedMedia,
      );
    },
  );

  test('modelRefusedMedia does not tell the person to remove a file, which the send already cleared', () => {
    expect(CHAT_COPY.attachments.modelRefusedMedia).not.toMatch(/remove/i);
    expect(CHAT_COPY.attachments.modelRefusedMedia).toMatch(/send again/i);
  });

  test('modelRefusedMedia, for the door’s INVALID_INPUT on a turn that carried attachments, never the raw message', () => {
    const message = runFailureMessage(runError('INVALID_INPUT'), { hadAttachments: true });

    expect(message).toBe(CHAT_COPY.attachments.modelRefusedMedia);
    expect(message).not.toContain('asset-9');
  });

  test('leaves an INVALID_INPUT on a turn with no attachment, and any other failure, as they were', () => {
    expect(runFailureMessage(runError('INVALID_INPUT'), { hadAttachments: false })).toBeUndefined();
    expect(runFailureMessage(runError('RUN_NOT_FOUND'), { hadAttachments: true })).toBeUndefined();
    expect(runFailureMessage(new Error('x'), { hadAttachments: true })).toBeUndefined();
  });
});

describe('createAttachmentUpload', () => {
  const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result });
  function bureau() {
    const methods: string[] = [];
    const send: Fetcher = async (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        method: string;
      };
      methods.push(body.method);
      if (body.method.endsWith('complete')) {
        return ok({ assetId: 'asset-3', mediaType: 'image/png' });
      }
      return ok({ uploadId: 'upload-3' });
    };
    return { methods, send };
  }

  test('uploads a file within its limit and answers the reference Chat keeps', async () => {
    const { methods, send } = bureau();
    const upload = createAttachmentUpload(attachmentSettings(media())!, { fetch: send });

    const reference = await upload(file('image/png'), { signal: new AbortController().signal });

    expect(reference).toEqual({ id: 'asset-3', mimeType: 'image/png' });
    expect(methods).toHaveLength(3);
  });

  test('refuses a file over its own type’s limit before calling the Bureau', async () => {
    const { methods, send } = bureau();
    const upload = createAttachmentUpload(attachmentSettings(media())!, { fetch: send });

    const refusal = upload(file('image/png', 10 * MIB + 1), {
      signal: new AbortController().signal,
    });

    expect(await rejectionOf(refusal)).toMatchObject({ kind: 'too-large', limit: 10 * MIB });
    expect(methods).toEqual([]);
  });
});

describe('messageWithAttachments', () => {
  const uploaded = (
    id: string,
    type: string,
    extra: Partial<ChatAttachment> = {},
  ): ChatAttachment => ({
    id: `attachment-${id}`,
    file: new File(['x'], `${id}.bin`, { type }),
    previewUrl: `blob:${id}`,
    kind: 'document',
    status: 'ready',
    reference: { id, mimeType: type },
    ...extra,
  });

  test('leaves a message with nothing uploaded as it was', () => {
    const message = { role: 'user' as const, content: 'Hello' };

    expect(messageWithAttachments(message, [])).toBe(message);
    expect(messageWithAttachments(message, [uploaded('a', 'image/png', { status: 'error' })])).toBe(
      message,
    );
  });

  test('puts each uploaded file on the message as a media part from the bureau provider, after the text', () => {
    const message = messageWithAttachments({ role: 'user', content: 'Look' }, [
      uploaded('asset-1', 'image/png'),
      uploaded('asset-2', 'audio/wav'),
      uploaded('asset-3', 'video/mp4'),
      uploaded('asset-4', 'application/pdf'),
    ]);

    expect(message.content).toEqual([
      { type: 'text', text: 'Look' },
      {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'provider-file', provider: 'bureau', providerFileId: 'asset-1' },
      },
      {
        type: 'audio',
        mimeType: 'audio/wav',
        source: { kind: 'provider-file', provider: 'bureau', providerFileId: 'asset-2' },
      },
      {
        type: 'video',
        mimeType: 'video/mp4',
        source: { kind: 'provider-file', provider: 'bureau', providerFileId: 'asset-3' },
      },
      {
        type: 'document',
        mimeType: 'application/pdf',
        source: { kind: 'provider-file', provider: 'bureau', providerFileId: 'asset-4' },
      },
    ]);
  });

  test('has no text part for a message with no text', () => {
    const message = messageWithAttachments({ role: 'user', content: '' }, [
      uploaded('asset-1', 'image/png'),
    ]);

    expect(message.content).toHaveLength(1);
  });
});
