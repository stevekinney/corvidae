/**
 * The SigV4 presigner, pinned to `Bun.S3Client.presign`. The S3 test server does not check
 * signatures, so a remote test passing proves nothing about them; this compares whole URLs with
 * Bun's at the signing time Bun chose, across endpoints, methods, session tokens, and keys that
 * need percent-encoding.
 */
import { describe, expect, test } from 'bun:test';

import { createSigV4Presigner, type PresignMethod, type SigV4PresignerOptions } from './presign.ts';

type Credentials = Omit<SigV4PresignerOptions, 'now'>;

const CREDENTIALS: readonly Credentials[] = [
  {
    endpoint: 'http://127.0.0.1:9000',
    region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    sessionToken: 'session/token+with=reserved',
    bucket: 'state',
  },
  {
    endpoint: 'https://storage.example.com/base/',
    region: 'auto',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    bucket: 'state',
  },
  {
    endpoint: 'https://storage.example.com:443',
    region: 'eu-west-2',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    bucket: 'state-bucket',
  },
];

const KEYS = [
  'plain',
  'prefix/configuration.json',
  "a/b c+d/é~!*()'.json",
  '日本/語 file',
  'double//slash',
];

const METHODS: readonly PresignMethod[] = ['GET', 'PUT', 'DELETE', 'HEAD'];

/** The time `X-Amz-Date` names, so the presigner signs at the instant Bun did. */
function signingTime(url: string): Date {
  const stamp = new URL(url).searchParams.get('X-Amz-Date') ?? '';
  const [, year, month, day, hour, minute, second] =
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp) ?? [];
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
}

function bunClient(credentials: Credentials): Bun.S3Client {
  const { sessionToken, ...rest } = credentials;
  return new Bun.S3Client({
    ...rest,
    ...(sessionToken === undefined ? {} : { sessionToken }),
    virtualHostedStyle: false,
  });
}

describe('createSigV4Presigner matches Bun.S3Client.presign', () => {
  for (const credentials of CREDENTIALS) {
    for (const method of METHODS) {
      test(`${credentials.endpoint} ${method}`, () => {
        const client = bunClient(credentials);
        for (const key of KEYS) {
          const expected = client.presign(key, { method, expiresIn: 60 });
          const presign = createSigV4Presigner({
            ...credentials,
            now: () => signingTime(expected),
          });
          expect(presign(key, { method, expiresIn: 60 })).toBe(expected);
        }
      });
    }
  }

  test('another bucket, and the default lifetime of a day', () => {
    const credentials = CREDENTIALS[0] as Credentials;
    const client = bunClient(credentials);
    const expected = client.presign('object', { bucket: 'other' });
    const presign = createSigV4Presigner({ ...credentials, now: () => signingTime(expected) });
    expect(presign('object', { bucket: 'other' })).toBe(expected);
  });
});

describe('createSigV4Presigner', () => {
  const fixed = new Date('2026-11-25T18:46:01Z');
  const presign = createSigV4Presigner({ ...(CREDENTIALS[1] as Credentials), now: () => fixed });

  test('signs extra query parameters, sorted, for a bucket listing', () => {
    const url = new URL(presign('', { query: { 'list-type': '2', prefix: 'a b/' } }));
    expect(url.pathname).toBe('/base/state');
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.searchParams.get('prefix')).toBe('a b/');
    const names = [...url.searchParams.keys()];
    expect(names).toEqual(names.toSorted());
  });

  test('a different query is a different signature', () => {
    const first = new URL(presign('', { query: { prefix: 'a/' } })).searchParams;
    const second = new URL(presign('', { query: { prefix: 'b/' } })).searchParams;
    expect(first.get('X-Amz-Signature')).not.toBe(second.get('X-Amz-Signature'));
  });

  test('refuses a lifetime SigV4 does not allow', () => {
    expect(() => presign('k', { expiresIn: 0 })).toThrow(RangeError);
    expect(() => presign('k', { expiresIn: 604_801 })).toThrow(RangeError);
    expect(() => presign('k', { expiresIn: 1.5 })).toThrow(RangeError);
  });

  test('refuses an endpoint it cannot parse without quoting it', () => {
    const endpoint = 'not a url sentinel-endpoint';
    let message = '';
    try {
      createSigV4Presigner({ ...(CREDENTIALS[1] as Credentials), endpoint });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe('The endpoint is not a valid URL.');
    expect(() =>
      createSigV4Presigner({ ...(CREDENTIALS[1] as Credentials), endpoint: 'ftp://host' }),
    ).toThrow(TypeError);
  });
});
