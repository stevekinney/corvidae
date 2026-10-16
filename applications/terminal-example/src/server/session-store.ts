import { SessionSlot } from '@lostgradient/ventriloquist';
import type { Authentication } from '@lostgradient/ventriloquist/websocket';

/** The default cookie name; the application scopes it to its port so two instances do not share it. */
export const COOKIE_NAME = 'terminal-example-session';
export function cookieNameForPort(port: number): string {
  return `${COOKIE_NAME}-${port}`;
}

/** How long a browser keeps the same terminal identity: one working day. */
export const BROWSER_LIFETIME_MILLISECONDS = 8 * 60 * 60 * 1000;
/** How long a ticket may wait between `POST /session` and the upgrade that redeems it. */
export const TICKET_LIFETIME_MILLISECONDS = 30 * 1000;
/** Browsers the store remembers. A browser whose slot is occupied or quarantined is never forgotten to make room. */
export const MAXIMUM_BROWSERS = 32;
/** New browsers admitted per window, so a flood of enrollments is slowed before it reaches the cap. */
export const ENROLLMENTS_PER_WINDOW = 60;
export const ENROLLMENT_WINDOW_MILLISECONDS = 60 * 1000;
/** Tickets outstanding at once for one browser. */
export const MAXIMUM_TICKETS = 8;

type Browser = {
  readonly subject: string;
  readonly expiresAt: number;
  readonly slot: SessionSlot;
  readonly tickets: Map<string, { readonly sessionId: string; readonly expiresAt: number }>;
};

/** Why a new browser was not admitted: the store is full of browsers that cannot be forgotten, or enrolling too fast. */
export type Enrollment =
  | { readonly ok: true; readonly setCookie: string }
  | { readonly ok: false; readonly reason: 'full' | 'rate-limited' };

export type SessionStoreOptions = {
  readonly cookieName?: string;
  readonly maximumBrowsers?: number;
  readonly enrollmentsPerWindow?: number;
  readonly enrollmentWindowMilliseconds?: number;
  /** Makes each browser's slot. Defaults to a real `SessionSlot`; a test supplies a stand-in. */
  readonly createSlot?: () => SessionSlot;
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
  readonly #cookieName: string;
  readonly #maximumBrowsers: number;
  readonly #enrollmentsPerWindow: number;
  readonly #enrollmentWindow: number;
  readonly #createSlot: () => SessionSlot;
  #enrollments: number[] = [];

  constructor(options: SessionStoreOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#browserLifetime = options.browserLifetimeMilliseconds ?? BROWSER_LIFETIME_MILLISECONDS;
    this.#ticketLifetime = options.ticketLifetimeMilliseconds ?? TICKET_LIFETIME_MILLISECONDS;
    this.#cookieName = options.cookieName ?? COOKIE_NAME;
    this.#maximumBrowsers = options.maximumBrowsers ?? MAXIMUM_BROWSERS;
    this.#enrollmentsPerWindow = options.enrollmentsPerWindow ?? ENROLLMENTS_PER_WINDOW;
    this.#enrollmentWindow = options.enrollmentWindowMilliseconds ?? ENROLLMENT_WINDOW_MILLISECONDS;
    this.#createSlot = options.createSlot ?? (() => new SessionSlot());
  }

  get cookieName(): string {
    return this.#cookieName;
  }

  get browserCount(): number {
    return this.#browsers.size;
  }

  /** The identity the request's cookie names, if the store remembers it and it has not expired. */
  identify(request: Request): string | undefined {
    const subject = readCookie(request, this.#cookieName);
    if (subject === undefined) return undefined;
    const browser = this.#browsers.get(subject);
    if (browser === undefined) return undefined;
    if (browser.expiresAt <= this.#now()) {
      if (this.#forgettable(browser)) this.#forget(browser);
      return undefined;
    }
    return subject;
  }

  /**
   * Remember a new browser and return the `Set-Cookie` value that gives it its identity, or say why
   * it cannot be admitted. The cookie is `HttpOnly` so no script can read it, `SameSite=Strict` so
   * no other site's request carries it, and has no `Secure` attribute only because the example
   * serves plain HTTP on loopback.
   *
   * Making room never costs another browser its session: only a browser whose slot is free is
   * forgotten, and when none is, the newcomer is refused. A flood of enrollments is slowed by a
   * rate limit before it gets that far.
   */
  enroll(): Enrollment {
    const now = this.#now();
    this.#enrollments = this.#enrollments.filter((at) => at > now - this.#enrollmentWindow);
    if (this.#enrollments.length >= this.#enrollmentsPerWindow) {
      return { ok: false, reason: 'rate-limited' };
    }
    this.#evict();
    if (this.#browsers.size >= this.#maximumBrowsers) return { ok: false, reason: 'full' };
    this.#enrollments.push(now);
    const subject = randomToken();
    this.#browsers.set(subject, {
      subject,
      expiresAt: now + this.#browserLifetime,
      slot: this.#createSlot(),
      tickets: new Map(),
    });
    const lifetime = Math.floor(this.#browserLifetime / 1000);
    return {
      ok: true,
      setCookie: `${this.#cookieName}=${subject}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime}`,
    };
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

  /** A browser can be forgotten when no session of its holds, or could still hold, a process. */
  #forgettable(browser: Browser): boolean {
    const current = browser.slot.current;
    return current === undefined || (current.snapshot.closed && !current.snapshot.quarantined);
  }

  #evict(): void {
    const now = this.#now();
    for (const browser of this.#browsers.values()) {
      if (browser.expiresAt <= now && this.#forgettable(browser)) this.#forget(browser);
    }
    for (const browser of this.#browsers.values()) {
      if (this.#browsers.size < this.#maximumBrowsers) break;
      if (this.#forgettable(browser)) this.#forget(browser);
    }
  }

  #forget(browser: Browser): void {
    this.#browsers.delete(browser.subject);
  }
}
