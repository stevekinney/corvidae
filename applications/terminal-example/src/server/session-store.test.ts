import { describe, expect, test } from 'bun:test';

import {
  BROWSER_LIFETIME_MILLISECONDS,
  COOKIE_NAME,
  MAXIMUM_BROWSERS,
  MAXIMUM_TICKETS,
  SessionStore,
  TICKET_LIFETIME_MILLISECONDS,
} from './session-store.ts';

function clock() {
  let now = 0;
  return {
    now: () => now,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function cookieFrom(setCookie: string): string {
  return setCookie.split(';')[0] as string;
}

function requestWith(cookie: string | undefined): Request {
  return new Request('http://127.0.0.1/', cookie === undefined ? {} : { headers: { cookie } });
}

function subjectOf(setCookie: string): string {
  return cookieFrom(setCookie).slice(COOKIE_NAME.length + 1);
}

describe('the browser cookie', () => {
  test('is HttpOnly, SameSite=Strict, scoped to the site and bounded in time', () => {
    const header = new SessionStore().enroll();
    expect(header).toStartWith(`${COOKIE_NAME}=`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Path=/');
    expect(header).toContain(`Max-Age=${BROWSER_LIFETIME_MILLISECONDS / 1000}`);
  });

  test('identifies the browser it was issued to and nobody else', () => {
    const store = new SessionStore();
    const header = store.enroll();
    expect(store.identify(requestWith(cookieFrom(header)))).toBe(subjectOf(header));
    expect(store.identify(requestWith(undefined))).toBeUndefined();
    expect(store.identify(requestWith(`${COOKIE_NAME}=forged`))).toBeUndefined();
    expect(store.identify(requestWith('other=1'))).toBeUndefined();
  });

  test('is ambiguous, and so identifies nobody, when it appears twice', () => {
    const store = new SessionStore();
    const cookie = cookieFrom(store.enroll());
    expect(store.identify(requestWith(`${cookie}; ${cookie}`))).toBeUndefined();
  });

  test('is read among other cookies', () => {
    const store = new SessionStore();
    const header = store.enroll();
    const cookie = `theme=dark; ${cookieFrom(header)}; flag`;
    expect(store.identify(requestWith(cookie))).toBe(subjectOf(header));
  });

  test('expires, and an expired one is forgotten', () => {
    const time = clock();
    const store = new SessionStore({ now: time.now });
    const cookie = cookieFrom(store.enroll());
    time.advance(BROWSER_LIFETIME_MILLISECONDS - 1);
    expect(store.identify(requestWith(cookie))).toBeDefined();
    time.advance(1);
    expect(store.identify(requestWith(cookie))).toBeUndefined();
    expect(store.browserCount).toBe(0);
  });

  test('forgets the oldest browser, never the newest, past the cap', () => {
    const store = new SessionStore();
    const first = cookieFrom(store.enroll());
    for (let index = 0; index < MAXIMUM_BROWSERS; index += 1) store.enroll();
    expect(store.browserCount).toBe(MAXIMUM_BROWSERS);
    expect(store.identify(requestWith(first))).toBeUndefined();
  });
});

describe('authenticate', () => {
  test('answers with the subject and the lifetime that remains', () => {
    const time = clock();
    const store = new SessionStore({ now: time.now });
    const header = store.enroll();
    time.advance(1000);
    expect(store.authenticate(requestWith(cookieFrom(header)))).toEqual({
      ok: true,
      subject: subjectOf(header),
      expiresInMilliseconds: BROWSER_LIFETIME_MILLISECONDS - 1000,
    });
  });

  test('denies a request without a known cookie', () => {
    expect(new SessionStore().authenticate(requestWith(undefined))).toEqual({
      ok: false,
      denial: 'unauthenticated',
    });
  });
});

describe('tickets', () => {
  function enrolled() {
    const time = clock();
    const store = new SessionStore({ now: time.now });
    const subject = subjectOf(store.enroll());
    return { time, store, subject };
  }

  test('work once, for the session and the browser they were issued to', () => {
    const { store, subject } = enrolled();
    const ticket = store.issueTicket(subject, 'session-1') as string;
    expect(store.redeemTicket(subject, 'session-2', ticket)).toBe(false);
    // A wrong-session attempt spends it: a ticket cannot be guessed against.
    expect(store.redeemTicket(subject, 'session-1', ticket)).toBe(false);
    const again = store.issueTicket(subject, 'session-1') as string;
    expect(store.redeemTicket(subject, 'session-1', again)).toBe(true);
    expect(store.redeemTicket(subject, 'session-1', again)).toBe(false);
  });

  test('do not work for another browser', () => {
    const { store, subject } = enrolled();
    const other = subjectOf(store.enroll());
    const ticket = store.issueTicket(subject, 'session-1') as string;
    expect(store.redeemTicket(other, 'session-1', ticket)).toBe(false);
  });

  test('expire', () => {
    const { time, store, subject } = enrolled();
    const ticket = store.issueTicket(subject, 'session-1') as string;
    time.advance(TICKET_LIFETIME_MILLISECONDS);
    expect(store.redeemTicket(subject, 'session-1', ticket)).toBe(false);
  });

  test('are bounded per browser, and expired ones make room', () => {
    const { time, store, subject } = enrolled();
    for (let index = 0; index < MAXIMUM_TICKETS; index += 1) {
      expect(store.issueTicket(subject, `session-${index}`)).toBeString();
    }
    expect(store.issueTicket(subject, 'one-too-many')).toBeUndefined();
    time.advance(TICKET_LIFETIME_MILLISECONDS);
    expect(store.issueTicket(subject, 'room-again')).toBeString();
  });

  test('are not issued to a browser the store does not know', () => {
    expect(new SessionStore().issueTicket('nobody', 'session-1')).toBeUndefined();
    expect(new SessionStore().redeemTicket('nobody', 'session-1', 'ticket')).toBe(false);
  });
});

describe('slots', () => {
  test('each browser has its own, and it is stable', () => {
    const store = new SessionStore();
    const first = subjectOf(store.enroll());
    const second = subjectOf(store.enroll());
    expect(store.slotFor(first)).toBe(store.slotFor(first));
    expect(store.slotFor(first)).not.toBe(store.slotFor(second));
  });

  test('a forgotten browser gets a slot nobody else holds', () => {
    const store = new SessionStore();
    expect(store.slotFor('forgotten')).not.toBe(store.slotFor('forgotten'));
  });
});
