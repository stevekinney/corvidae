import { describe, expect, it } from 'bun:test';

import { ThemePreviewApplier } from './theme-preview-applier.ts';
import { startThemePreviewFrame } from './theme-preview-frame.ts';
import {
  createAppliedMessage,
  createApplyMessage,
  createReadyMessage,
  createRejectedMessage,
  createResetMessage,
  MAX_THEME_PREVIEW_MESSAGE_BYTES,
  MAX_THEME_PREVIEW_PROPERTY_RECORDS,
  THEME_PREVIEW_CONTEXTS,
  themePreviewValueProblem,
  validateFrameMessage,
  validateParentMessage,
  type ThemePreviewContext,
} from './theme-preview-message.ts';
import { PUBLIC_THEME_PROPERTIES } from './theme-preview-properties.ts';

const ORIGIN = 'https://playground.local';
const BUILDER = { name: 'builder window' };
const FRAME = { name: 'frame window' };
const LIGHT: ThemePreviewContext = { colorMode: 'light', motion: 'default' };
const DARK_REDUCED: ThemePreviewContext = { colorMode: 'dark', motion: 'reduced' };

const parentOptions = (lastRevision = -1) => ({
  expectedSource: BUILDER,
  expectedOrigin: ORIGIN,
  lastRevision,
  allowedProperties: PUBLIC_THEME_PROPERTIES,
});
const fromBuilder = (data: unknown, overrides: { source?: unknown; origin?: string } = {}) => ({
  source: BUILDER,
  origin: ORIGIN,
  data,
  ...overrides,
});
const apply = (properties: { name: string; value: string }[], revision = 1) =>
  createApplyMessage({
    revision,
    context: LIGHT,
    sceneId: 'components/button-variants',
    properties,
  });

describe('the public property allow-list', () => {
  it('is derived from the registry and is not empty', () => {
    expect(PUBLIC_THEME_PROPERTIES.size).toBeGreaterThan(0);
    expect(PUBLIC_THEME_PROPERTIES.has('--cinder-space-0')).toBe(true);
  });
});

