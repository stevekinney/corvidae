import { describe, expect, it } from 'bun:test';

import { InteractiveSurfaceSchemaCompiler } from './validation';
import { validateReviewAnswer } from '../review-answer';

describe('the surface schema compiler’s format assertions', () => {
  it('keeps built-in formats as annotations when it asserts only its own formats', () => {
    const compiler = new InteractiveSurfaceSchemaCompiler({
      formats: { date: (value) => value === '2026-11-27' },
    });

    expect(
      compiler.errors(
        {
          oneOf: [{ type: 'string', format: 'email' }, { type: 'string' }],
        },
        'not an email',
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ keyword: 'oneOf' })]));
    expect(compiler.errors({ type: 'string', format: 'date' }, 'not a date')).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: 'format' })]),
    );
  });
});

describe('the surface schema interpreter’s paths', () => {
  it('keeps array indexes when a property name needs pointer escaping', () => {
    const issues = validateReviewAnswer(
      {
        type: 'array',
        items: {
          type: 'object',
          properties: { 'a/b': { type: 'string' } },
          required: ['a/b'],
          additionalProperties: false,
        },
      },
      [{ 'a/b': 1 }],
    );

    expect(issues).toEqual([{ path: [0, 'a/b'], message: '"0.a/b" must be string', code: 'type' }]);
  });
});
