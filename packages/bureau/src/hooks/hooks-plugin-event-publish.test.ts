/**
 * COR-2226 — over a whole Bureau, the plugins it composes and `host.publish`: a hook listing a kind
 * a running plugin declares is pinned to the declaration's version (its own, else its plugin's),
 * receives that plugin's published event and never another plugin's of the same name; a plugin's
 * default hook may list another plugin's kind and is reconciled pinned; and once the declaring
 * plugin is gone the hook lists the kind as missing.
 */
import { definePlugin, type PluginHost } from '@lostgradient/interborough-plugin';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { BureauOptions } from '../bureau-types/options.ts';
import {
  createReceiver,
  newEncryptionKey,
  openHooksBureau,
  SIGNING_SECRET,
  waitForSettledDeliveries,
} from './hooks.test-support.ts';

const digestReady = (version?: string) => ({
  name: 'digest-ready',
  description: 'A digest is ready to read.',
  payload: z.object({ digestId: z.string().meta({ identifier: true }) }),
  ...(version === undefined ? {} : { version }),
});

type Hosts = Map<string, PluginHost>;

/**
 * `reports` (1.0.0) declares `digest-ready` with no version of its own, contributes a reaction, and
 * declares a default hook on `other:digest-ready`; `other` (2.0.0) declares `digest-ready` at 3.1.0.
 */
function plugins(hosts: Hosts, ran: string[], names: readonly string[]) {
  const reports = definePlugin({
    name: 'reports',
    version: '1.0.0',
    description: 'Writes digests.',
    hooks: [
      {
        name: 'Note other digests',
        events: ['other:digest-ready'],
        reaction: 'note',
        configuration: {},
      },
    ],
    setup: ({ host }) => {
      hosts.set('reports', host);
      return {
        events: [digestReady()],
        reactions: [
          {
            name: 'note',
            description: 'Notes the event.',
            configuration: z.object({}),
            run: (context) => {
              ran.push(context.event.kind);
              return Promise.resolve();
            },
          },
        ],
      };
    },
  });
  const other = definePlugin({
    name: 'other',
    version: '2.0.0',
    description: 'Also writes digests.',
    setup: ({ host }) => {
      hosts.set('other', host);
      return { events: [digestReady('3.1.0')] };
    },
  });
  const all = [reports, other].map((descriptor) => ({
    descriptor,
    source: 'package' as const,
    location: `@example/${descriptor.name}`,
  }));
  return all.filter(({ descriptor }) => names.includes(descriptor.name)) as NonNullable<
    BureauOptions['plugins']
  >;
}

describe('a hook on a plugin’s declared kind, over a whole Bureau (COR-2226)', () => {
  it('pins, receives its plugin’s event alone, reconciles a default hook pinned, and reads missing once the plugin is gone', async () => {
    const storage = new MemoryStorage();
    const key = await newEncryptionKey();
    const receiver = createReceiver();
    const hosts: Hosts = new Map();
    const ran: string[] = [];
    const first = await openHooksBureau({
      storage,
      key,
      fetch: receiver.fetch,
      plugins: plugins(hosts, ran, ['reports', 'other']),
    });
    let hookId: string;
    try {
      const { bureau } = first;
      await bureau.plugins.ready();
      // The declaration's own version wins; without one, the plugin's.
      const [declared] = await bureau.hooks!.list();
      expect(declared?.declaredBy?.plugin).toBe('reports');
      expect(declared?.events).toEqual(['other:digest-ready@3.1.0']);
      const hook = await bureau.hooks!.create({
        url: 'https://receiver.example/hook',
        events: ['reports:digest-ready'],
        signingSecret: SIGNING_SECRET,
      });
      hookId = hook.id;
      expect(hook.events).toEqual(['reports:digest-ready@1.0.0']);

      await hosts.get('other')!.publish('digest-ready', { digestId: 'd-0' });
      await waitUntil(() => ran.length === 1, {
        message: 'the default hook never ran on other:digest-ready',
      });
      await hosts.get('reports')!.publish('digest-ready', { digestId: 'd-1' });
      const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);
      expect(delivery?.kind).toBe('reports:digest-ready');
      expect(delivery?.status).toBe('delivered');
      expect(receiver.calls).toHaveLength(1);
      expect(JSON.parse(receiver.calls[0]!.body)).toMatchObject({
        kind: 'reports:digest-ready',
        source: 'reports',
        payload: { digestId: 'd-1' },
      });
      expect(ran).toEqual(['other:digest-ready']);
    } finally {
      await first.dispose();
    }

    const second = await openHooksBureau({
      storage,
      key,
      fetch: receiver.fetch,
      plugins: plugins(hosts, ran, ['other']),
    });
    try {
      const listed = await second.bureau.hooks!.list();
      const hook = listed.find((candidate) => candidate.id === hookId);
      expect(hook?.enabled).toBe(true);
      expect(hook?.problems).toEqual([
        { code: 'event-missing', kind: 'reports:digest-ready@1.0.0' },
      ]);
    } finally {
      await second.dispose();
    }
  });
});
