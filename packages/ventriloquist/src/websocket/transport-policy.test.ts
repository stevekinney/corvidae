import { describe, expect, test } from 'bun:test';

import {
  decideTransport,
  isLoopbackAddress,
  isLoopbackListener,
  type TransportFacts,
} from './transport-policy.ts';

describe('isLoopbackAddress', () => {
  test.each(['127.0.0.1', '127.255.255.254', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.9'])(
    '%s is loopback',
    (address) => {
      expect(isLoopbackAddress(address)).toBe(true);
    },
  );

  test.each([
    '0.0.0.0',
    '10.0.0.1',
    '192.168.1.1',
    '128.0.0.1',
    '127.0.0',
    '127.0.0.1.5',
    '127.0.0.256',
    '127.0.0.x',
    '::',
    '::2',
    '::ffff:10.0.0.1',
    'localhost',
    '',
  ])('%j is not', (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});

describe('isLoopbackListener', () => {
  test.each(['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]'])('%s is loopback', (name) => {
    expect(isLoopbackListener(name)).toBe(true);
  });

  test.each([
    undefined,
    '',
    '0.0.0.0',
    '::',
    '[::]',
    '192.168.1.5',
    'example.com',
    'localhost.evil.com',
  ])('%j listens beyond loopback or cannot be told', (name) => {
    expect(isLoopbackListener(name)).toBe(false);
  });
});

const loopbackDevelopment: TransportFacts = {
  protocol: 'http:',
  listenerHostname: '127.0.0.1',
  peerAddress: '127.0.0.1',
  allowInsecureLoopback: true,
};

describe('decideTransport', () => {
  test('admits https, with or without the development switch', () => {
    for (const allowInsecureLoopback of [true, false]) {
      expect(
        decideTransport({
          protocol: 'https:',
          listenerHostname: '0.0.0.0',
          peerAddress: '203.0.113.9',
          allowInsecureLoopback,
        }),
      ).toEqual({ allowed: true, transport: 'secure' });
    }
  });

  test('refuses plain http by default, even from loopback', () => {
    expect(decideTransport({ ...loopbackDevelopment, allowInsecureLoopback: false })).toEqual({
      allowed: false,
      reason: 'insecure-transport',
    });
  });

  test('admits plain http only with the switch, a loopback listener and a loopback peer', () => {
    expect(decideTransport(loopbackDevelopment)).toEqual({
      allowed: true,
      transport: 'loopback-development',
    });
  });

  test.each([
    ['a wildcard listener', { listenerHostname: '0.0.0.0' }],
    ['no listener hostname', { listenerHostname: undefined }],
    ['a public listener', { listenerHostname: '203.0.113.5' }],
    ['a remote peer', { peerAddress: '203.0.113.9' }],
    ['an unreadable peer', { peerAddress: undefined }],
  ] satisfies [string, Partial<TransportFacts>][])(
    'refuses the switch with %s',
    (_name, change) => {
      expect(decideTransport({ ...loopbackDevelopment, ...change })).toEqual({
        allowed: false,
        reason: 'not-loopback',
      });
    },
  );
});

describe('decideTransport behind a trusted proxy', () => {
  const behind: TransportFacts = {
    protocol: 'http:',
    listenerHostname: '0.0.0.0',
    peerAddress: '10.0.0.5',
    allowInsecureLoopback: false,
    trustedProxies: new Set(['10.0.0.5']),
    forwardedProto: 'https',
  };

  test('honors https from a trusted peer', () => {
    expect(decideTransport(behind)).toEqual({ allowed: true, transport: 'trusted-proxy' });
  });

  test('ignores the header from a peer that is not trusted', () => {
    expect(decideTransport({ ...behind, peerAddress: '10.0.0.6' })).toEqual({
      allowed: false,
      reason: 'insecure-transport',
    });
  });

  test('uses the last value of a list, which the nearest trusted proxy appended', () => {
    expect(decideTransport({ ...behind, forwardedProto: 'http, https' }).allowed).toBe(true);
    expect(decideTransport({ ...behind, forwardedProto: 'https, http' }).allowed).toBe(false);
  });

  test.each([null, '', 'http', 'wss'])('refuses %j', (forwardedProto) => {
    expect(decideTransport({ ...behind, forwardedProto }).allowed).toBe(false);
  });

  test('the loopback development switch is unchanged', () => {
    expect(
      decideTransport({
        ...behind,
        listenerHostname: '127.0.0.1',
        peerAddress: '127.0.0.1',
        trustedProxies: new Set(),
        forwardedProto: null,
        allowInsecureLoopback: true,
      }),
    ).toEqual({ allowed: true, transport: 'loopback-development' });
  });
});