describe('parent to frame validation', () => {
  it('accepts a well-formed apply message', () => {
    const result = validateParentMessage(
      fromBuilder(apply([{ name: '--cinder-space-0', value: '4px' }])),
      parentOptions(),
    );
    expect(result.status).toBe('accepted');
  });

  it('accepts a reset message', () => {
    const result = validateParentMessage(
      fromBuilder(createResetMessage({ revision: 2, context: DARK_REDUCED, sceneId: 'a' })),
      parentOptions(1),
    );
    expect(result.status).toBe('accepted');
  });

  it('rejects a message from the wrong window', () => {
    const result = validateParentMessage(
      fromBuilder(apply([]), { source: FRAME }),
      parentOptions(),
    );
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'wrong-sender' } });
  });

  it('rejects a message with no source', () => {
    const result = validateParentMessage(fromBuilder(apply([]), { source: null }), {
      ...parentOptions(),
      expectedSource: null,
    });
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'wrong-sender' } });
  });

  it('rejects a message from another origin, including the opaque origin', () => {
    for (const origin of ['https://evil.example', 'null', '']) {
      const result = validateParentMessage(fromBuilder(apply([]), { origin }), parentOptions());
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'wrong-origin' } });
    }
  });

  it('rejects data that is not a theme preview message', () => {
    for (const data of [
      null,
      'text',
      4,
      [],
      {},
      { protocol: 'other' },
      { ...apply([]), version: 2 },
    ]) {
      const result = validateParentMessage(fromBuilder(data), parentOptions());
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'malformed-message' } });
    }
  });

  it('rejects an unknown message type and a frame-only type', () => {
    for (const type of ['theme-preview:nope', 'theme-preview:ready']) {
      const result = validateParentMessage(fromBuilder({ ...apply([]), type }), parentOptions());
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'malformed-message' } });
    }
  });

  it('rejects an invalid context, a "system" motion, and a missing context', () => {
    for (const context of [
      { colorMode: 'system', motion: 'default' },
      { colorMode: 'light', motion: 'none' },
      { colorMode: 'light' },
      'light',
      null,
    ]) {
      const result = validateParentMessage(fromBuilder({ ...apply([]), context }), parentOptions());
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid-context' } });
    }
  });

  it('rejects a revision that is not a non-negative integer', () => {
    for (const revision of [-1, 1.5, '1', null, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const result = validateParentMessage(
        fromBuilder({ ...apply([]), revision }),
        parentOptions(),
      );
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid-revision' } });
    }
  });

  it('ignores a stale or repeated revision without an error', () => {
    expect(validateParentMessage(fromBuilder(apply([], 3)), parentOptions(3))).toEqual({
      status: 'stale',
      revision: 3,
    });
    expect(validateParentMessage(fromBuilder(apply([], 2)), parentOptions(3)).status).toBe('stale');
    expect(validateParentMessage(fromBuilder(apply([], 4)), parentOptions(3)).status).toBe(
      'accepted',
    );
  });

  it('accepts every concrete context', () => {
    expect(THEME_PREVIEW_CONTEXTS).toHaveLength(6);
    for (const context of THEME_PREVIEW_CONTEXTS) {
      const message = createApplyMessage({ revision: 0, context, sceneId: 'a', properties: [] });
      expect(validateParentMessage(fromBuilder(message), parentOptions()).status).toBe('accepted');
    }
  });

  it('accepts only validated public --cinder-* property names', () => {
    for (const name of [
      '--cinder-not-a-token',
      '--other-space-0',
      'color',
      '--cinder-',
      '--CINDER-space-0',
    ]) {
      const result = validateParentMessage(
        fromBuilder(apply([{ name, value: '1px' }])),
        parentOptions(),
      );
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'unknown-property' } });
    }
  });

  it('rejects a duplicated property and a malformed record', () => {
    const duplicated = apply([
      { name: '--cinder-space-0', value: '1px' },
      { name: '--cinder-space-0', value: '2px' },
    ]);
    expect(validateParentMessage(fromBuilder(duplicated), parentOptions())).toMatchObject({
      error: { code: 'duplicate-property' },
    });
    for (const properties of ['x', [null], [{ name: 4, value: '1' }], { length: 1 }]) {
      const result = validateParentMessage(
        fromBuilder({ ...apply([]), properties }),
        parentOptions(),
      );
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'malformed-message' } });
    }
  });
});

describe('property value validation', () => {
  it.each([
    ['url(https://x.example/a.png)', 'a resource function'],
    ['URL( "x" )', 'a resource function in capitals'],
    ['image(black)', 'image()'],
    ['image-set("a.png" 1x)', 'image-set()'],
    ['-webkit-image-set(x)', 'a prefixed image-set()'],
    ['paint(worklet)', 'paint()'],
    ['attr(data-x)', 'attr()'],
    ['src("x")', 'src()'],
    ['element(#x)', 'element()'],
    ['cross-fade(a, b)', 'cross-fade()'],
    ['1px; color: red', 'a semicolon'],
    ['1px } body { color: red', 'a brace'],
    ['@import "x"', 'an at-rule'],
    ['u\\72l(x)', 'a backslash escape'],
    ['1px /* c */', 'a comment'],
    ['1px !important', 'an important flag'],
    ['<script>', 'angle brackets'],
    ['calc(1px', 'unbalanced parentheses'],
    ['1px)', 'unbalanced parentheses'],
    ['  ', 'an empty value'],
    ['a\nb', 'a control character'],
    ['x'.repeat(3000), 'an oversized value'],
  ])('rejects %s (%s)', (value) => {
    expect(themePreviewValueProblem(value)).not.toBeNull();
    const result = validateParentMessage(
      fromBuilder(apply([{ name: '--cinder-space-0', value }])),
      parentOptions(),
    );
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid-value' } });
  });

  it.each([
    '#112233',
    'oklch(0.7 0.1 250)',
    'light-dark(#fff, #000)',
    'calc(var(--cinder-space-1) * 2)',
    '"Inter", system-ui, sans-serif',
    'cubic-bezier(0.2, 0, 0, 1)',
    '120ms',
    '0 1px 2px rgb(0 0 0 / 20%)',
  ])('accepts %s', (value) => {
    expect(themePreviewValueProblem(value)).toBeNull();
  });

  it('rejects a non-string value', () => {
    expect(themePreviewValueProblem(4)).not.toBeNull();
  });
});

