/** The message that started a run, found in the thread the run wrote into. */
import { describe, expect, test } from 'bun:test';

import { messageInOfRun } from './run-message-in.ts';

describe('messageInOfRun', () => {
  test('is the last user message before the run’s first row', () => {
    const messages = [
      { id: 'm1', role: 'user', content: 'Hello' },
      { id: 'run-1:step:0', role: 'assistant', content: 'Hi' },
      { id: 'm2', role: 'user', content: 'Please refund order 4472.' },
      { id: 'run-2:step:0', role: 'assistant', content: 'Done' },
    ];

    expect(messageInOfRun('run-1', messages)).toBe('Hello');
    expect(messageInOfRun('run-2', messages)).toBe('Please refund order 4472.');
  });

  test('joins the text parts of a message made of parts', () => {
    const messages = [
      {
        id: 'm1',
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this.' },
          { type: 'binary', mimeType: 'image/png' },
          { type: 'text', text: 'Is it right?' },
        ],
      },
      { id: 'run-1:step:0', role: 'assistant' },
    ];

    expect(messageInOfRun('run-1', messages)).toBe('Look at this.\nIs it right?');
  });

  test('is undefined when the run has no row, no user message before it, or a message with no text', () => {
    expect(messageInOfRun('run-1', [])).toBeUndefined();
    expect(messageInOfRun('run-1', [{ id: 'm1', role: 'user', content: 'Hi' }])).toBeUndefined();
    expect(
      messageInOfRun('run-1', [{ id: 'run-1:step:0', role: 'assistant', content: 'Hi' }]),
    ).toBeUndefined();
    expect(
      messageInOfRun('run-1', [
        { id: 'm1', role: 'user', content: '' },
        { id: 'run-1:step:0', role: 'assistant' },
      ]),
    ).toBeUndefined();
  });

  test('does not take a run whose identifier only begins the same for another', () => {
    const messages = [
      { id: 'm1', role: 'user', content: 'Hello' },
      { id: 'run-10:step:0', role: 'assistant' },
    ];

    expect(messageInOfRun('run-1', messages)).toBeUndefined();
  });

  test('skips a row that is not an object', () => {
    expect(messageInOfRun('run-1', [null, 'text', 3])).toBeUndefined();
  });
});
