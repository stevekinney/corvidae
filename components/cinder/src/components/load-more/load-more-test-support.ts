/// <reference lib="dom" />
import { afterEach, beforeEach } from 'bun:test';

import { requiredValue } from '@corvidae/testing';

export type ObserverRecord = {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
  observeCalls: Element[];
  disconnectCalls: number;
  observer: FakeIntersectionObserver;
};

export class FakeIntersectionObserver implements IntersectionObserver {
  static records: ObserverRecord[] = [];

  readonly root: Element | null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[];
  private readonly record: ObserverRecord;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.root = options?.root instanceof Element ? options.root : null;
    this.rootMargin = options?.rootMargin ?? '';
    const threshold = options?.threshold ?? 0;
    this.thresholds = Array.isArray(threshold) ? threshold : [threshold];
    this.record = {
      callback,
      options,
      observeCalls: [],
      disconnectCalls: 0,
      observer: this,
    };
    FakeIntersectionObserver.records.push(this.record);
  }

  observe(target: Element) {
    this.record.observeCalls.push(target);
  }

  disconnect() {
    this.record.disconnectCalls += 1;
  }

  unobserve() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

const originalIntersectionObserver = globalThis.IntersectionObserver;

export function createEntry(target: Element, isIntersecting: boolean): IntersectionObserverEntry {
  return {
    boundingClientRect: new DOMRectReadOnly(0, 0, 1, 1),
    intersectionRatio: isIntersecting ? 1 : 0,
    intersectionRect: isIntersecting
      ? new DOMRectReadOnly(0, 0, 1, 1)
      : new DOMRectReadOnly(0, 0, 0, 0),
    isIntersecting,
    rootBounds: null,
    target,
    time: Date.now(),
  };
}

export function observerRecord(index = 0): ObserverRecord {
  return requiredValue(FakeIntersectionObserver.records.at(index));
}

export function setupLoadMoreTests(cleanup: () => void): void {
  beforeEach(() => {
    FakeIntersectionObserver.records = [];
    globalThis.IntersectionObserver = FakeIntersectionObserver;
  });

  afterEach(() => {
    cleanup();
    globalThis.IntersectionObserver = originalIntersectionObserver;
  });
}
