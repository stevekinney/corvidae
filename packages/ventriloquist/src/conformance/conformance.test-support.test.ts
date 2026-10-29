import { describe, expect, test } from 'bun:test';

import type { HostedProcess } from '../bun/process-types.ts';
import { reject } from '../protocol/protocol-failure.ts';
import { createScriptedStream } from '../session/fixtures/scripted-sources.ts';
import { SESSION_COOKIE, scriptedProcess } from '../websocket/websocket.test-support.ts';
import {
  createRig,
  observeProcess,
  rigAuthentication,
  type ObservedProcess,
} from './conformance.test-support.ts';

const PROFILE = {
  executable: '/bin/sh',
  argumentList: [],
  workingDirectory: '/',
  environment: {},
};

function requestWith(cookie: string | undefined): Request {
  return new Request(
    'https://terminal.example/terminal',
    cookie === undefined ? {} : { headers: { cookie } },
  );
}

describe('rigAuthentication', () => {
  test('admits the rig client’s cookie as one subject for the lifetime it was given', () => {
    expect(rigAuthentication(5_000)(requestWith(SESSION_COOKIE))).toEqual({
      ok: true,
      subject: 'user-1',
      expiresInMilliseconds: 5_000,
    });
  });

  test('gives a principal the default hour when no lifetime is given', () => {
    expect(rigAuthentication()(requestWith(SESSION_COOKIE))).toEqual({
      ok: true,
      subject: 'user-1',
      expiresInMilliseconds: 3_600_000,
    });
  });

  test.each([
    ['a different cookie', 'sid=forged'],
    ['no cookie', undefined],
  ])('denies a request with %s as unauthenticated', (_label, cookie) => {
    expect(rigAuthentication(5_000)(requestWith(cookie))).toEqual({
      ok: false,
      denial: 'unauthenticated',
    });
  });
});

describe('the direct rig client', () => {
  test('refuses to send a frame the endpoint could not build, and says why', async () => {
    const rig = createRig('direct', {
      profile: PROFILE,
      mode: 'pty',
      hosted: scriptedProcess().hosted,
    });
    try {
      expect(() => rig.client.sendResult(reject('malformed-frame', 'invalid-field'))).toThrow(
        'the endpoint refused to build the frame: invalid-field',
      );
    } finally {
      await rig.stop();
    }
  });
});

describe('observeProcess', () => {
  function observeWith(options: { readonly cancel: 'absent' | 'resolve' }): {
    readonly observed: ObservedProcess;
    readonly scripted: ReturnType<typeof createScriptedStream>;
  } {
    const scripted = createScriptedStream('pty', { cancel: options.cancel });
    const hosted: HostedProcess = { ...scriptedProcess().hosted, sources: [scripted.source] };
    return { observed: observeProcess(hosted), scripted };
  }

  function readerOf(observed: ObservedProcess) {
    const source = observed.hosted.sources[0];
    if (source?.kind !== 'stream') throw new Error('the observed source is not a stream');
    return source.stream.getReader();
  }

  test('offers no cancel on a reader that has none, so the session sees a stream it cannot cancel', async () => {
    const { observed, scripted } = observeWith({ cancel: 'absent' });
    const reader = readerOf(observed);
    expect(reader.cancel).toBeUndefined();
    scripted.end();
    expect(await reader.read()).toEqual({ done: true });
    await observed.streamsEnded;
  });

  test('forwards a cancel the reader has, with its reason', async () => {
    const { observed, scripted } = observeWith({ cancel: 'resolve' });
    const reader = readerOf(observed);
    await reader.cancel?.('over');
    expect(scripted.cancelCount).toBe(1);
    expect(await reader.read()).toEqual({ done: true });
    await observed.streamsEnded;
  });
});
