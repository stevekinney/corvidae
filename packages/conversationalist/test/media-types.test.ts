/**
 * COR-716 — the shared media-type table agrees with itself: what it calls a
 * document type and what it calls text come from one table.
 */
import { describe, expect, it } from 'bun:test';

import { baseMimeType, isTextualMimeType, mimeTypeFitsModality } from '../src/media-types';

describe('the shared media-type table', () => {
  it('strips parameters and lower-cases the type', () => {
    expect(baseMimeType('Text/Plain; charset=utf-8')).toBe('text/plain');
    expect(baseMimeType('application/pdf;version=1.7')).toBe('application/pdf');
  });

  it('treats application/rtf as both a document type and text', () => {
    expect(mimeTypeFitsModality('document', 'application/rtf')).toBe(true);
    expect(isTextualMimeType('application/rtf')).toBe(true);
    expect(isTextualMimeType('application/rtf; charset=us-ascii')).toBe(true);
  });

  it('keeps binary document containers out of the textual set', () => {
    for (const mimeType of ['application/pdf', 'application/msword']) {
      expect(mimeTypeFitsModality('document', mimeType)).toBe(true);
      expect(isTextualMimeType(mimeType)).toBe(false);
    }
  });
});
