import { describe, expect, it } from 'bun:test';

import { A2UI_BASIC_CATALOG_ID, a2uiCatalogOf, A2UI_CINDER_CATALOG_ID } from './catalogs';
import { inputFormMessages } from './input-form';
import {
  A2UI_MESSAGE_DEFINITIONS,
  a2uiMessagesOf,
  changeDataModel,
  classifyMessage,
  isClassified,
  mergeComponents,
} from './messages';
import {
  a2uiHarness,
  BASIC,
  confirmAction,
  createMessage,
  panelComponents,
  TASK,
  updateComponentsMessage,
} from './a2ui.test-support';

const basic = a2uiCatalogOf(A2UI_BASIC_CATALOG_ID)!;

describe('the four server-to-client messages against the vendored v0.9.1 schema', () => {
  const valid = {
    createSurface: {
      version: 'v0.9.1',
      createSurface: { surfaceId: 's', catalogId: BASIC, sendDataModel: true },
    },
    updateComponents: updateComponentsMessage('s', panelComponents()),
    updateDataModel: {
      version: 'v0.9.1',
      updateDataModel: { surfaceId: 's', path: '/note', value: 'hi' },
    },
    deleteSurface: { version: 'v0.9.1', deleteSurface: { surfaceId: 's' } },
  } as const;

  for (const [kind, definition] of Object.entries(A2UI_MESSAGE_DEFINITIONS)) {
    it(`accepts a valid ${kind} and refuses it with an unknown field or version`, () => {
      const validate = basic.messageValidator(definition);
      const message = valid[kind as keyof typeof valid];
      expect(validate(message)).toBe(true);
      const body = (message as Record<string, unknown>)[kind] as Record<string, unknown>;
      expect(validate({ ...message, [kind]: { ...body, surprise: 1 } })).toBe(false);
      expect(validate({ ...message, version: 'v0.8' })).toBe(false);
    });
  }

  it('reads the A2UI v0.9 version too', () => {
    expect(
      basic.messageValidator('DeleteSurfaceMessage')({
        version: 'v0.9',
        deleteSurface: { surfaceId: 's' },
      }),
    ).toBe(true);
  });

  it('holds the forms Bureau already generates to the basic catalog', () => {
    const messages = inputFormMessages('form-1', {
      type: 'object',
      properties: { name: { type: 'string' }, ok: { type: 'boolean' } },
      required: ['name'],
    });
    for (const message of messages) {
      const kind = Object.keys(message).find((key) => key in A2UI_MESSAGE_DEFINITIONS)!;
      expect(
        basic.messageValidator(
          A2UI_MESSAGE_DEFINITIONS[kind as keyof typeof A2UI_MESSAGE_DEFINITIONS],
        )(message),
      ).toBe(true);
    }
  });
});

describe('classifying an untrusted message', () => {
  it('needs exactly one known key and a surface id', () => {
    expect(isClassified(classifyMessage(valid(), 0))).toBe(true);
    expect(classifyMessage('x', 0)).toMatchObject({ path: '/messages/0' });
    expect(classifyMessage({}, 1)).toMatchObject({ path: '/messages/1' });
    expect(classifyMessage({ ...valid(), deleteSurface: { surfaceId: 's' } }, 0)).toMatchObject({
      path: '/messages/0',
    });
    expect(classifyMessage({ createSurface: { surfaceId: '' } }, 0)).toMatchObject({
      path: '/messages/0/createSurface/surfaceId',
    });
  });

  function valid() {
    return createMessage('s');
  }
});

describe('the data model', () => {
  it('replaces the whole model at the root and at "/"', () => {
    expect(changeDataModel({ a: 1 }, undefined, { b: 2 })).toEqual({ ok: true, data: { b: 2 } });
    expect(changeDataModel({ a: 1 }, '/', [1])).toEqual({ ok: true, data: [1] });
    expect(changeDataModel({ a: 1 }, undefined, undefined)).toEqual({ ok: true, data: null });
  });

  it('sets, creates, and removes at a pointer, deterministically and without touching its input', () => {
    const current = { user: { name: 'a' }, list: [1, 2] };
    const set = changeDataModel(current, '/user/age', 3);
    expect(set).toEqual({ ok: true, data: { user: { name: 'a', age: 3 }, list: [1, 2] } });
    expect(current).toEqual({ user: { name: 'a' }, list: [1, 2] });
    expect(changeDataModel(null, '/a/b', true)).toEqual({ ok: true, data: { a: { b: true } } });
    expect(changeDataModel(current, '/user/name', undefined)).toMatchObject({ data: { user: {} } });
    expect(changeDataModel(current, '/list/2', 3)).toMatchObject({ data: { list: [1, 2, 3] } });
    expect(changeDataModel(current, '/list/0', undefined)).toMatchObject({ data: { list: [2] } });
    expect(changeDataModel(current, '/a~1b', 1)).toMatchObject({ data: { 'a/b': 1 } });
  });

  it('refuses a bad pointer, a prototype key, a bad index, a crossed scalar, and non-JSON', () => {
    expect(changeDataModel({}, 'a', 1).ok).toBe(false);
    expect(changeDataModel({}, '/__proto__/x', 1).ok).toBe(false);
    expect(changeDataModel({}, '/a~2', 1).ok).toBe(false);
    expect(changeDataModel({ list: [1] }, '/list/5', 1).ok).toBe(false);
    expect(changeDataModel({ list: [1] }, '/list/x', 1).ok).toBe(false);
    expect(changeDataModel({ a: 1 }, '/a/b', 1).ok).toBe(false);
    expect(changeDataModel({}, '/a', Number.NaN).ok).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('merging components', () => {
  it('replaces by id in place and appends the new', () => {
    const merged = mergeComponents(
      [
        { id: 'a', component: 'Text', text: '1' },
        { id: 'b', component: 'Text', text: '2' },
      ],
      [
        { id: 'b', component: 'Text', text: 'two' },
        { id: 'c', component: 'Text', text: '3' },
      ],
    );
    expect(merged.map((component) => component['id'])).toEqual(['a', 'b', 'c']);
    expect(merged[1]!['text']).toBe('two');
  });
});

describe('rebuilding a surface from storage', () => {
  it('projects create, components, and data as messages that satisfy the schema', async () => {
    const { adapter, snapshot } = a2uiHarness();
    await adapter.apply({
      taskId: TASK,
      commandId: 'c1',
      messages: [
        createMessage('panel'),
        updateComponentsMessage('panel', panelComponents()),
        { version: 'v0.9.1', updateDataModel: { surfaceId: 'panel', path: '/note', value: 'x' } },
      ],
      actions: [confirmAction],
    });
    const messages = a2uiMessagesOf(await snapshot('panel'));
    expect(messages.map((message) => Object.keys(message)[1])).toEqual([
      'createSurface',
      'updateComponents',
      'updateDataModel',
    ]);
    for (const message of messages) {
      const kind = Object.keys(message)[1] as keyof typeof A2UI_MESSAGE_DEFINITIONS;
      expect(basic.messageValidator(A2UI_MESSAGE_DEFINITIONS[kind])(message)).toBe(true);
    }
  });

  it('yields nothing for a surface of another kind', () => {
    expect(a2uiMessagesOf({ representation: { kind: 'input-form' } } as never)).toEqual([]);
  });
});

it('knows the Cinder catalog and its components', () => {
  const cinder = a2uiCatalogOf(A2UI_CINDER_CATALOG_ID)!;
  expect(cinder.componentNames.has('Checkbox')).toBe(true);
  expect(a2uiCatalogOf('https://example.com/other')).toBeUndefined();
});
