import { describe, expect, test } from 'bun:test';

import {
  appendToDraft,
  followUpDiscardText,
  followUpPreview,
  followUpQueueSummary,
  followUpText,
  type QueuedFollowUp,
} from './chat-follow-up-queue.ts';

function followUp(content: string, attachmentCount = 0): QueuedFollowUp {
  return {
    id: 'follow-up-1',
    message: { role: 'user', content },
    attachments: Array.from({ length: attachmentCount }, (_, index) => ({
      id: `attachment-${String(index)}`,
      file: new File(['x'], `file-${String(index)}.txt`, { type: 'text/plain' }),
      previewUrl: '',
      kind: 'document' as const,
      status: 'ready' as const,
    })),
  };
}

describe('the Up next copy', () => {
  test('says how many wait and when they go, with no separator glyph', () => {
    expect(followUpQueueSummary(1)).toBe('1 queued, sends when this run finishes');
    expect(followUpQueueSummary(3)).toBe('3 queued, sends when this run finishes');
    expect(followUpQueueSummary(3)).not.toContain(String.fromCodePoint(0xb7));
  });

  test('says why follow-ups were set aside', () => {
    expect(followUpDiscardText(1, 'stopped')).toBe(
      'The run was stopped, so your queued follow-up was not sent.',
    );
    expect(followUpDiscardText(2, 'failed')).toBe(
      'The run failed, so your 2 queued follow-ups were not sent.',
    );
  });
});

describe('a queued follow-up', () => {
  test('previews its words, or what it carries when it has none', () => {
    expect(followUpPreview(followUp('  check the logs  '))).toBe('check the logs');
    expect(followUpPreview(followUp('', 1))).toBe('1 attachment');
    expect(followUpPreview(followUp('', 2))).toBe('2 attachments');
  });

  test('gives its words back as typed for Edit and Restore', () => {
    expect(followUpText(followUp('line one\nline two'))).toBe('line one\nline two');
  });
});

describe('appendToDraft', () => {
  test('puts each text after the draft as a paragraph of its own', () => {
    expect(appendToDraft('', ['first', 'second'])).toBe('first\n\nsecond');
    expect(appendToDraft('already typed\n', ['restored'])).toBe('already typed\n\nrestored');
  });

  test('leaves out empty texts, and an empty draft adds nothing', () => {
    expect(appendToDraft('', ['', '  ', 'only'])).toBe('only');
    expect(appendToDraft('draft', [])).toBe('draft');
  });
});
