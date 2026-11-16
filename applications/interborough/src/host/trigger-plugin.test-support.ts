/**
 * Two plugins for the tests of `POST /triggers/<workflow-id>` (COR-2169): `hooks`, whose `hooks:hook`
 * kind only receives and authenticates the sender with `verifyHmacSignature`, and `gated`, which
 * declares a secret nobody stores, so a delivery to its `gated:hook` kind is refused for setup.
 * Nothing here talks to a network.
 */
import type { BureauPluginEntry } from '@lostgradient/bureau';
import {
  definePlugin,
  defineTrigger,
  verifyHmacSignature,
  type PluginTriggerContext,
} from '@lostgradient/interborough-plugin';
import { z } from 'zod';

/** The secret the sender and `hooks:hook` share. */
export const HOOK_SECRET = 'whsec-hooks-0123456789abcdef';

/** The signature header `hooks:hook` reads. */
export const SIGNATURE_HEADER = 'x-hub-signature-256';

/** A header that makes `hooks:hook` throw, with the secret and the signature in the message. */
export const THROW_HEADER = 'x-throw';

export interface HookPlugin {
  /** The entries to give the host's `plugins`. */
  readonly entries: readonly BureauPluginEntry[];
  /** The context of every `receive` of `hooks:hook`, in order. */
  readonly contexts: PluginTriggerContext[];
  /** The body bytes of every delivery whose signature verified. */
  readonly verified: Uint8Array[];
}

export function hookPlugin(): HookPlugin {
  const contexts: PluginTriggerContext[] = [];
  const verified: Uint8Array[] = [];
  const hooks = definePlugin({
    name: 'hooks',
    version: '1.0.0',
    description: 'Receives signed deliveries.',
    setup: () => ({
      triggers: [
        defineTrigger({
          name: 'hook',
          description: 'Receives a signed delivery and starts the workflow.',
          configuration: z.object({}).strict(),
          receive: async (request, context) => {
            contexts.push(context);
            const body = new Uint8Array(await request.arrayBuffer());
            const signature = request.headers.get(SIGNATURE_HEADER);
            if (request.headers.has(THROW_HEADER)) {
              throw new Error(
                `delivery failed: the secret ${HOOK_SECRET} and the signature ${signature ?? 'none'}`,
              );
            }
            if (!(await verifyHmacSignature({ secret: HOOK_SECRET, body, signature }))) {
              return new Response('signature refused', { status: 401 });
            }
            verified.push(body);
            // The key comes from the signed bytes, never from a header the signature does not cover.
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
            const idempotencyKey = Array.from(digest, (byte) =>
              byte.toString(16).padStart(2, '0'),
            ).join('');
            const outcome = await context.fire({ bytes: body.byteLength }, { idempotencyKey });
            return Response.json(outcome, { status: 202 });
          },
        }),
      ],
    }),
  });
  const gated = definePlugin({
    name: 'gated',
    version: '1.0.0',
    description: 'Declares a secret nobody stores.',
    secrets: ['gated-token'],
    setup: () => ({
      triggers: [
        defineTrigger({
          name: 'hook',
          description: 'Never answers: its plugin needs setup.',
          configuration: z.object({}).strict(),
          receive: async () => new Response('should not run', { status: 200 }),
        }),
      ],
    }),
  });
  return {
    entries: [
      { descriptor: hooks, source: 'package', location: '@example/hooks' },
      { descriptor: gated, source: 'package', location: '@example/gated' },
    ],
    contexts,
    verified,
  };
}
