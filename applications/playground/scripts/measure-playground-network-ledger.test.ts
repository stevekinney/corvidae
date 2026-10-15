import { describe, expect, it } from 'bun:test';

import { createNetworkLedger } from './measure-playground-network-ledger.ts';

describe('createNetworkLedger', () => {
  it('stops counting a stream torn down with its document at the next main-frame navigation', () => {
    const ledger = createNetworkLedger();
    for (let navigation = 0; navigation < 5; navigation += 1) {
      ledger.mainFrameNavigated();
      ledger.requestWillBeSent(`document-${navigation}`, 'Document');
      ledger.loadingFinished(`document-${navigation}`, 100);
      // Each document opens one live-reload stream, which Chromium never reports closed.
      ledger.requestWillBeSent(`events-${navigation}`, 'EventSource');
    }
    expect(ledger.openEventSources.size).toBe(1);
  });

  it('still counts a stream a single document leaks', () => {
    const ledger = createNetworkLedger();
    ledger.mainFrameNavigated();
    ledger.requestWillBeSent('events-a', 'EventSource');
    ledger.requestWillBeSent('events-b', 'EventSource');
    expect(ledger.openEventSources.size).toBe(2);
  });

  it('forgets a stream the document closed', () => {
    const ledger = createNetworkLedger();
    ledger.requestWillBeSent('events', 'EventSource');
    ledger.loadingFailed('events');
    expect(ledger.openEventSources.size).toBe(0);
  });

  it('tracks other requests in flight and totals requests and encoded bytes per cycle', () => {
    const ledger = createNetworkLedger();
    ledger.requestWillBeSent('script', 'Script');
    expect(ledger.inFlight.size).toBe(1);
    ledger.loadingFinished('script', 250);
    expect(ledger.inFlight.size).toBe(0);
    expect(ledger.requests).toBe(1);
    expect(ledger.encodedBytes).toBe(250);
    ledger.resetTotals();
    expect([ledger.requests, ledger.encodedBytes]).toEqual([0, 0]);
  });
});
