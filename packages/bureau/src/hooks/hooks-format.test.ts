/**
 * COR-2178 (R7) — a reaction's `format(event)`, and a `notify` delivery that uses the registered
 * formatter's words. The hooks run over the scripted engine of `hooks-reactions.test-support.ts`
 * with a real `createBureauEventFormatter`, so what is asserted is what a plugin's formatter reaches.
 */
import type {
  PluginEvent,
  PluginFormatter,
  PluginFormatting,
  PluginReactionContext,
} from '@lostgradient/interborough-plugin';
import { describe, expect, it } from 'bun:test';

import { createBureauEventFormatter } from '../bureau-event-formatting.ts';
import type { HooksDependencies } from './create-hooks.ts';
import { harness } from './hooks-reactions.test-support.ts';

const SETTLED_RAW: PluginEvent = {
  kind: 'run.settled',
  bureauId: 'matrix-bureau',
  emittedAtMs: 1,
  payload: { runId: 'r1' },
};

/** The registrations of a formatter of `run.settled` for the plugin `pager`; `format` decides what it says. */
function registrations(format: PluginFormatter['format']) {
  return [{ plugin: 'pager', formatter: { name: 'settled', eventKinds: ['run.settled'], format } }];
}

/** A formatter over `format`, and the messages it sent to `diagnose`. */
function formatterWith(format: PluginFormatter['format']) {
  const diagnosed: string[] = [];
  return {
    diagnosed,
    formatEvent: createBureauEventFormatter(registrations(format), (message) => {
      diagnosed.push(message);
    }),
  };
}

/** What `format(event)` gave a reaction that asked for `event`, the context's own event by default. */
async function formattedBy(
  options: Parameters<typeof harness>[0],
  event?: PluginEvent,
): Promise<PluginFormatting> {
  let answer: PluginFormatting | undefined;
  const h = harness({
    ...options,
    run: (context: PluginReactionContext) => {
      answer = context.format(event === undefined ? context.event : event);
      return Promise.resolve();
    },
  });
  await h.hook();
  await h.open();
  h.dispatch();
  await h.drain();
  expect(answer).toBeDefined();
  return answer!;
}

describe('a reaction’s format(event) (COR-2178)', () => {
  it('returns the formatter’s formatting for the event’s kind, without the fields that name the event or the formatter', async () => {
    const { formatEvent } = formatterWith(() => ({
      title: 'A run settled',
      body: 'It took a while.',
      tier: 'warning',
      icon: 'Bell',
      link: '/runs/r1',
    }));

    expect(await formattedBy({ formatEvent })).toEqual({
      title: 'A run settled',
      body: 'It took a while.',
      tier: 'warning',
      icon: 'Bell',
      link: '/runs/r1',
    });
  });

  it('gives the event’s kind as the title, and the info tier, when no formatter claims it', async () => {
    expect(await formattedBy({})).toEqual({ title: 'run.settled', tier: 'info' });
    const { formatEvent } = formatterWith(() => ({ title: 'unused' }));
    expect(await formattedBy({ formatEvent }, { ...SETTLED_RAW, kind: 'run.started' })).toEqual({
      title: 'run.started',
      tier: 'info',
    });
  });

  it('gives the default when the formatter throws, and the failure goes to diagnose and nowhere else', async () => {
    const { formatEvent, diagnosed } = formatterWith(() => {
      throw new Error('sk-secret exploded');
    });

    const formatting = await formattedBy({ formatEvent });

    expect(formatting).toEqual({ title: 'run.settled', tier: 'info' });
    expect(JSON.stringify(formatting)).not.toContain('exploded');
    expect(diagnosed).toHaveLength(1);
  });

  it('never throws, whatever the formatter or the argument is', async () => {
    const failing: HooksDependencies['formatEvent'] = () => {
      throw new Error('the host formatter is broken');
    };
    expect(await formattedBy({ formatEvent: failing })).toEqual({
      title: 'run.settled',
      tier: 'info',
    });
    expect(await formattedBy({}, null as never)).toEqual({ title: 'event', tier: 'info' });
  });
});

