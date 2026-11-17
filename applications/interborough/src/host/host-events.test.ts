/**
 * COR-2098: the host's events reach every listener the Bureau registered, as copies, and a listener
 * that throws stops neither the others nor the writer. Nothing is held for a listener that is not
 * there yet.
 */
import { describe, expect, test } from 'bun:test';

import type { BureauHostEvent } from '@lostgradient/bureau';

import { createHostEvents } from './host-events.ts';

describe('the host events (COR-2098)', () => {
  test('gives each listener each event, in the order they were published, and stops when a listener stops', () => {
    const events = createHostEvents();
    const first: BureauHostEvent[] = [];
    const second: BureauHostEvent[] = [];
    const stopFirst = events.port.subscribe((event) => first.push(event));
    events.port.subscribe((event) => second.push(event));

    events.publish('secret.set', { plugin: 'kit', key: 'kit-api-key' });
    stopFirst();
    events.publish('secret.removed', { plugin: 'kit', key: 'kit-api-key' });

    expect(first.map((event) => event.kind)).toEqual(['secret.set']);
    expect(second.map((event) => event.kind)).toEqual(['secret.set', 'secret.removed']);
  });

  test('holds nothing for a listener that is not there yet', () => {
    const events = createHostEvents();
    events.publish('secret.set', { plugin: 'kit', key: 'kit-api-key' });

    const late: BureauHostEvent[] = [];
    events.port.subscribe((event) => late.push(event));

    expect(late).toEqual([]);
  });

  test('is not stopped by a listener that throws', () => {
    const events = createHostEvents();
    const heard: string[] = [];
    events.port.subscribe(() => {
      throw new Error('the listener failed');
    });
    events.port.subscribe((event) => heard.push(event.kind));

    expect(() =>
      events.publish('plugin.settings-changed', {
        plugin: 'kit',
        enabled: true,
        restartRequired: false,
      }),
    ).not.toThrow();
    expect(heard).toEqual(['plugin.settings-changed']);
  });

  test('hands each listener its own copy, so one that changes it changes nothing another reads', () => {
    const events = createHostEvents();
    const payload = {
      plugin: 'kit',
      previousStatus: 'running',
      status: 'needs-setup',
      problemCodes: ['secret-missing'],
    } as const;
    const seen: unknown[] = [];
    events.port.subscribe((event) => {
      if (event.kind === 'plugin.status-changed')
        (event.payload.problemCodes as string[]).push('x');
    });
    events.port.subscribe((event) => seen.push(structuredClone(event.payload)));

    events.publish('plugin.status-changed', {
      ...payload,
      problemCodes: [...payload.problemCodes],
    });

    expect(seen).toEqual([{ ...payload, problemCodes: ['secret-missing'] }]);
  });
});