describe('size limits', () => {
  it('rejects more than the property record limit with a named error', () => {
    const properties = Array.from({ length: MAX_THEME_PREVIEW_PROPERTY_RECORDS + 1 }, () => ({
      name: '--cinder-space-0',
      value: '1px',
    }));
    const result = validateParentMessage(fromBuilder(apply(properties)), parentOptions());
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'too-many-properties' } });
  });

  it('accepts exactly the property record limit when names are distinct', () => {
    const names = [...PUBLIC_THEME_PROPERTIES];
    const properties = Array.from(
      { length: Math.min(names.length, MAX_THEME_PREVIEW_PROPERTY_RECORDS) },
      (_, index) => ({
        name: names[index]!,
        value: '1px',
      }),
    );
    expect(validateParentMessage(fromBuilder(apply(properties)), parentOptions()).status).toBe(
      'accepted',
    );
  });

  it('rejects a message above one MiB before reading its shape', () => {
    const data = { ...apply([]), padding: 'x'.repeat(MAX_THEME_PREVIEW_MESSAGE_BYTES) };
    const result = validateParentMessage(fromBuilder(data), parentOptions());
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'message-too-large' } });
  });

  it('rejects data that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(validateParentMessage(fromBuilder(cyclic), parentOptions())).toMatchObject({
      error: { code: 'malformed-message' },
    });
  });
});

describe('frame to parent validation', () => {
  const frameOptions = (expectedRevision: number | null = 4, expectedContext = LIGHT) => ({
    expectedSource: FRAME,
    expectedOrigin: ORIGIN,
    expectedRevision,
    expectedContext,
  });
  const fromFrame = (data: unknown, overrides: { source?: unknown; origin?: string } = {}) => ({
    source: FRAME,
    origin: ORIGIN,
    data,
    ...overrides,
  });
  const applied = (revision = 4, context = LIGHT) =>
    createAppliedMessage({ revision, context, sceneId: 'a', propertyCount: 2 });

  it('accepts ready, a matching applied message, and a matching rejection', () => {
    expect(validateFrameMessage(fromFrame(createReadyMessage()), frameOptions()).status).toBe(
      'accepted',
    );
    expect(validateFrameMessage(fromFrame(applied()), frameOptions()).status).toBe('accepted');
    const rejection = createRejectedMessage({
      revision: 4,
      error: { code: 'invalid-value', message: 'bad' },
    });
    expect(validateFrameMessage(fromFrame(rejection), frameOptions()).status).toBe('accepted');
  });

  it('accepts an unrevisioned rejection', () => {
    const rejection = createRejectedMessage({
      revision: null,
      error: { code: 'malformed-message', message: 'bad' },
    });
    expect(validateFrameMessage(fromFrame(rejection), frameOptions(null)).status).toBe('accepted');
  });

  it('rejects the wrong sender and the wrong origin', () => {
    expect(
      validateFrameMessage(fromFrame(applied(), { source: BUILDER }), frameOptions()),
    ).toMatchObject({
      error: { code: 'wrong-sender' },
    });
    expect(
      validateFrameMessage(
        fromFrame(applied(), { origin: 'https://evil.example' }),
        frameOptions(),
      ),
    ).toMatchObject({ error: { code: 'wrong-origin' } });
  });

  it('ignores a stale acknowledgement and rejects a revision that was never sent', () => {
    expect(validateFrameMessage(fromFrame(applied(3)), frameOptions())).toEqual({
      status: 'stale',
      revision: 3,
    });
    expect(validateFrameMessage(fromFrame(applied(5)), frameOptions())).toMatchObject({
      error: { code: 'invalid-revision' },
    });
    expect(validateFrameMessage(fromFrame(applied(0)), frameOptions(null))).toMatchObject({
      error: { code: 'invalid-revision' },
    });
  });

  it('rejects an acknowledgement for another context', () => {
    expect(validateFrameMessage(fromFrame(applied(4, DARK_REDUCED)), frameOptions())).toMatchObject(
      {
        error: { code: 'context-mismatch' },
      },
    );
    expect(
      validateFrameMessage(fromFrame(applied()), frameOptions(4, null as never)),
    ).toMatchObject({
      error: { code: 'context-mismatch' },
    });
  });

  it('rejects malformed acknowledgements', () => {
    for (const data of [
      { ...applied(), propertyCount: -1 },
      { ...applied(), sceneId: 4 },
      { ...applied(), context: { colorMode: 'x', motion: 'y' } },
      { ...applied(), type: 'theme-preview:other' },
      {
        ...createRejectedMessage({ revision: 4, error: { code: 'invalid-value', message: 'm' } }),
        code: 'made-up',
      },
    ]) {
      expect(validateFrameMessage(fromFrame(data), frameOptions()).status).toBe('rejected');
    }
  });
});

