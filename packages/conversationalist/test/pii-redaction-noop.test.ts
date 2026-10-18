import { describe, expect, it } from 'bun:test';

import { createPIIRedactionPlugin } from '../src/index';

const bomText = btoa('\xEF\xBB\xBFplain text, nothing personal');

/**
 * COR-716 — a body with nothing to redact is left byte-for-byte as it was
 * stored: re-encoding a percent-encoded data URL, or dropping a byte-order
 * mark, would change what a provider reads for no reason.
 */
describe('PII redaction leaves a body with nothing to redact byte-for-byte', () => {
  it('a percent-encoded data URL with no PII is unchanged', () => {
    const plugin = createPIIRedactionPlugin();
    const part = {
      type: 'document' as const,
      mimeType: 'text/plain',
      source: { kind: 'data-url' as const, url: 'data:text/plain,a%21b%27c' },
    };
    const result = plugin({ role: 'user', content: [part] });
    expect((result.content as unknown[])[0]).toEqual(part);
  });

  it('a UTF-8 body with a byte-order mark and no PII is unchanged', () => {
    const plugin = createPIIRedactionPlugin();
    const part = {
      type: 'document' as const,
      mimeType: 'text/plain',
      source: { kind: 'inline' as const, data: bomText, encoding: 'base64' as const },
    };
    const result = plugin({ role: 'user', content: [part] });
    expect((result.content as unknown[])[0]).toEqual(part);
  });
});
