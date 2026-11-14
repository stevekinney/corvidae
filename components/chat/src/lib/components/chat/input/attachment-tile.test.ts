import { describe, expect, test } from 'bun:test';

import {
  acceptedKindsText,
  attachmentFailureLine,
  attachmentGlyph,
  canRetry,
  classifyUploadFailure,
  failureKindOf,
  isRetryableFailure,
  needsAttention,
  splitFileName,
  typeNotAcceptedText,
  uploadPercent,
} from './attachment-tile.ts';
import { ChatAttachmentUploadError, type ChatAttachment } from './chat-attachment.ts';

function attachment(overrides: Partial<ChatAttachment> & { id: string }): ChatAttachment {
  return {
    file: new File(['x'], `${overrides.id}.pdf`, { type: 'application/pdf' }),
    previewUrl: '',
    kind: 'document',
    status: 'ready',
    ...overrides,
  };
}

describe('splitFileName', () => {
  test('keeps the extension apart so the stem can shorten at its end', () => {
    expect(splitFileName('quarterly-report-final.pdf')).toEqual({
      stem: 'quarterly-report-final',
      extension: '.pdf',
    });
    expect(splitFileName('archive.tar.gz')).toEqual({ stem: 'archive.tar', extension: '.gz' });
  });

  test('treats a name with no extension, a dotfile and a trailing dot as all stem', () => {
    expect(splitFileName('Makefile')).toEqual({ stem: 'Makefile', extension: '' });
    expect(splitFileName('.env')).toEqual({ stem: '.env', extension: '' });
    expect(splitFileName('notes.')).toEqual({ stem: 'notes.', extension: '' });
  });

  test('does not take a long dotted tail for an extension', () => {
    expect(splitFileName('v1.the-final-version')).toEqual({
      stem: 'v1.the-final-version',
      extension: '',
    });
  });
});

describe('attachmentGlyph', () => {
  test('reads the media type first, then the extension', () => {
    expect(attachmentGlyph('photo.png', 'image/png', 'image')).toBe('image');
    expect(attachmentGlyph('song.mp3', 'audio/mpeg', 'document')).toBe('audio');
    expect(attachmentGlyph('clip.mov', 'video/quicktime', 'document')).toBe('video');
    expect(attachmentGlyph('brief.pdf', 'application/pdf', 'document')).toBe('document');
    expect(attachmentGlyph('numbers.xlsx', '', 'document')).toBe('spreadsheet');
    expect(attachmentGlyph('table.csv', 'text/csv', 'code')).toBe('spreadsheet');
    expect(attachmentGlyph('bundle.zip', 'application/zip', 'document')).toBe('archive');
    expect(attachmentGlyph('archive.tar.gz', '', 'document')).toBe('archive');
    expect(attachmentGlyph('index.ts', 'text/typescript', 'code')).toBe('code');
    expect(attachmentGlyph('notes.txt', 'text/plain', 'code')).toBe('document');
  });

  test('falls back to the plain file glyph for anything else', () => {
    expect(attachmentGlyph('thing.bin', 'application/octet-stream', 'document')).toBe('file');
    expect(attachmentGlyph('pasted-text', '', 'document')).toBe('file');
  });
});

