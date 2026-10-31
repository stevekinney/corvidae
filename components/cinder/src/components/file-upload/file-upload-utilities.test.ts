import { describe, expect, test } from 'bun:test';

import {
  acceptsFile,
  formatAcceptDescription,
  installFilePickerReturnFallback,
  installFileUploadSurfaceActivation,
} from './file-upload-utilities.ts';

describe('formatAcceptDescription', () => {
  test('falls back to a bare MIME type when it is neither a known label, an extension, nor a wildcard', () => {
    expect(formatAcceptDescription('application/json')).toBe('application/json');
  });
});

describe('installFilePickerReturnFallback', () => {
  test('returns a no-op cleanup when the input element has no owner window (e.g. a detached document)', () => {
    // `document.implementation.createHTMLDocument()` produces a Document
    // whose `defaultView` is null — the one real-world shape (a detached
    // document, as opposed to any window this test environment provides)
    // that reaches the "no window to listen on" fallback.
    const detachedDocument = document.implementation.createHTMLDocument('detached');
    const input = detachedDocument.createElement('input');
    expect(input.ownerDocument.defaultView).toBeNull();

    const cleanup = installFilePickerReturnFallback(input, () => {});

    expect(() => cleanup()).not.toThrow();
  });
});

describe('installFileUploadSurfaceActivation', () => {
  test('opens the picker for a click on a surface that belongs to a detached document', () => {
    // A detached document has no window, so there is no `Element` constructor to recognize the
    // target with, and the click cannot have come from an interactive descendant.
    const detachedDocument = document.implementation.createHTMLDocument('detached');
    const surface = detachedDocument.createElement('div');
    expect(surface.ownerDocument.defaultView).toBeNull();
    let opened = 0;
    const { destroy } = installFileUploadSurfaceActivation(
      surface,
      () => false,
      () => {
        opened += 1;
      },
    );

    surface.dispatchEvent(new Event('click'));
    expect(opened).toBe(1);

    destroy();
    surface.dispatchEvent(new Event('click'));
    expect(opened).toBe(1);
  });
});

describe('acceptsFile', () => {
  const named = (name: string, type: string): File => new File(['x'], name, { type });

  test('a file whose type the browser could not name is accepted against a media type', () => {
    expect(acceptsFile(named('config.yaml', ''), 'application/yaml')).toBe(true);
    expect(acceptsFile(named('config.yaml', ''), 'image/*')).toBe(true);
  });

  test('x- marks the same type under an older name', () => {
    expect(acceptsFile(named('config.yaml', 'application/x-yaml'), 'application/yaml')).toBe(true);
    expect(acceptsFile(named('config.yaml', 'application/yaml'), 'application/x-yaml')).toBe(true);
  });

  test('a named type that does not match is still refused, and extensions still decide by name', () => {
    expect(acceptsFile(named('notes.txt', 'text/plain'), 'application/yaml')).toBe(false);
    expect(acceptsFile(named('logo.png', 'image/png'), 'image/*')).toBe(true);
    expect(acceptsFile(named('a.yaml', ''), '.json')).toBe(false);
    expect(acceptsFile(named('a.json', ''), '.json')).toBe(true);
  });
});
