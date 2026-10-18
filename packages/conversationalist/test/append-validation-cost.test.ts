/**
 * COR-716 — validating an append decodes only the base64 the append adds. A
 * message already validated and frozen is not decoded again on every later
 * append, so the cost of an append does not grow with the media in the history.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { Conversation } from '../src/index';

function image(data: string) {
  return {
    type: 'image' as const,
    mimeType: 'image/png',
    source: { kind: 'inline' as const, data, encoding: 'base64' as const },
  };
}

describe('append validation decodes each payload once', () => {
  it('decodes an inline base64 payload when it is appended, not on every later append', () => {
    const conversation = new Conversation();
    const decode = spyOn(globalThis, 'atob');
    try {
      for (let index = 0; index < 5; index++) {
        conversation.appendUserMessage([image('QUJD')]);
      }
      expect(decode).toHaveBeenCalledTimes(5);
    } finally {
      decode.mockRestore();
    }
  });

  it('still refuses base64 that does not decode', () => {
    const conversation = new Conversation();
    expect(() => conversation.appendUserMessage([image('!!!')])).toThrow();
  });
});