describe('the frame applier', () => {
  it('sets variables on the document root and the portal container, never elsewhere', () => {
    const portal = document.createElement('div');
    portal.setAttribute('data-theme-preview-portal', '');
    document.body.append(portal);
    const applier = new ThemePreviewApplier(document);
    applier.apply(LIGHT, [{ name: '--cinder-space-0', value: '9px' }]);
    expect(document.documentElement.style.getPropertyValue('--cinder-space-0')).toBe('9px');
    expect(document.body.style.getPropertyValue('--cinder-space-0')).toBe('9px');
    expect(portal.style.getPropertyValue('--cinder-space-0')).toBe('9px');
    applier.reset(LIGHT);
    for (const target of [document.documentElement, document.body, portal]) {
      expect(target.style.getPropertyValue('--cinder-space-0')).toBe('');
    }
    portal.remove();
  });

  it('replaces the whole map, including inline properties it did not set itself', () => {
    const applier = new ThemePreviewApplier(document);
    document.documentElement.style.setProperty('--cinder-radius-sm', '99px');
    applier.apply(LIGHT, [{ name: '--cinder-space-0', value: '1px' }]);
    expect(document.documentElement.style.getPropertyValue('--cinder-radius-sm')).toBe('');
    applier.apply(LIGHT, [{ name: '--cinder-space-1', value: '2px' }]);
    expect(document.documentElement.style.getPropertyValue('--cinder-space-0')).toBe('');
    expect(applier.appliedNames()).toEqual(['--cinder-space-1']);
    applier.reset(LIGHT);
    const leftover = [...Array(document.documentElement.style.length).keys()]
      .map((index) => document.documentElement.style.item(index))
      .filter((name) => name.startsWith('--cinder-'));
    expect(leftover).toEqual([]);
  });

  it('expresses every context as attributes on the preview root', () => {
    const applier = new ThemePreviewApplier(document);
    for (const context of THEME_PREVIEW_CONTEXTS) {
      applier.apply(context, []);
      const root = document.documentElement;
      expect(root.dataset['theme']).toBe(context.colorMode);
      expect(root.style.colorScheme).toBe(context.colorMode);
      expect(root.dataset['reducedMotion']).toBe(context.motion === 'default' ? 'off' : 'on');
      expect(root.getAttribute('data-cinder-motion')).toBe(context.motion);
    }
  });
});

