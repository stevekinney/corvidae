import { describe, expect, test } from 'bun:test';

import type { SessionSlot } from '@lostgradient/ventriloquist';

import {
  BROWSER_LIFETIME_MILLISECONDS,
  COOKIE_NAME,
  ENROLLMENTS_PER_WINDOW,
  ENROLLMENT_WINDOW_MILLISECONDS,
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

function enroll(store: SessionStore): string {
  const enrollment = store.enroll();
  if (!enrollment.ok) throw new Error(`enrollment refused: ${enrollment.reason}`);
  return enrollment.setCookie;
}

function subjectOf(setCookie: string): string {
  return cookieFrom(setCookie).split('=')[1] as string;
}

describe('the browser cookie', () => {
  test('is HttpOnly, SameSite=Strict, scoped to the site and bounded in time', () => {
    const header = enroll(new SessionStore());
    expect(header).toStartWith(`${COOKIE_NAME}=`);
    expect(new SessionStore({ cookieName: 'terminal-example-session-54240' }).cookieName).toBe(
      'terminal-example-session-54240',
    );
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Path=/');
    expect(header).toContain(`Max-Age=${BROWSER_LIFETIME_MILLISECONDS / 1000}`);
  });

  test('identifies the browser it was issued to and nobody else', () => {
    const store = new SessionStore();
    const header = enroll(store);
    expect(store.identify(requestWith(cookieFrom(header)))).toBe(subjectOf(header));
    expect(store.identify(requestWith(undefined))).toBeUndefined();
    expect(store.identify(requestWith(`${COOKIE_NAME}=forged`))).toBeUndefined();
    expect(store.identify(requestWith('other=1'))).toBeUndefined();
  });

  test('is ambiguous, and so identifies nobody, when it appears twice', () => {
    const store = new SessionStore();
    const cookie = cookieFrom(enroll(store));
    expect(store.identify(requestWith(`${cookie}; ${cookie}`))).toBeUndefined();
  });

  test('is read among other cookies', () => {
    const store = new SessionStore();
    const header = enroll(store);
    const cookie = `theme=dark; ${cookieFrom(header)}; flag`;
    expect(store.identify(requestWith(cookie))).toBe(subjectOf(header));
  });

  test('expires, and an expired one is forgotten', () => {
    const time = clock();
    const store = new SessionStore({ now: time.now });
    const cookie = cookieFrom(enroll(store));
    time.advance(BROWSER_LIFETIME_MILLISECONDS - 1);
    expect(store.identify(requestWith(cookie))).toBeDefined();
    time.advance(1);
    expect(store.identify(requestWith(cookie))).toBeUndefined();
    expect(store.browserCount).toBe(0);
  });

  test('is scoped to the port, so two instances do not clobber each other', () => {
    const first = new SessionStore({ cookieName: 'terminal-example-session-54240' });
    const second = new SessionStore({ cookieName: 'terminal-example-session-54241' });
    const cookie = cookieFrom(enroll(first));
    expect(cookie).toStartWith('terminal-example-session-54240=');
    expect(first.identify(requestWith(cookie))).toBeDefined();
    // The other instance's cookie is a different name, so each keeps its own beside the other.
    expect(second.identify(requestWith(cookie))).toBeUndefined();
    const both = `${cookie}; ${cookieFrom(enroll(second))}`;
    expect(first.identify(requestWith(both))).toBeDefined();
    expect(second.identify(requestWith(both))).toBeDefined();
  });
});

/** A slot stand-in whose session is in the state a test names. */
function fakeSlot(state: 'none' | 'open' | 'closed' | 'quarantined'): SessionSlot {
  const current =
    state === 'none'
      ? undefined
      : {
          snapshot: {
            closed: state === 'closed' || state === 'quarantined',
            quarantined: state === 'quarantined',
          },
          closed: Promise.resolve(),
        };
  return { current } as unknown as SessionSlot;
}

describe('the cap on browsers', () => {
  const CAP = 3;

  function fullStore(states: ('open' | 'closed' | 'quarantined')[]) {
    const time = clock();
    const slots = [...states];
    const store = new SessionStore({
      now: time.now,
      maximumBrowsers: CAP,
      enrollmentsPerWindow: 1000,
      createSlot: () => fakeSlot(slots.shift() ?? 'none'),
    });
    const cookies = states.map(() => cookieFrom(enroll(store)));
    return { store, time, cookies };
  }

  test('evicts the oldest browser whose slot is closed', () => {
    const { store, cookies } = fullStore(['closed', 'closed', 'closed']);
    enroll(store);
    expect(store.identify(requestWith(cookies[0]))).toBeUndefined();
    expect(store.identify(requestWith(cookies[1]))).toBeDefined();
    expect(store.browserCount).toBe(CAP);
  });

  test('never evicts a browser whose slot is occupied: the newcomer is refused instead', () => {
    const { store, cookies } = fullStore(['open', 'open', 'open']);
    expect(store.enroll()).toEqual({ ok: false, reason: 'full' });
    for (const cookie of cookies) expect(store.identify(requestWith(cookie))).toBeDefined();
  });

  test('never evicts a quarantined slot, which only a restart may clear', () => {
    const { store, cookies } = fullStore(['quarantined', 'open', 'open']);
    expect(store.enroll()).toEqual({ ok: false, reason: 'full' });
    expect(store.identify(requestWith(cookies[0]))).toBeDefined();
  });

  test('skips an occupied browser and evicts the oldest one that is not', () => {
    const { store, cookies } = fullStore(['open', 'quarantined', 'closed']);
    enroll(store);
    expect(store.identify(requestWith(cookies[0]))).toBeDefined();
    expect(store.identify(requestWith(cookies[1]))).toBeDefined();
    expect(store.identify(requestWith(cookies[2]))).toBeUndefined();
  });

  test('forgets an expired browser only when its slot is not occupied', () => {
    const time = clock();
    const states: ('open' | 'closed')[] = ['open', 'closed'];
    const store = new SessionStore({
      now: time.now,
      maximumBrowsers: 2,
      enrollmentsPerWindow: 1000,
      browserLifetimeMilliseconds: 1000,
      createSlot: () => fakeSlot(states.shift() ?? 'none'),
    });
    const occupied = cookieFrom(enroll(store));
    enroll(store);
    time.advance(5000);
    enroll(store);
    // The expired browser with a live session is still counted, so the store is not emptied around it.
    expect(store.browserCount).toBe(2);
    expect(store.identify(requestWith(occupied))).toBeUndefined();
  });
});

describe('the enrollment rate', () => {
  test('admits a bounded number per window and then refuses until it passes', () => {
    const time = clock();
    const store = new SessionStore({ now: time.now, maximumBrowsers: 1000 });
    for (let index = 0; index < ENROLLMENTS_PER_WINDOW; index += 1) {
      expect(store.enroll().ok).toBe(true);
    }
    expect(store.enroll()).toEqual({ ok: false, reason: 'rate-limited' });
    time.advance(ENROLLMENT_WINDOW_MILLISECONDS);
    expect(store.enroll().ok).toBe(true);
  });
});

describe('authenticate', () => {
  test('answers with the subject and the lifetime that remains', () => {
    const time = clock();
    const store = new SessionStore({ now: time.now });
    const header = enroll(store);
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
    const subject = subjectOf(enroll(store));
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
    const other = subjectOf(enroll(store));
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
    const first = subjectOf(enroll(store));
    const second = subjectOf(enroll(store));
    expect(store.slotFor(first)).toBe(store.slotFor(first));
    expect(store.slotFor(first)).not.toBe(store.slotFor(second));
  });

  test('a forgotten browser gets a slot nobody else holds', () => {
    const store = new SessionStore();
    expect(store.slotFor('forgotten')).not.toBe(store.slotFor('forgotten'));
  });
});
