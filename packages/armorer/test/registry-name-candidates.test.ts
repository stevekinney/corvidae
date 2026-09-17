import { describe, expect, it } from 'bun:test';

import { buildRegistryNameCandidates, normalizeName } from '../src';

describe('normalizeName', () => {
  it('lowercases ASCII letters', () => {
    expect(normalizeName('ReadFile')).toBe('readfile');
    expect(normalizeName('UPPERCASE')).toBe('uppercase');
  });

  it('replaces underscores with hyphens', () => {
    expect(normalizeName('read_file')).toBe('read-file');
    expect(normalizeName('a_b_c')).toBe('a-b-c');
  });

  it('replaces slashes with hyphens', () => {
    expect(normalizeName('read/file')).toBe('read-file');
    expect(normalizeName('a/b/c')).toBe('a-b-c');
  });

  it('replaces dots with hyphens', () => {
    expect(normalizeName('read.file')).toBe('read-file');
    expect(normalizeName('a.b.c')).toBe('a-b-c');
  });

  it('handles mixed separators', () => {
    expect(normalizeName('Read_File.Name/Test')).toBe('read-file-name-test');
  });

  it('is idempotent', () => {
    const name = 'read-file';
    expect(normalizeName(normalizeName(name))).toBe(normalizeName(name));
  });

  it('handles consecutive separators', () => {
    expect(normalizeName('foo..bar')).toBe('foo--bar');
    expect(normalizeName('foo__bar')).toBe('foo--bar');
    expect(normalizeName('foo//bar')).toBe('foo--bar');
  });

  it('trims whitespace', () => {
    expect(normalizeName('  read-file  ')).toBe('read-file');
  });

  it('handles non-ASCII characters as-is (no transformation)', () => {
    expect(normalizeName('café')).toBe('café');
    expect(normalizeName('日本語')).toBe('日本語');
  });
});

describe('buildRegistryNameCandidates', () => {
  it('returns candidates in deterministic order: normalized, then suffix', () => {
    const candidates = buildRegistryNameCandidates('Read_File');
    // Normalized: read-file
    // Suffixes: ead-file, ad-file, d-file, -file, file, ile, le, e
    expect(candidates[0]).toBe('read-file');
    expect(candidates).toContain('file');
    expect(candidates).toContain('e');
  });

  it('generates suffix candidates', () => {
    const candidates = buildRegistryNameCandidates('my-tool-name');
    // Normalized: my-tool-name
    // Suffixes include: tool-name, ool-name, ol-name, ..., me, e
    expect(candidates[0]).toBe('my-tool-name');
    expect(candidates).toContain('name');
    expect(candidates).toContain('e');
  });

  it('handles single-char input', () => {
    const candidates = buildRegistryNameCandidates('a');
    expect(candidates[0]).toBe('a');
    expect(candidates).toContain('a');
  });

  it('handles empty string', () => {
    const candidates = buildRegistryNameCandidates('');
    expect(candidates).toContain('');
  });

  it('preserves order: normalized first, then suffixes', () => {
    const candidates = buildRegistryNameCandidates('TestTool');
    expect(candidates[0]).toBe('testtool');
    // Next candidates should be right-anchored suffixes: esttool, sttool, ...
    expect(candidates[1]).toBe('esttool');
    expect(candidates[2]).toBe('sttool');
  });
});
