import type {
  ProfileIdentifier,
  SessionGrant,
  SessionRequest,
  SlotStatus,
} from '../shared/profile-catalog.ts';

/** Why the server would not issue a session, in words the page can show. */
export type SessionRefusal =
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'quarantined' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly status: number };

export type SessionOutcome =
  | { readonly ok: true; readonly grant: SessionGrant }
  | { readonly ok: false; readonly refusal: SessionRefusal };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Ask the server for a session. The request names a profile and whether the page wants to be
 * read-only, and that is all: the executable, its arguments, its directory and its environment are
 * the server's. The browser sends its HttpOnly cookie by itself, which this script cannot read.
 */
export async function requestSession(
  profile: ProfileIdentifier,
  readOnly: boolean,
  fetcher: Fetch = (input, init) => fetch(input, init),
): Promise<SessionOutcome> {
  return postSession({ profile, readOnly } satisfies SessionRequest, fetcher);
}

/**
 * The review controls' `failed` fault: ask for a profile identifier the server does not own. The
 * request is otherwise the real one, so the refusal is the server's own (`400`), and still no
 * executable, argument or environment is sent.
 */
export function requestUnknownProfile(
  fetcher: Fetch = (input, init) => fetch(input, init),
): Promise<SessionOutcome> {
  return postSession({ profile: 'review-unknown-profile', readOnly: false }, fetcher);
}

/**
 * The review controls' `denied` fault: a ticket the server never issued. The server redeems the
 * ticket in `authorize`, so reversing the real one is a real refusal of the connection.
 */
export function reverseTicket(ticket: string): string {
  return ticket.split('').toReversed().join('');
}

async function postSession(body: unknown, fetcher: Fetch): Promise<SessionOutcome> {
  const response = await fetcher('/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (response.status === 201) {
    return { ok: true, grant: (await response.json()) as SessionGrant };
  }
  if (response.status === 401) return { ok: false, refusal: { kind: 'signed-out' } };
  if (response.status === 409) return { ok: false, refusal: { kind: 'busy' } };
  if (response.status === 423) return { ok: false, refusal: { kind: 'quarantined' } };
  if (response.status === 503) return { ok: false, refusal: { kind: 'unavailable' } };
  return { ok: false, refusal: { kind: 'failed', status: response.status } };
}

/** Whether the server can take a new session for this browser right now. */
export async function requestSlotStatus(
  fetcher: Fetch = (input, init) => fetch(input, init),
): Promise<SlotStatus | 'signed-out'> {
  const response = await fetcher('/session/status', { credentials: 'same-origin' });
  if (response.status === 401) return 'signed-out';
  if (!response.ok) throw new Error(`The status request failed with ${response.status}.`);
  return ((await response.json()) as { slot: SlotStatus }).slot;
}

const SLOT_POLL_MILLISECONDS = 250;
const SLOT_POLL_ATTEMPTS = 60;

/** Poll until the server's slot for this browser is free, quarantined, or the wait runs out. */
export async function waitForFreeSlot(
  fetcher: Fetch = (input, init) => fetch(input, init),
  pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<SlotStatus | 'signed-out'> {
  let status: SlotStatus | 'signed-out' = 'busy';
  for (let attempt = 0; attempt < SLOT_POLL_ATTEMPTS; attempt += 1) {
    status = await requestSlotStatus(fetcher);
    if (status !== 'busy') return status;
    await pause(SLOT_POLL_MILLISECONDS);
  }
  return status;
}

/** Words for the frame's recovery message. None of them names a command, a path or a token. */
export function describeRefusal(refusal: SessionRefusal): string {
  switch (refusal.kind) {
    case 'signed-out':
      return 'This page lost its session cookie. Reload the page.';
    case 'busy':
      return 'The previous session is still shutting down. Try again in a moment.';
    case 'quarantined':
      return 'The previous session could not be proven clean, so the server will not start another one. Restart the server.';
    case 'unavailable':
      return 'The server cannot run this profile on this machine.';
    case 'failed':
      return `The server refused the request (${refusal.status}).`;
  }
}
