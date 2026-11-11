import { describe, expect, test } from 'bun:test';

import {
  acceptedKindsText,
  attachmentBlockingReason,
  attachmentCountText,
  canRetry,
  fileTypeBadge,
  needsAttention,
  splitFileName,
  typeNotAcceptedText,
  uploadPercent,
} from './attachment-tile.ts';

describe('splitFileName', () => {
  test('keeps the extension apart so the stem can truncate in the middle', () => {
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

describe('fileTypeBadge', () => {
  test('reads the extension in capitals', () => {
    expect(fileTypeBadge('photo.png', 'image')).toBe('PNG');
    expect(fileTypeBadge('index.ts', 'code')).toBe('TS');
    expect(fileTypeBadge('brief.docx', 'document')).toBe('DOCX');
  });

  test('falls back to the kind without a short extension', () => {
    expect(fileTypeBadge('pasted-text', 'document')).toBe('DOC');
    expect(fileTypeBadge('scan.jpeg2000', 'image')).toBe('IMG');
  });
});

describe('the attention summary', () => {
  test('counts files in words without a separator glyph', () => {
    expect(attachmentCountText(1)).toBe('1 file');
    expect(attachmentCountText(14)).toBe('14 files');
    expect(attachmentCountText(3)).not.toContain(String.fromCodePoint(0xb7));
  });

  test('a refused type says so in the person’s words, and names what the composer takes (C#16)', () => {
    expect(typeNotAcceptedText(['image/*', 'application/pdf', 'text/plain'])).toBe(
      'This file type can’t be attached. Attach an image, a PDF or a text file.',
    );
    expect(acceptedKindsText(['image/png', 'image/jpeg'])).toBe('an image');
    expect(acceptedKindsText(['.csv', 'application/zip'])).toBe('a CSV file or a ZIP file');
    expect(acceptedKindsText([])).toBe('another kind of file');
    expect(typeNotAcceptedText(['image/*'])).not.toMatch(/\/|application|\*/);
  });

  test('says how to unblock Send', () => {
    expect(attachmentBlockingReason(1)).toBe('Retry or remove 1 file to send');
    expect(attachmentBlockingReason(3)).toBe('Retry or remove 3 files to send');
  });

  test('a failed file needs attention, and only a failed upload offers Retry', () => {
    expect(needsAttention({ status: 'error' })).toBe(true);
    expect(needsAttention({ status: 'ready' })).toBe(false);
    expect(canRetry({ status: 'error', retryable: true })).toBe(true);
    expect(canRetry({ status: 'error' })).toBe(false);
    expect(canRetry({ status: 'uploading', retryable: true })).toBe(false);
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
