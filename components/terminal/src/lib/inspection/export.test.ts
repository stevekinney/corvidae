import { afterEach, describe, expect, test } from 'bun:test';

import type { TerminalProjection } from '../components/terminal/terminal-projection.ts';
import { buildTextExport, saveTextAsFile, textSaver } from './export.ts';
import { EXPORT_BYTE_LIMIT, EXPORT_FILE_NAME, EXPORT_LINE_LIMIT } from './inspection-types.ts';

const encoder = new TextEncoder();

function projectionOf(text: string, truncated = false): TerminalProjection {
  return { text, truncated, bytes: encoder.encode(text).length };
}

describe('buildTextExport', () => {
  test('carries text, truncated, exportedBytes and retainedBytes, and adds nothing to the text', () => {
    const result = buildTextExport(projectionOf('alpha\nbeta'));
    expect(result).toEqual({
      text: 'alpha\nbeta',
      truncated: false,
      exportedBytes: 10,
      retainedBytes: 10,
    });
  });

  test('counts bytes, not characters', () => {
    const result = buildTextExport(projectionOf('é\u{1f600}'));
    expect(result.exportedBytes).toBe(6);
    expect(result.retainedBytes).toBe(6);
  });

  test('cuts at the last whole code point within the byte limit, with no marker', () => {
    const result = buildTextExport(projectionOf('ab\u{1f600}cd'), {
      maximumBytes: 5,
      maximumLines: 100,
    });
    expect(result.text).toBe('ab');
    expect(result.exportedBytes).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.retainedBytes).toBe(8);
    const exact = buildTextExport(projectionOf('ab\u{1f600}cd'), {
      maximumBytes: 6,
      maximumLines: 100,
    });
    expect(exact.text).toBe('ab\u{1f600}');
    expect(exact.exportedBytes).toBe(6);
  });

  test('cuts a long ASCII text at exactly the limit', () => {
    const result = buildTextExport(projectionOf('x'.repeat(50)), {
      maximumBytes: 10,
      maximumLines: 5,
    });
    expect(result.text).toBe('x'.repeat(10));
    expect(result.truncated).toBe(true);
  });

  test('cuts at the line limit, dropping the line feed that would start the next line', () => {
    const result = buildTextExport(projectionOf('a\nb\nc\nd'), {
      maximumBytes: 100,
      maximumLines: 2,
    });
    expect(result.text).toBe('a\nb');
    expect(result.truncated).toBe(true);
    const whole = buildTextExport(projectionOf('a\nb'), { maximumBytes: 100, maximumLines: 2 });
    expect(whole.text).toBe('a\nb');
    expect(whole.truncated).toBe(false);
  });

  test('is truncated when the projection itself stopped at its read limit', () => {
    expect(buildTextExport(projectionOf('abc', true)).truncated).toBe(true);
  });

  test('never starts with a byte order mark', () => {
    const result = buildTextExport(projectionOf('﻿﻿hello'));
    expect(result.text).toBe('hello');
    expect(encoder.encode(result.text)[0]).toBe(0x68);
    expect(result.truncated).toBe(false);
  });

  test('uses the documented limits by default', () => {
    expect(EXPORT_BYTE_LIMIT).toBe(1024 * 1024);
    expect(EXPORT_LINE_LIMIT).toBe(10_000);
    const lines = Array.from({ length: EXPORT_LINE_LIMIT + 1 }, () => 'x').join('\n');
    const result = buildTextExport(projectionOf(lines));
    expect(result.text.split('\n')).toHaveLength(EXPORT_LINE_LIMIT);
    expect(result.truncated).toBe(true);
  });

  test('the text has only line feeds', () => {
    expect(buildTextExport(projectionOf('a\nb')).text).not.toContain('\r');
  });
});

describe('saveTextAsFile', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  test('offers the text as a UTF-8 plain-text download and releases the address', async () => {
    const blobs: Blob[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = (object) => {
      blobs.push(object as Blob);
      return 'blob:terminal-test';
    };
    URL.revokeObjectURL = (url) => {
      revoked.push(url);
    };
    const clicked: Array<{ href: string; download: string }> = [];
    const anchorPrototype = Object.getPrototypeOf(document.createElement('a')) as HTMLAnchorElement;
    const original = anchorPrototype.click;
    anchorPrototype.click = function click(this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    };
    try {
      saveTextAsFile('héllo\n');
    } finally {
      anchorPrototype.click = original;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(clicked).toEqual([{ href: 'blob:terminal-test', download: EXPORT_FILE_NAME }]);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.type).toBe('text/plain;charset=utf-8');
    const bytes = new Uint8Array(await blobs[0]!.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toBe('héllo\n');
    expect(revoked).toEqual(['blob:terminal-test']);
    expect(document.querySelector('a[download]')).toBeNull();
  });

  test('the saver the controller calls is replaceable', () => {
    expect(textSaver.save.name).toBe('saveTextAsFile');
  });

  test('the file name carries nothing from the session', () => {
    expect(EXPORT_FILE_NAME).toBe('terminal-output.txt');
  });
});
