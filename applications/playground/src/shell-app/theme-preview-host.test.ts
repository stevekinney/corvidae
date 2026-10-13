import { describe, expect, it } from 'bun:test';

import { ThemePreviewHost } from './theme-preview-host.ts';
import {
  createAppliedMessage,
  createReadyMessage,
  createRejectedMessage,
  type ThemePreviewContext,
} from './theme-preview-message.ts';

const ORIGIN = 'https://playground.local';
const LIGHT: ThemePreviewContext = { colorMode: 'light', motion: 'default' };
const DARK: ThemePreviewContext = { colorMode: 'dark', motion: 'default' };

function harness() {
  const sent: unknown[] = [];
  const frame = { postMessage: (message: unknown) => sent.push(structuredClone(message)) };
  const events = {
    ready: 0,
    applied: [] as number[],
    rejected: [] as string[],
    invalid: [] as string[],
  };
  const host = new ThemePreviewHost({
    frameWindow: () => frame as unknown as Window,
    origin: ORIGIN,
    onReady: () => (events.ready += 1),
    onApplied: (message) => events.applied.push(message.revision),
    onRejected: (message) => events.rejected.push(message.code),
    onInvalid: (error) => events.invalid.push(error.code),
  });
  const receive = (data: unknown, source: unknown = frame, origin = ORIGIN) =>
    host.handleEvent({ data, source, origin } as MessageEvent);
  return { host, frame, sent, events, receive };
}

describe('the builder side of the preview channel', () => {
  it('sends the whole state as plain, cloneable data', () => {
    const { host, sent } = harness();
    const reactive = new Proxy({ ...LIGHT }, {});
    host.send({
      revision: 3,
      context: reactive,
      sceneId: 'components/button-variants',
      properties: [{ name: '--cinder-space-0', value: '1px' }],
    });
    expect(sent).toEqual([
      {
        protocol: 'cinder-theme-preview',
        version: 1,
        type: 'theme-preview:apply',
        revision: 3,
        context: LIGHT,
        sceneId: 'components/button-variants',
        properties: [{ name: '--cinder-space-0', value: '1px' }],
      },
    ]);
  });

  it('reports no frame, and survives a frame that refuses the message', () => {
    const noFrame = new ThemePreviewHost({
      frameWindow: () => null,
      origin: ORIGIN,
      onReady: () => undefined,
      onApplied: () => undefined,
      onRejected: () => undefined,
    });
    expect(noFrame.send({ revision: 0, context: LIGHT, sceneId: 'a', properties: [] })).toBe(false);
    const refusing = new ThemePreviewHost({
      frameWindow: () =>
        ({
          postMessage: () => {
            throw new Error('target origin mismatch');
          },
        }) as unknown as Window,
      origin: ORIGIN,
      onReady: () => undefined,
      onApplied: () => undefined,
      onRejected: () => undefined,
    });
    expect(refusing.send({ revision: 0, context: LIGHT, sceneId: 'a', properties: [] })).toBe(
      false,
    );
  });

  it('accepts ready, and acknowledgements that match the latest request', () => {
    const { host, events, receive } = harness();
    receive(createReadyMessage());
    host.send({ revision: 2, context: DARK, sceneId: 'a', properties: [] });
    receive(createAppliedMessage({ revision: 2, context: DARK, sceneId: 'a', propertyCount: 0 }));
    receive(
      createRejectedMessage({ revision: 2, error: { code: 'invalid-value', message: 'bad' } }),
    );
    expect(events).toMatchObject({ ready: 1, applied: [2], rejected: ['invalid-value'] });
  });

  it('ignores a stale acknowledgement from before a context switch', () => {
    const { host, events, receive } = harness();
    host.send({ revision: 1, context: LIGHT, sceneId: 'a', properties: [] });
    host.send({ revision: 2, context: DARK, sceneId: 'a', properties: [] });
    receive(createAppliedMessage({ revision: 1, context: LIGHT, sceneId: 'a', propertyCount: 0 }));
    expect(events.applied).toEqual([]);
    expect(events.invalid).toEqual([]);
  });

  it('reports an acknowledgement for the wrong context or a revision never sent', () => {
    const { host, events, receive } = harness();
    host.send({ revision: 2, context: DARK, sceneId: 'a', properties: [] });
    receive(createAppliedMessage({ revision: 2, context: LIGHT, sceneId: 'a', propertyCount: 0 }));
    receive(createAppliedMessage({ revision: 9, context: DARK, sceneId: 'a', propertyCount: 0 }));
    expect(events.applied).toEqual([]);
    expect(events.invalid).toEqual(['context-mismatch', 'invalid-revision']);
  });

  it('drops messages from any other window, and rejects the wrong origin or shape', () => {
    const { host, events, receive } = harness();
    host.send({ revision: 0, context: LIGHT, sceneId: 'a', properties: [] });
    const applied = createAppliedMessage({
      revision: 0,
      context: LIGHT,
      sceneId: 'a',
      propertyCount: 0,
    });
    receive(applied, { other: true });
    receive(applied, undefined, 'https://evil.example');
    receive({ not: 'a message' });
    expect(events.applied).toEqual([]);
    expect(events.invalid).toEqual(['wrong-origin', 'malformed-message']);
  });
});
