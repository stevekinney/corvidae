import { describe, expect, it } from 'bun:test';

import { allEventsObservable, eventObservable } from '../src/event-observable';
import { TypedEventTarget } from '../src/typed-event-target';

class TestEvent extends Event {
  static readonly type = 'test' as const;
  readonly value: number;

  constructor(value: number) {
    super(TestEvent.type);
    this.value = value;
  }
}

class OtherEvent extends Event {
  static readonly type = 'other' as const;
  readonly message: string;

  constructor(message: string) {
    super(OtherEvent.type);
    this.message = message;
  }
}

type TestEventMap = { test: TestEvent; other: OtherEvent };
function createTarget(): TypedEventTarget<TestEventMap> {
  return new TypedEventTarget<TestEventMap>();
}

describe('eventObservable', () => {
  it('delivers events via subscribe(next) shorthand', () => {
    const target = createTarget();
    const received: number[] = [];

    const subscription = eventObservable(target, 'test').subscribe((event) => {
      received.push(event.value);
    });

    target.dispatchEvent(new TestEvent(1));
    target.dispatchEvent(new TestEvent(2));

    expect(received).toEqual([1, 2]);
    subscription.unsubscribe();
  });

  it('delivers events via subscribe(observer) form', () => {
    const target = createTarget();
    const received: number[] = [];

    const subscription = eventObservable(target, 'test').subscribe({
      next(event) {
        received.push(event.value);
      },
    });

    target.dispatchEvent(new TestEvent(42));
    expect(received).toEqual([42]);
    subscription.unsubscribe();
  });

  it('stops delivery after unsubscribe', () => {
    const target = createTarget();
    const received: number[] = [];

    const subscription = eventObservable(target, 'test').subscribe((event) => {
      received.push(event.value);
    });

    target.dispatchEvent(new TestEvent(1));
    subscription.unsubscribe();
    target.dispatchEvent(new TestEvent(2));

    expect(received).toEqual([1]);
  });

  it('reflects closed state on subscription', () => {
    const target = createTarget();
    const subscription = eventObservable(target, 'test').subscribe(() => {});

    expect(subscription.closed).toBe(false);
    subscription.unsubscribe();
    expect(subscription.closed).toBe(true);
  });

  it('calls complete() when signal is aborted', () => {
    const target = createTarget();
    const controller = new AbortController();
    let completed = false;

    eventObservable(target, 'test', { signal: controller.signal }).subscribe({
      complete() {
        completed = true;
      },
    });

    expect(completed).toBe(false);
    controller.abort();
    expect(completed).toBe(true);
  });

  it('completes immediately when the external signal is already aborted', () => {
    const target = createTarget();
    const controller = new AbortController();
    controller.abort();
    let completeCalls = 0;

    const subscription = eventObservable(target, 'test', { signal: controller.signal }).subscribe({
      complete() {
        completeCalls += 1;
      },
    });

    expect(subscription.closed).toBe(true);
    expect(completeCalls).toBe(1);
    subscription.unsubscribe();
    expect(completeCalls).toBe(1);
  });

  it('calls start() synchronously with the subscription', () => {
    const target = createTarget();
    let startedClosed: boolean | undefined;

    eventObservable(target, 'test').subscribe({
      start(subscription) {
        startedClosed = subscription.closed;
      },
    });

    expect(startedClosed).toBe(false);
  });

  it('supports multiple subscribers', () => {
    const target = createTarget();
    const first: number[] = [];
    const second: number[] = [];

    const observable = eventObservable(target, 'test');
    const sub1 = observable.subscribe((event) => first.push(event.value));
    const sub2 = observable.subscribe((event) => second.push(event.value));

    target.dispatchEvent(new TestEvent(7));

    expect(first).toEqual([7]);
    expect(second).toEqual([7]);

    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  it('does not emit after signal abort', () => {
    const target = createTarget();
    const controller = new AbortController();
    const received: number[] = [];

    eventObservable(target, 'test', { signal: controller.signal }).subscribe((event) => {
      received.push(event.value);
    });

    target.dispatchEvent(new TestEvent(1));
    controller.abort();
    target.dispatchEvent(new TestEvent(2));

    expect(received).toEqual([1]);
  });

  it('unsubscribe is idempotent', () => {
    const target = createTarget();
    const subscription = eventObservable(target, 'test').subscribe(() => {});

    subscription.unsubscribe();
    expect(() => subscription.unsubscribe()).not.toThrow();
    expect(subscription.closed).toBe(true);
  });

  it('works with empty observer', () => {
    const target = createTarget();
    const subscription = eventObservable(target, 'test').subscribe({});

    target.dispatchEvent(new TestEvent(1));
    expect(subscription.closed).toBe(false);

    subscription.unsubscribe();
  });

  it('works with no arguments to subscribe', () => {
    const target = createTarget();
    const subscription = eventObservable(target, 'test').subscribe();

    target.dispatchEvent(new TestEvent(1));
    expect(subscription.closed).toBe(false);

    subscription.unsubscribe();
  });

  it('calls complete() on unsubscribe', () => {
    const target = createTarget();
    let completed = false;

    const subscription = eventObservable(target, 'test').subscribe({
      complete() {
        completed = true;
      },
    });

    subscription.unsubscribe();
    expect(completed).toBe(true);
  });

  it('if start() synchronously unsubscribes, no listener is added', () => {
    const target = createTarget();
    const received: number[] = [];

    eventObservable(target, 'test').subscribe({
      start(subscription) {
        subscription.unsubscribe();
      },
      next(event) {
        received.push(event.value);
      },
    });

    target.dispatchEvent(new TestEvent(1));
    expect(received).toEqual([]);
  });
});

describe('allEventsObservable', () => {
  it('receives events of all listed types', () => {
    const target = createTarget();
    const received: string[] = [];

    const subscription = allEventsObservable(target, ['test', 'other']).subscribe((event) => {
      received.push(event.type);
    });

    target.dispatchEvent(new TestEvent(1));
    target.dispatchEvent(new OtherEvent('hello'));
    target.dispatchEvent(new TestEvent(2));

    expect(received).toEqual(['test', 'other', 'test']);
    subscription.unsubscribe();
  });

  it('stops delivery on signal abort', () => {
    const target = createTarget();
    const controller = new AbortController();
    const received: string[] = [];

    allEventsObservable(target, ['test', 'other'], {
      signal: controller.signal,
    }).subscribe((event) => {
      received.push(event.type);
    });

    target.dispatchEvent(new TestEvent(1));
    controller.abort();
    target.dispatchEvent(new OtherEvent('after'));

    expect(received).toEqual(['test']);
  });

  it('stops delivery and reflects closed after unsubscribe', () => {
    const target = createTarget();
    const received: string[] = [];

    const subscription = allEventsObservable(target, ['test']).subscribe((event) => {
      received.push(event.type);
    });

    target.dispatchEvent(new TestEvent(1));
    expect(subscription.closed).toBe(false);

    subscription.unsubscribe();
    expect(subscription.closed).toBe(true);

    target.dispatchEvent(new TestEvent(2));
    expect(received).toEqual(['test']);
  });

  it('calls complete() on signal abort', () => {
    const target = createTarget();
    const controller = new AbortController();
    let completed = false;

    allEventsObservable(target, ['test'], { signal: controller.signal }).subscribe({
      complete() {
        completed = true;
      },
    });

    controller.abort();
    expect(completed).toBe(true);
  });

  it('completes immediately when the external signal is already aborted', () => {
    const target = createTarget();
    const controller = new AbortController();
    controller.abort();
    let completeCalls = 0;

    const subscription = allEventsObservable(target, ['test'], {
      signal: controller.signal,
    }).subscribe({
      complete() {
        completeCalls += 1;
      },
    });

    expect(subscription.closed).toBe(true);
    expect(completeCalls).toBe(1);
    subscription.unsubscribe();
    expect(completeCalls).toBe(1);
  });
});
