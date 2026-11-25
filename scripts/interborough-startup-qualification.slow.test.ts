import { expect, test } from 'bun:test';

import {
  classifyStartupReceipt,
  isSettingsRequest,
  panelOutcomes,
} from '../applications/interborough/scripts/qualify-startup.ts';

function receipt() {
  return {
    listenerMilliseconds: 1,
    settingsRequestMilliseconds: 2,
    actionMilliseconds: 3,
    navigation: { status: 200 },
    settingsRequest: {
      sameOrigin: true,
      path: '/jsonrpc',
      method: 'POST',
      rpcMethod: 'bureau.settings.get',
      status: 200,
    },
    settings: {
      field: 'retention.audit',
      previous: '90',
      requested: '365',
      persisted: '365',
      errors: [],
    },
    missingStages: [],
    qualification: {
      name: 'ordinary-empty-home',
      required: [
        { name: 'shell', outcome: 'ready' },
        { name: 'settings-save-and-reload', outcome: 'ready' },
      ],
      expectedPanels: ['inspectors:one', 'inspectors:two'],
      panels: panelOutcomes(['inspectors:one', 'inspectors:two'], ['inspectors:one']),
    },
  };
}

test('matches only the actual same-origin Settings request', () => {
  const origin = 'http://127.0.0.1:1234';
  const body = JSON.stringify({ method: 'bureau.settings.get' });
  expect(isSettingsRequest(`${origin}/jsonrpc`, origin, 'POST', body)).toBe(true);
  expect(isSettingsRequest('http://127.0.0.1:1235/jsonrpc', origin, 'POST', body)).toBe(false);
  expect(isSettingsRequest(`${origin}/bureau/jsonrpc`, origin, 'POST', body)).toBe(false);
  expect(isSettingsRequest(`${origin}/jsonrpc`, origin, 'GET', body)).toBe(false);
  expect(isSettingsRequest(`${origin}/jsonrpc`, origin, 'POST', '{')).toBe(false);
  expect(
    isSettingsRequest(`${origin}/jsonrpc`, origin, 'POST', '{"method":"bureau.settings.schema"}'),
  ).toBe(false);
});

test('binds the successful request and persisted action to the intended setting', () => {
  const value = receipt();
  expect(classifyStartupReceipt(value)).toEqual({ action: 'valid', instrumentation: 'complete' });
  expect(
    classifyStartupReceipt({
      ...value,
      settingsRequest: { ...value.settingsRequest, sameOrigin: false },
    }).action,
  ).toBe('invalid');
  expect(
    classifyStartupReceipt({ ...value, settings: { ...value.settings, field: 'other' } }).action,
  ).toBe('invalid');
  expect(
    classifyStartupReceipt({ ...value, settings: { ...value.settings, persisted: '90' } }).action,
  ).toBe('invalid');
  expect(
    classifyStartupReceipt({
      ...value,
      settings: { ...value.settings, requested: '90', persisted: '90' },
    }).action,
  ).toBe('invalid');
  expect(classifyStartupReceipt({ ...value, actionMilliseconds: undefined }).action).toBe(
    'invalid',
  );
});

test('retains optional degradation but rejects missing required stages and cross-namespace panels', () => {
  const value = receipt();
  expect(value.qualification.panels[1]?.outcome).toBe('optional-degraded');
  expect(classifyStartupReceipt({ ...value, missingStages: ['ui-bundle'] })).toEqual({
    action: 'valid',
    instrumentation: 'incomplete',
  });
  expect(
    classifyStartupReceipt({
      ...value,
      qualification: { ...value.qualification, required: [{ name: 'shell', outcome: 'failed' }] },
    }).action,
  ).toBe('invalid');
  expect(
    classifyStartupReceipt({
      ...value,
      qualification: {
        ...value.qualification,
        panels: [
          { id: 'another:one', outcome: 'ready' },
          { id: 'inspectors:two', outcome: 'ready' },
        ],
      },
    }).instrumentation,
  ).toBe('incomplete');
  expect(
    classifyStartupReceipt({
      ...value,
      qualification: {
        ...value.qualification,
        panels: [
          { id: 'inspectors:one', outcome: 'optional-degraded' },
          { id: 'inspectors:two', outcome: 'ready' },
        ],
      },
    }).instrumentation,
  ).toBe('incomplete');
  expect(
    classifyStartupReceipt({ ...value, inventoryError: 'panel inventory could not be observed' })
      .instrumentation,
  ).toBe('incomplete');
  expect(panelOutcomes(['inspectors:one'], ['another:one'])[0]?.outcome).toBe('optional-degraded');
});
