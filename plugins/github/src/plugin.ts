import {
  definePlugin,
  defineTrigger,
  verifyHmacSignature,
  type PluginSecrets,
} from '@lostgradient/interborough-plugin';
import { z } from 'zod';

/** The Bungalow secret that holds the secret the GitHub webhook is configured with. */
export const GITHUB_WEBHOOK_SECRET = 'github-webhook-secret';

/** The GitHub event types the trigger can start a run for. */
export const GITHUB_EVENTS = ['push', 'pull_request'] as const;

/** One of {@link GITHUB_EVENTS}. */
export type GithubEvent = (typeof GITHUB_EVENTS)[number];

/**
 * The events a file that selects none starts runs for: every one the plugin handles, so a
 * repository's webhook set to send pushes and pull requests needs no configuration here.
 */
export const DEFAULT_GITHUB_EVENTS: readonly GithubEvent[] = GITHUB_EVENTS;

/** The header GitHub signs the body with: `sha256=` and the HMAC-SHA-256 of the raw bytes. */
const SIGNATURE_HEADER = 'x-hub-signature-256';
const EVENT_HEADER = 'x-github-event';
const DELIVERY_HEADER = 'x-github-delivery';

/** GitHub's delivery identifier: a UUID. Anything else is not shown, so a header never carries free text into a run. */
const DELIVERY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What `fire` is handed for a delivery: the event type, GitHub's delivery id for display, and the parsed body. */
export interface GithubDelivery {
  /** The `X-GitHub-Event` value, one of the selected {@link GITHUB_EVENTS}. */
  readonly event: GithubEvent;
  /**
   * The `X-GitHub-Delivery` value when it is a UUID, else `null`. It is for display and logs: the
   * signature does not cover it, so it never decides whether a delivery is a repeat.
   */
  readonly delivery: string | null;
  /** The signed body, parsed: the event as GitHub documents it. */
  readonly payload: Record<string, unknown>;
}

const configuration = z.object({
  /** The events that start a run; with none listed, {@link DEFAULT_GITHUB_EVENTS}. */
  events: z.array(z.enum(GITHUB_EVENTS)).default([]),
});

/** An answer that is a status and nothing else, so no response carries text. */
function status(code: number): Response {
  return new Response(null, { status: code });
}

function isGithubEvent(value: string): value is GithubEvent {
  return GITHUB_EVENTS.some((event) => event === value);
}

/** The lowercase hex SHA-256 of `bytes`. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The body as a JSON object, or `undefined` when it is not UTF-8, not JSON, or not an object. */
function parseBody(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `github:webhook` trigger kind, reading the webhook secret from `secrets`. It answers only
 * with a status: 202 for a delivery it started a run for, for a repeat of one, and for one it did
 * not act on (an event the file did not select, such as `ping`, or a body that is not a JSON
 * object); 401 for a delivery whose `X-Hub-Signature-256` does not verify; and 503 when the host
 * stopped the trigger or closed, so GitHub redelivers. A paused file answers 202, as the sender is
 * not the one to retry it.
 *
 * The signature is checked over the raw body before anything else is read. The idempotency key is
 * the lowercase hex SHA-256 of those verified bytes, never `X-GitHub-Delivery`, which the signature
 * does not cover: a replayed body is one run whatever header it arrives with, and GitHub's
 * redelivery of a delivery, which sends the same bytes, starts nothing a second time.
 */
export function githubWebhook(secrets: PluginSecrets) {
  return defineTrigger({
    name: 'webhook',
    description:
      'Starts a run for each signed GitHub push or pull request delivery, once per distinct signed body.',
    configuration,
    async receive(request, context) {
      // The file's selection is read before the first await: the host owns the context, not this call.
      const chosen = [...context.configuration.events];
      const secret = await secrets.get(GITHUB_WEBHOOK_SECRET);
      const bytes = new Uint8Array(await request.arrayBuffer());
      const signed = await verifyHmacSignature({
        secret: secret ?? '',
        body: bytes,
        signature: request.headers.get(SIGNATURE_HEADER),
      });
      if (!signed) return status(401);

      const selected = chosen.length === 0 ? DEFAULT_GITHUB_EVENTS : chosen;
      const event = request.headers.get(EVENT_HEADER);
      if (event === null || !isGithubEvent(event) || !selected.includes(event)) return status(202);
      const payload = parseBody(bytes);
      if (payload === undefined) return status(202);

      const header = request.headers.get(DELIVERY_HEADER);
      const delivery: GithubDelivery = {
        event,
        delivery: header !== null && DELIVERY_PATTERN.test(header) ? header : null,
        payload,
      };
      const outcome = await context.fire(delivery, { idempotencyKey: await sha256Hex(bytes) });
      if (outcome.outcome === 'skipped' && outcome.reason !== 'paused') return status(503);
      return status(202);
    },
  });
}

/** The GitHub plugin: the `github:webhook` receive trigger, off until the owner enables it. */
export default definePlugin({
  name: 'github',
  title: 'GitHub',
  version: '1.0.0',
  description:
    'Starts a workflow run for each signed GitHub push or pull request webhook delivery. Off until you enable it.',
  enabled: false,
  secrets: [GITHUB_WEBHOOK_SECRET],
  setup: ({ secrets }) => ({ triggers: [githubWebhook(secrets)] }),
});
