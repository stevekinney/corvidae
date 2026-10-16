import { describe, expect, it } from 'bun:test';

import {
  isValidSkillName,
  parseSkillMarkdown,
  SkillConformanceError,
  SkillParseError,
} from '../../src/skills/parse-skill-markdown';
describe('isValidSkillName', () => {
  it('accepts simple kebab-case names', () => {
    expect(isValidSkillName('code-review')).toBe(true);
    expect(isValidSkillName('deploy')).toBe(true);
    expect(isValidSkillName('my-skill-2')).toBe(true);
    expect(isValidSkillName('a')).toBe(true);
    expect(isValidSkillName('a1')).toBe(true);
  });

  it('accepts names starting with a digit, which the pinned validator allows', () => {
    // This package used to require a leading letter. The reference validator's rule is
    // `c.isalnum() or c == '-'` per character with no positional constraint, so `2fa-setup` is a
    // conformant name and rejecting it made this package stricter than the specification.
    expect(isValidSkillName('2fast')).toBe(true);
    expect(isValidSkillName('2fa-setup')).toBe(true);
  });

  it('accepts Unicode letters, which the pinned validator allows', () => {
    // `str.isalnum()` is true for any Unicode letter or number, so the specification's i18n
    // support is real and this package's ASCII-only pattern silently excluded it.
    expect(isValidSkillName('日本語')).toBe(true);
    expect(isValidSkillName('café-tools')).toBe(true);
  });

  it('rejects a name longer than the pinned 64-character limit', () => {
    expect(isValidSkillName('a'.repeat(64))).toBe(true);
    expect(isValidSkillName('a'.repeat(65))).toBe(false);
  });

  it('rejects names with uppercase letters', () => {
    expect(isValidSkillName('Code-Review')).toBe(false);
    expect(isValidSkillName('codeReview')).toBe(false);
  });

  it('rejects names with underscores', () => {
    expect(isValidSkillName('code_review')).toBe(false);
  });

  it('rejects names with leading or trailing hyphens', () => {
    expect(isValidSkillName('-leading')).toBe(false);
    expect(isValidSkillName('trailing-')).toBe(false);
  });

  it('rejects names with consecutive hyphens', () => {
    expect(isValidSkillName('code--review')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isValidSkillName('')).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(isValidSkillName('code review')).toBe(false);
  });

  it('rejects names with special characters', () => {
    expect(isValidSkillName('code.review')).toBe(false);
    expect(isValidSkillName('code/review')).toBe(false);
    expect(isValidSkillName('code@review')).toBe(false);
  });
});
describe('parseSkillMarkdown name validation', () => {
  it('throws SkillConformanceError for a name with invalid characters', () => {
    const markdown = ['---', 'name: Code_Review', 'description: A skill.', '---', '', 'Body.'].join(
      '\n',
    );

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillConformanceError);
    expect(() => parseSkillMarkdown(markdown)).toThrow(/contains invalid characters/);
  });

  it('reports every name failure at once rather than stopping at the first', () => {
    const markdown = ['---', 'name: -Bad_Name-', 'description: A skill.', '---', '', 'Body.'].join(
      '\n',
    );

    try {
      parseSkillMarkdown(markdown);
      throw new Error('expected parseSkillMarkdown to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SkillConformanceError);
      const codes = (error as SkillConformanceError).diagnostics.map(
        (diagnostic) => diagnostic.code,
      );
      // Upstream accumulates rather than short-circuiting, so a publisher fixing a name sees the
      // whole list in one pass.
      expect(codes).toContain('name-not-lowercase');
      expect(codes).toContain('name-hyphen-boundary');
      expect(codes).toContain('name-invalid-characters');
    }
  });

  it('throws SkillParseError for names with uppercase', () => {
    const markdown = ['---', 'name: MySkill', 'description: A skill.', '---', '', 'Body.'].join(
      '\n',
    );

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
  });
});
describe('SkillParseError', () => {
  it('is an instance of Error', () => {
    const error = new SkillParseError('test message');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SkillParseError);
    expect(error.message).toBe('test message');
  });

  it('preserves a cause', () => {
    const cause = new Error('underlying issue');
    const error = new SkillParseError('parse failed', cause);
    expect(error.cause).toBe(cause);
  });
});
