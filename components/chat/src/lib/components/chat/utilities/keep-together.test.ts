import { describe, expect, test } from 'bun:test';

import { keepPhraseTogether, keepTimeTogether } from './keep-together.ts';

describe('keepTimeTogether', () => {
  test('joins a time to its AM or PM in every written form', () => {
    expect(keepTimeTogether('yesterday at 4:12 PM.')).toBe('yesterday at 4:12 PM.');
    expect(keepTimeTogether('at 9:05 am and 10:30 p.m.')).toBe('at 9:05 am and 10:30 p.m.');
  });

  test('leaves other text, a time with no marker and a word that merely starts with a marker', () => {
    expect(keepTimeTogether('from 4:12 Pacific')).toBe('from 4:12 Pacific');
    expect(keepTimeTogether('Nov 3 at 16:12')).toBe('Nov 3 at 16:12');
    expect(keepTimeTogether('2 amazing things')).toBe('2 amazing things');
  });

  test('leaves a time Intl already joined with a narrow no-break space', () => {
    expect(keepTimeTogether('4:12 PM')).toBe('4:12 PM');
  });
});

describe('keepPhraseTogether', () => {
  test('makes every space non-breaking', () => {
    expect(keepPhraseTogether('Nov 3')).toBe('Nov 3');
    expect(keepPhraseTogether('November 30, 2025')).toBe('November 30, 2025');
  });
});
