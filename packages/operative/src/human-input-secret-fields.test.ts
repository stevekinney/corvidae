import { describe, expect, it } from 'bun:test';

import { humanInputSecretFields } from './human-input-schema-extensions';

const secret = { type: 'string', writeOnly: true, 'x-secret': true };

describe('humanInputSecretFields', () => {
  it('names the answer itself as the empty pointer', () => {
    expect(humanInputSecretFields(secret)).toEqual(['']);
  });

  it('names each secret field as a JSON Pointer, nested fields included', () => {
    expect(
      humanInputSecretFields({
        type: 'object',
        properties: {
          host: { type: 'string' },
          password: secret,
          'a/b~c': secret,
          account: { type: 'object', properties: { token: secret } },
        },
      }),
    ).toEqual(['/password', '/a~1b~0c', '/account/token']);
  });

  it('finds none in a schema without x-secret, or with x-secret false', () => {
    expect(humanInputSecretFields({ type: 'string' })).toEqual([]);
    expect(humanInputSecretFields({ type: 'string', 'x-secret': false })).toEqual([]);
  });
});
