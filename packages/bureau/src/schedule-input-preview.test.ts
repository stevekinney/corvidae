import { describe, expect, it } from 'bun:test';

import { SCHEDULE_INPUT_PREVIEW_LENGTH, scheduleInputPreview } from './schedule-input-preview';

const characters = (text: string) => Array.from(text).length;

describe('scheduleInputPreview', () => {
  it('keeps text of exactly the limit whole, and trims the whitespace around it', () => {
    const exact = 'x'.repeat(SCHEDULE_INPUT_PREVIEW_LENGTH);
    expect(scheduleInputPreview(exact)).toBe(exact);
    expect(scheduleInputPreview(`  ${exact}\n`)).toBe(exact);
  });

  it('cuts longer text to the limit in characters, ending in an ellipsis', () => {
    const preview = scheduleInputPreview(`${'x'.repeat(SCHEDULE_INPUT_PREVIEW_LENGTH)}-TAIL`)!;
    expect(preview).toBe(`${'x'.repeat(SCHEDULE_INPUT_PREVIEW_LENGTH - 1)}…`);
    expect(characters(preview)).toBe(SCHEDULE_INPUT_PREVIEW_LENGTH);
  });

  it('keeps whole an emoji whose code units straddle index 499, where a code-unit slice splits it', () => {
    // 498 letters, then the emoji at code units 498 and 499: `slice(0, 499)` kept only its first half.
    const preview = scheduleInputPreview(`${'x'.repeat(498)}😀${'y'.repeat(10)}`)!;
    expect(preview.isWellFormed()).toBe(true);
    expect(preview).toBe(`${'x'.repeat(498)}😀…`);
    expect(characters(preview)).toBe(SCHEDULE_INPUT_PREVIEW_LENGTH);
  });

  it('drops an emoji that starts at the first character past the cut, never half of it', () => {
    const preview = scheduleInputPreview(`${'x'.repeat(499)}😀${'y'.repeat(10)}`)!;
    expect(preview.isWellFormed()).toBe(true);
    expect(preview).toBe(`${'x'.repeat(499)}…`);
  });

  it('counts characters, not UTF-16 code units, so text of emoji under the limit is whole', () => {
    const emoji = '😀'.repeat(SCHEDULE_INPUT_PREVIEW_LENGTH);
    expect(emoji.length).toBe(SCHEDULE_INPUT_PREVIEW_LENGTH * 2);
    expect(scheduleInputPreview(emoji)).toBe(emoji);
    const over = scheduleInputPreview(`${emoji}😀`)!;
    expect(over).toBe(`${'😀'.repeat(SCHEDULE_INPUT_PREVIEW_LENGTH - 1)}…`);
    expect(over.isWellFormed()).toBe(true);
  });

  it('joins the text parts of a multi-part input with a space, skipping media', () => {
    expect(
      scheduleInputPreview([
        { type: 'text', text: 'look at' },
        { type: 'image', source: { kind: 'managed-asset', assetId: 'asset-1' } },
        { type: 'text', text: 'this' },
      ]),
    ).toBe('look at this');
  });

  it('has no preview for media alone, an empty list, or blank text', () => {
    expect(
      scheduleInputPreview([{ type: 'image', source: { kind: 'managed-asset', assetId: 'a' } }]),
    ).toBeUndefined();
    expect(scheduleInputPreview([])).toBeUndefined();
    expect(scheduleInputPreview('   \n')).toBeUndefined();
  });
});