describe('a notify delivery’s words (COR-2178)', () => {
  /** The notifications a harness wrote: the title and the body of each. */
  function notifying() {
    const written: Array<{ title: string; body: string }> = [];
    return {
      written,
      notifications: (() => ({
        create: (input: { readonly title: string; readonly body: string }) => {
          written.push({ title: input.title, body: input.body });
          return Promise.resolve({ notification: { id: 'notification-1' } });
        },
      })) as unknown as HooksDependencies['notifications'],
    };
  }

  async function notified(
    options: Parameters<typeof harness>[0],
    action: { readonly title?: string } = {},
  ) {
    const { written, notifications } = notifying();
    const h = harness({ ...options, notifications });
    const hook = await h.created.hooks.create({
      events: ['run.settled'],
      action: { type: 'notify', ...action },
    });
    await h.open();
    h.dispatch();
    await h.drain();
    expect(await h.status(hook.id)).toBe('delivered');
    const delivery = await h.record(hook.id);
    return { written, work: delivery.work };
  }

  it('stores the registered formatter’s title and body', async () => {
    const { formatEvent } = formatterWith((event) => ({
      title: `A run settled on ${event.bureauId}`,
      body: 'Take a look.',
    }));

    const { written, work } = await notified({ formatEvent });

    expect(written).toEqual([{ title: 'A run settled on matrix-bureau', body: 'Take a look.' }]);
    expect(work).toEqual({
      type: 'notify',
      title: 'A run settled on matrix-bureau',
      body: 'Take a look.',
    });
  });

  it('keeps the action’s own title over the formatter’s, and uses the formatter’s body', async () => {
    const { formatEvent } = formatterWith(() => ({
      title: 'From the formatter',
      body: 'Its body.',
    }));

    const { written } = await notified({ formatEvent }, { title: 'Mine' });

    expect(written).toEqual([{ title: 'Mine', body: 'Its body.' }]);
  });

  it('uses the formatter’s title and today’s body when it gives none', async () => {
    const { formatEvent } = formatterWith(() => ({ title: 'From the formatter' }));

    const { written } = await notified({ formatEvent });

    expect(written[0]?.title).toBe('From the formatter');
    expect(written[0]?.body).toMatch(/^Hook .* fired on run\.settled from Bureau matrix-bureau\.$/);
  });

  it('keeps today’s title and body for a kind no formatter claims, and when the formatter throws', async () => {
    const plain = await notified({});
    expect(plain.written).toHaveLength(1);
    expect(plain.written[0]?.title).toBe('Event run.settled');
    expect(plain.written[0]?.body).toMatch(
      /^Hook .* fired on run\.settled from Bureau matrix-bureau\.$/,
    );

    const { formatEvent, diagnosed } = formatterWith(() => {
      throw new Error('boom');
    });
    const broken = await notified({ formatEvent });
    expect(broken.written.map(({ title }) => title)).toEqual(['Event run.settled']);
    expect(JSON.stringify(broken.work)).not.toContain('boom');
    expect(diagnosed).toHaveLength(1);
  });

  it('computes the words on the owner’s projection of the event, never on the full event', async () => {
    const seen: PluginEvent[] = [];
    const formatEvent = createBureauEventFormatter(
      registrations((event) => {
        seen.push(event);
        return { title: `Settled: ${JSON.stringify(event.payload)}` };
      }),
    );

    const { written } = await notified({
      formatEvent,
      eventForHookOwner: (_owner, event) =>
        Promise.resolve({ ...event, payload: { runId: 'visible' } }),
    });

    expect(seen.map(({ payload }) => payload)).toEqual([{ runId: 'visible' }]);
    expect(written[0]?.title).toBe('Settled: {"runId":"visible"}');
    expect(JSON.stringify(written)).not.toContain('r1');
  });

  it('cuts the words to what a notification holds', async () => {
    const { formatEvent } = formatterWith(() => ({
      title: 'T'.repeat(500),
      body: 'B'.repeat(9_000),
    }));

    const { written } = await notified({ formatEvent });

    expect(written[0]?.title.length).toBeLessThanOrEqual(200);
    expect(written[0]?.body.length).toBeLessThanOrEqual(2_000);
  });
});