describe('failures', () => {
  test('a failed file needs attention, and only a failed upload offers Retry', () => {
    expect(needsAttention({ status: 'error' })).toBe(true);
    expect(needsAttention({ status: 'ready' })).toBe(false);
    expect(canRetry({ status: 'error', retryable: true })).toBe(true);
    expect(canRetry({ status: 'error' })).toBe(false);
    expect(canRetry({ status: 'uploading', retryable: true })).toBe(false);
  });

  test('retrying can work for a connection or an unknown fault, never for the file itself', () => {
    expect(isRetryableFailure('network')).toBe(true);
    expect(isRetryableFailure('unknown')).toBe(true);
    expect(isRetryableFailure('too-large')).toBe(false);
    expect(isRetryableFailure('unsupported-type')).toBe(false);
  });

  test('a host that names no kind gets unknown', () => {
    expect(failureKindOf({})).toBe('unknown');
    expect(failureKindOf({ failureKind: 'network' })).toBe('network');
  });

  test('an upload rejection reads as the kind its host named, a TypeError as the network', () => {
    expect(
      classifyUploadFailure(new ChatAttachmentUploadError('too-large', { maxFileSize: 1024 })),
    ).toEqual({ kind: 'too-large', maxFileSize: 1024 });
    expect(classifyUploadFailure(new ChatAttachmentUploadError('unsupported-type'))).toEqual({
      kind: 'unsupported-type',
    });
    // Any error that names a kind says the same, without extending the class.
    expect(
      classifyUploadFailure(
        Object.assign(new Error('host'), { failureKind: 'too-large', maxFileSize: 2048 }),
      ),
    ).toEqual({ kind: 'too-large', maxFileSize: 2048 });
    expect(
      classifyUploadFailure(Object.assign(new Error('host'), { failureKind: 'nope' })),
    ).toEqual({ kind: 'unknown' });
    expect(classifyUploadFailure(new TypeError('Failed to fetch'))).toEqual({ kind: 'network' });
    expect(classifyUploadFailure(new Error('The service said no'))).toEqual({ kind: 'unknown' });
    expect(classifyUploadFailure('nope')).toEqual({ kind: 'unknown' });
  });

  test('no failure means no line', () => {
    expect(attachmentFailureLine([attachment({ id: 'a' })])).toBeUndefined();
  });

  test('one failed file is named, with Retry when it can be tried again and Remove when not', () => {
    const retryable = attachment({
      id: 'a',
      status: 'error',
      failureKind: 'network',
      retryable: true,
    });
    const refused = attachment({ id: 'b', status: 'error', failureKind: 'too-large' });
    expect(attachmentFailureLine([attachment({ id: 'c' }), retryable])).toMatchObject({
      type: 'one',
      kind: 'network',
      action: 'retry',
    });
    expect(attachmentFailureLine([refused])).toMatchObject({
      type: 'one',
      kind: 'too-large',
      action: 'remove',
    });
  });

  test('several failures offer only what can work: retry all, retry some with remove, or remove all', () => {
    const retryable = attachment({
      id: 'a',
      status: 'error',
      failureKind: 'network',
      retryable: true,
    });
    const refused = attachment({ id: 'b', status: 'error', failureKind: 'unsupported-type' });
    expect(attachmentFailureLine([retryable, { ...retryable, id: 'c' }])).toMatchObject({
      type: 'many',
      count: 2,
      retryable: 2,
      action: 'retry-all',
    });
    expect(attachmentFailureLine([retryable, refused])).toMatchObject({
      type: 'many',
      count: 2,
      retryable: 1,
      action: 'retry-some',
    });
    expect(
      attachmentFailureLine([refused, { ...refused, id: 'c' }, attachment({ id: 'd' })]),
    ).toMatchObject({ type: 'many', count: 2, retryable: 0, action: 'remove-all' });
  });

  test('several failures name one reason for each kind, with how many files it holds', () => {
    const offline = attachment({ id: 'a', status: 'error', failureKind: 'network' });
    const large = attachment({
      id: 'c',
      status: 'error',
      failureKind: 'too-large',
      maxFileSize: 2048,
    });
    const line = attachmentFailureLine([
      large,
      offline,
      { ...offline, id: 'b' },
      attachment({
        id: 'u',
        status: 'error',
        failureKind: 'unsupported-type',
        acceptedTypes: ['.csv'],
      }),
    ]);
    // In a fixed order, whatever order the files failed in.
    expect(line).toMatchObject({
      type: 'many',
      reasons: [
        { kind: 'network', count: 2 },
        { kind: 'too-large', count: 1, maxFileSize: 2048 },
        { kind: 'unsupported-type', count: 1, acceptedTypes: ['.csv'] },
      ],
    });
  });

  test('a long accept list is named by its first three kinds and "another kind of file"', () => {
    expect(
      acceptedKindsText([
        'image/*',
        'text/*',
        'application/json',
        'application/pdf',
        'application/xml',
      ]),
    ).toBe('an image, a text file, a JSON file or another kind of file');
    expect(acceptedKindsText(['image/*', 'text/*', 'application/json', 'application/pdf'])).toBe(
      'an image, a text file, a JSON file or a PDF',
    );
  });

  test('a picked failed file is the line’s one subject among several', () => {
    const first = attachment({ id: 'a', status: 'error', failureKind: 'network', retryable: true });
    const second = attachment({ id: 'b', status: 'error', failureKind: 'too-large' });
    expect(attachmentFailureLine([first, second], 'b')).toMatchObject({
      type: 'one',
      kind: 'too-large',
      action: 'remove',
    });
    expect(attachmentFailureLine([first, second], 'missing')).toMatchObject({ type: 'many' });
  });
});

describe('typeNotAcceptedText', () => {
  test('a refused type says so in the person’s words, and names what the composer takes (C#16)', () => {
    expect(typeNotAcceptedText(['image/*', 'application/pdf', 'text/plain'])).toBe(
      'This file type can’t be attached. Attach an image, a PDF or a text file.',
    );
    expect(acceptedKindsText(['image/png', 'image/jpeg'])).toBe('an image');
    expect(acceptedKindsText(['.csv', 'application/zip'])).toBe('a CSV file or a ZIP file');
    expect(acceptedKindsText([])).toBe('another kind of file');
    expect(typeNotAcceptedText(['image/*'])).not.toMatch(/\/|application|\*/);
  });
});

describe('uploadPercent', () => {
  test('rounds and clamps a fraction to a whole percentage', () => {
    expect(uploadPercent(0.426)).toBe(43);
    expect(uploadPercent(1.4)).toBe(100);
    expect(uploadPercent(-0.2)).toBe(0);
  });

  test('is unknown without a finite fraction', () => {
    expect(uploadPercent(undefined)).toBeUndefined();
    expect(uploadPercent(Number.NaN)).toBeUndefined();
  });
});