describe('the frame controller', () => {
  type Listener = (event: MessageEvent) => void;
  function fakeWindows() {
    const posted: unknown[] = [];
    const listeners: Listener[] = [];
    const parent = { postMessage: (message: unknown) => posted.push(message) };
    const frameWindow = {
      document,
      parent,
      location: { origin: ORIGIN },
      addEventListener: (_type: string, listener: Listener) => listeners.push(listener),
      removeEventListener: () => undefined,
    } as unknown as Window;
    const send = (data: unknown, source: unknown = parent, origin = ORIGIN) =>
      listeners.forEach((listener) => listener({ data, source, origin } as MessageEvent));
    return { frameWindow, posted, send, parent };
  }

  it('announces ready, applies a valid message, and acknowledges it', () => {
    const { frameWindow, posted, send } = fakeWindows();
    const scenes: string[] = [];
    const frame = startThemePreviewFrame({
      window: frameWindow,
      allowedProperties: PUBLIC_THEME_PROPERTIES,
      onScene: (sceneId) => scenes.push(sceneId),
    });
    expect(posted[0]).toMatchObject({ type: 'theme-preview:ready' });
    send(apply([{ name: '--cinder-space-0', value: '7px' }], 1));
    expect(document.documentElement.style.getPropertyValue('--cinder-space-0')).toBe('7px');
    expect(scenes).toEqual(['components/button-variants']);
    expect(posted[1]).toMatchObject({
      type: 'theme-preview:applied',
      revision: 1,
      propertyCount: 1,
    });
    expect(frame.lastRevision()).toBe(1);
    frame.applier.reset(LIGHT);
  });

  it('keeps the last-valid preview and names the error when a message is rejected', () => {
    const { frameWindow, posted, send } = fakeWindows();
    const errors: string[] = [];
    startThemePreviewFrame({
      window: frameWindow,
      allowedProperties: PUBLIC_THEME_PROPERTIES,
      onScene: () => undefined,
      onError: (code) => errors.push(code),
    });
    send(apply([{ name: '--cinder-space-0', value: '7px' }], 1));
    const tooMany = Array.from({ length: MAX_THEME_PREVIEW_PROPERTY_RECORDS + 1 }, () => ({
      name: '--cinder-space-0',
      value: '1px',
    }));
    send(apply(tooMany, 2));
    send(apply([{ name: '--cinder-space-0', value: 'url(x)' }], 3));
    expect(document.documentElement.style.getPropertyValue('--cinder-space-0')).toBe('7px');
    expect(errors).toEqual(['too-many-properties', 'invalid-value']);
    expect(posted.slice(-2)).toMatchObject([
      { type: 'theme-preview:rejected', revision: 2, code: 'too-many-properties' },
      { type: 'theme-preview:rejected', revision: 3, code: 'invalid-value' },
    ]);
    new ThemePreviewApplier(document).reset(LIGHT);
  });

  it('ignores stale revisions and messages from any other window or origin', () => {
    const { frameWindow, posted, send } = fakeWindows();
    startThemePreviewFrame({
      window: frameWindow,
      allowedProperties: PUBLIC_THEME_PROPERTIES,
      onScene: () => undefined,
    });
    send(apply([{ name: '--cinder-space-0', value: '5px' }], 5));
    const before = posted.length;
    send(apply([{ name: '--cinder-space-0', value: '1px' }], 4));
    send(apply([{ name: '--cinder-space-0', value: '1px' }], 6), { other: true });
    send(apply([{ name: '--cinder-space-0', value: '1px' }], 6), undefined, 'https://evil.example');
    expect(document.documentElement.style.getPropertyValue('--cinder-space-0')).toBe('5px');
    expect(posted.length).toBe(before + 1);
    expect(posted.at(-1)).toMatchObject({ type: 'theme-preview:rejected', code: 'wrong-origin' });
    new ThemePreviewApplier(document).reset(LIGHT);
  });
});
