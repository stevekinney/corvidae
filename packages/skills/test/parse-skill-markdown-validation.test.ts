import { describe, expect, it } from 'bun:test';

import { isValidSkillName, parseSkillMarkdown, SkillParseError } from '../src/parse-skill-markdown';
describe('isValidSkillName', () => {
  it('accepts simple kebab-case names', () => {
    expect(isValidSkillName('code-review')).toBe(true);
    expect(isValidSkillName('deploy')).toBe(true);
    expect(isValidSkillName('my-skill-2')).toBe(true);
    expect(isValidSkillName('a')).toBe(true);
    expect(isValidSkillName('a1')).toBe(true);
  });

  it('rejects names starting with a digit', () => {
    expect(isValidSkillName('2fast')).toBe(false);
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
  it('throws SkillParseError for non-kebab-case names', () => {
    const markdown = ['---', 'name: Code_Review', 'description: A skill.', '---', '', 'Body.'].join(
      '\n',
    );

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
    expect(() => parseSkillMarkdown(markdown)).toThrow(/not valid kebab-case/);
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
