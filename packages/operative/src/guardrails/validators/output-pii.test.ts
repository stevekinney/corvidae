import { describe, expect, it } from 'bun:test';

import { DEFAULT_PII_RULES } from 'conversationalist';

import { createOutputPIIValidator, PII_RULES } from './output-pii';

const baseContext = { step: 1, conversationLength: 3, toolCallCount: 0 };

describe('createOutputPIIValidator', () => {
  it('returns a validator with the name "output-pii"', () => {
    const validator = createOutputPIIValidator();
    expect(validator.name).toBe('output-pii');
  });

  it('passes output with no PII', async () => {
    const validator = createOutputPIIValidator();
    const result = await validator.validate('The weather is nice today.', baseContext);
    expect(result.valid).toBe(true);
  });

  describe('email detection', () => {
    it('detects email addresses', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate(
        'Contact us at john.doe@example.com for more info.',
        baseContext,
      );
      expect(result.valid).toBe(false);
      expect(result.category).toBe('pii');
    });

    it('provides redacted version with email replaced', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate('Email me at test@example.com please.', baseContext);
      expect(result.redacted).toContain('[EMAIL_REDACTED]');
      expect(result.redacted).not.toContain('test@example.com');
    });
  });

  describe('phone detection', () => {
    it('detects phone numbers', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate('Call me at 555-123-4567.', baseContext);
      expect(result.valid).toBe(false);
    });

    it('provides redacted version with phone replaced', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate('My number is (555) 123-4567.', baseContext);
      expect(result.redacted).toContain('[PHONE_REDACTED]');
    });

    it('detects phone numbers with country code', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate('Call +1-555-123-4567 for support.', baseContext);
      expect(result.valid).toBe(false);
    });
  });

  describe('API key detection', () => {
    it('detects API key patterns', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate(
        'Your api_key=sk_live_abcdef1234567890 is active.',
        baseContext,
      );
      expect(result.valid).toBe(false);
    });

    it('provides redacted version with key replaced', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate(
        'Set token="abcdef1234567890ab" in your config.',
        baseContext,
      );
      expect(result.redacted).toContain('[KEY_REDACTED]');
    });
  });

  describe('multiple PII types', () => {
    it('detects and redacts multiple PII types in one string', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate(
        'Contact john@example.com or call 555-123-4567.',
        baseContext,
      );
      expect(result.valid).toBe(false);
      expect(result.redacted).toContain('[EMAIL_REDACTED]');
      expect(result.redacted).toContain('[PHONE_REDACTED]');
    });
  });

  it('returns confidence 1.0 when PII is found', async () => {
    const validator = createOutputPIIValidator();
    const result = await validator.validate('Email: user@domain.com', baseContext);
    expect(result.confidence).toBe(1.0);
  });

  it('returns confidence 0 when no PII is found', async () => {
    const validator = createOutputPIIValidator();
    const result = await validator.validate('Just some text.', baseContext);
    expect(result.confidence).toBe(0);
  });
});

const LEGACY_PII_REGEXES = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  apiKey:
    /(?:[a-zA-Z0-9_-]*(?:api|key|secret|token|password|auth)[a-zA-Z0-9_-]*[:=]\s*["']?)([a-zA-Z0-9._-]{16,})(?:["']?)/gi,
};

const REDACTION_CORPUS = [
  'Contact john.doe@example.com or call 555-123-4567.',
  'a@b.co a.b+c%d@sub.example.org, x@y',
  '@example.com user@ .@a.bc -@-.-ab',
  'x@y.co_key@api1.co a@b.co.c@d.ef z@q.rs%t@u.vw a@b.co1@c.de',
  'api_key=sk_live_abcdef1234567890 and token="abcdef1234567890ab" end',
  'my-api-key: abcdefghijklmnop1 other=short password=abcdefghijklmnopqrst',
  'xxapixx=abcdefghijklmnop_1 AUTH:abcdefghijklmnop.q SECRET = "abcdefghijklmnopqr"',
  'key=key=abcdefghijklmnopqrst token:token:abcdefghijklmnop',
  'apikey==abcdefghijklmnopqrst a=api=abcdefghijklmnopqrst',
  'user@example.com@other.org mail:me@example.com;key=abcdefghijklmnopqr',
  'no pii here, just words and numbers 12345',
  '',
];

/** Deterministic pseudo-random strings over the characters the three rules are made of. */
function seededStrings(count: number): string[] {
  const alphabet = [
    'a',
    'x',
    '1',
    '.',
    '-',
    '_',
    '@',
    '=',
    ':',
    ' ',
    '"',
    "'",
    'api',
    'key',
    '+',
    'AUTH',
    '.co',
  ];
  let state = 0x2f6e2b1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  return Array.from({ length: count }, () => {
    let text = '';
    for (let index = 0, length = next() % 40; index < length; index += 1) {
      text += alphabet[next() % alphabet.length];
    }
    return text;
  });
}

describe('output-pii on long unbroken runs (COR-1753)', () => {
  it('keeps the same patterns as conversationalist', () => {
    for (const name of ['email', 'phone', 'apiKey'] as const) {
      expect(PII_RULES[name].regex.source).toBe(DEFAULT_PII_RULES[name].regex.source);
      expect(PII_RULES[name].regex.flags).toBe(DEFAULT_PII_RULES[name].regex.flags);
    }
  });

  it('keeps the leading character class from starting a match inside a run', () => {
    expect(PII_RULES.email.regex.source.startsWith('(?:(?<![a-zA-Z0-9._%+-])|')).toBe(true);
    expect(PII_RULES.apiKey.regex.source.startsWith('(?<![a-zA-Z0-9_-])(?=')).toBe(true);
  });

  it('redacts exactly what the unanchored patterns redacted', async () => {
    const validator = createOutputPIIValidator();
    for (const text of [...REDACTION_CORPUS, ...seededStrings(500)]) {
      let expected = text;
      expected = expected.replace(LEGACY_PII_REGEXES.email, '[EMAIL_REDACTED]');
      expected = expected.replace(LEGACY_PII_REGEXES.phone, '[PHONE_REDACTED]');
      expected = expected.replace(LEGACY_PII_REGEXES.apiKey, (match, key: string) =>
        match.replace(key, '[KEY_REDACTED]'),
      );
      const result = await validator.validate(text, baseContext);
      expect(result.valid).toBe(expected === text);
      expect(result.redacted ?? text).toBe(expected);
    }
  });

  it('passes a long unbroken run through unchanged', async () => {
    const validator = createOutputPIIValidator();
    for (const run of [
      'x'.repeat(69_000),
      '1'.repeat(69_000),
      'a.'.repeat(30_000),
      'a.bc1'.repeat(14_000),
      'api'.repeat(23_000),
    ]) {
      const result = await validator.validate(run, baseContext);
      expect(result.valid).toBe(true);
    }
  });

  it('still redacts around a long unbroken run', async () => {
    const validator = createOutputPIIValidator();
    const run = 'x'.repeat(69_000);
    const result = await validator.validate(
      `${run} mail me@example.com ${run}_api_key=abcdefghijklmnopqrstuvwxyz`,
      baseContext,
    );
    expect(result.valid).toBe(false);
    expect(result.redacted).toBe(`${run} mail [EMAIL_REDACTED] ${run}_api_key=[KEY_REDACTED]`);
  });
});
