import { SessionSlot } from '@lostgradient/ventriloquist';
import type { Authentication } from '@lostgradient/ventriloquist/websocket';

export const COOKIE_NAME = 'terminal-example-session';

/** How long a browser keeps the same terminal identity: one working day. */
export const BROWSER_LIFETIME_MILLISECONDS = 8 * 60 * 60 * 1000;
/** How long a ticket may wait between `POST /session` and the upgrade that redeems it. */
export const TICKET_LIFETIME_MILLISECONDS = 30 * 1000;
/** Browsers the store remembers. Past this the oldest identity is forgotten, never the newest. */
export const MAXIMUM_BROWSERS = 32;
/** Tickets outstanding at once for one browser. */
export const MAXIMUM_TICKETS = 8;

type Browser = {
  readonly subject: string;
  readonly expiresAt: number;
  readonly slot: SessionSlot;
  readonly tickets: Map<string, { readonly sessionId: string; readonly expiresAt: number }>;
};

export type SessionStoreOptions = {
  /** Milliseconds since an arbitrary origin. Defaults to the system clock; tests supply their own. */
  readonly now?: () => number;
  readonly browserLifetimeMilliseconds?: number;
  readonly ticketLifetimeMilliseconds?: number;
};

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (header === null) return undefined;
  const values: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) values.push(part.slice(separator + 1).trim());
  }
  // A cookie named twice is ambiguous, so it identifies nobody.
  return values.length === 1 ? values[0] : undefined;
}

function randomToken(): string {
  return crypto.randomUUID();
}

/**
 * Who a browser is, and what it may attach. The identity is an unguessable value in an HttpOnly
 * cookie the page's script can never read; the server remembers it, its terminal slot and the
 * one-time tickets it has issued. Nothing here is persisted: restarting the server forgets every
 * browser, which is what a local development tool wants.
 */
export class SessionStore {
  readonly #now: () => number;
  readonly #browserLifetime: number;
  readonly #ticketLifetime: number;
  readonly #browsers = new Map<string, Browser>();

  constructor(options: SessionStoreOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#browserLifetime = options.browserLifetimeMilliseconds ?? BROWSER_LIFETIME_MILLISECONDS;
    this.#ticketLifetime = options.ticketLifetimeMilliseconds ?? TICKET_LIFETIME_MILLISECONDS;
  }

  get browserCount(): number {
    return this.#browsers.size;
  }

  /** The identity the request's cookie names, if the store remembers it and it has not expired. */
  identify(request: Request): string | undefined {
    const subject = readCookie(request, COOKIE_NAME);
    if (subject === undefined) return undefined;
    const browser = this.#browsers.get(subject);
    if (browser === undefined) return undefined;
    if (browser.expiresAt <= this.#now()) {
      this.#forget(browser);
      return undefined;
    }
    return subject;
  }

  /**
   * Remember a new browser and return the `Set-Cookie` value that gives it its identity. The cookie
   * is `HttpOnly` so no script can read it, `SameSite=Strict` so no other site's request carries
   * it, and has no `Secure` attribute only because the example serves plain HTTP on loopback.
   */
  enroll(): string {
    this.#evict();
    const subject = randomToken();
    this.#browsers.set(subject, {
      subject,
      expiresAt: this.#now() + this.#browserLifetime,
      slot: new SessionSlot(),
      tickets: new Map(),
    });
    const lifetime = Math.floor(this.#browserLifetime / 1000);
    return `${COOKIE_NAME}=${subject}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime}`;
  }

  /** The `authenticate` callback of the WebSocket host: the cookie decides, and nothing else does. */
  authenticate(request: Request): Authentication {
    const subject = this.identify(request);
    if (subject === undefined) return { ok: false, denial: 'unauthenticated' };
    const browser = this.#browsers.get(subject) as Browser;
    return {
      ok: true,
      subject,
      expiresInMilliseconds: Math.max(1, browser.expiresAt - this.#now()),
    };
  }

  /** The `slotFor` callback of the WebSocket host. */
  slotFor(subject: string): SessionSlot {
    const browser = this.#browsers.get(subject);
    // `authenticate` admitted this subject a moment ago; a forgotten one gets a slot nobody else holds.
    return browser === undefined ? new SessionSlot() : browser.slot;
  }

  /** A one-time ticket for `sessionId`, redeemable once by the same browser until it expires. */
  issueTicket(subject: string, sessionId: string): string | undefined {
    const browser = this.#browsers.get(subject);
    if (browser === undefined) return undefined;
    const now = this.#now();
    for (const [ticket, entry] of browser.tickets) {
      if (entry.expiresAt <= now) browser.tickets.delete(ticket);
    }
    if (browser.tickets.size >= MAXIMUM_TICKETS) return undefined;
    const ticket = randomToken();
    browser.tickets.set(ticket, { sessionId, expiresAt: now + this.#ticketLifetime });
    return ticket;
  }

  /** Spend a ticket. It works once, only for the session and browser it was issued to. */
  redeemTicket(subject: string, sessionId: string, ticket: string): boolean {
    const browser = this.#browsers.get(subject);
    const entry = browser?.tickets.get(ticket);
    if (browser === undefined || entry === undefined) return false;
    browser.tickets.delete(ticket);
    return entry.sessionId === sessionId && entry.expiresAt > this.#now();
  }

  #evict(): void {
    const now = this.#now();
    for (const browser of this.#browsers.values()) {
      if (browser.expiresAt <= now) this.#forget(browser);
    }
    while (this.#browsers.size >= MAXIMUM_BROWSERS) {
      const oldest = this.#browsers.values().next().value as Browser;
      this.#forget(oldest);
    }
  }

  #forget(browser: Browser): void {
    this.#browsers.delete(browser.subject);
  }
}
