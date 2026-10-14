/**
 * Request bookkeeping for the navigation probe (CIN-585), fed by CDP `Network` and `Page` events.
 *
 * Chromium reports neither `loadingFinished` nor `loadingFailed` for an EventSource stream that is
 * torn down with its document, so counting opens minus closes grows by one per navigation however
 * the page behaves. A main-frame navigation commit ends every stream the previous document owned,
 * so the ledger forgets them there. What remains counts only the streams the current document
 * holds open, which is the retention a page could leak.
 */
export type NetworkLedger = {
  requests: number;
  encodedBytes: number;
  /** Non-EventSource requests still in flight. */
  inFlight: ReadonlySet<string>;
  /** EventSource streams the current document opened and has not closed. */
  openEventSources: ReadonlySet<string>;
  requestWillBeSent: (requestId: string, type: string | undefined) => void;
  loadingFinished: (requestId: string, encodedDataLength: number) => void;
  loadingFailed: (requestId: string) => void;
  /** A main-frame navigation committed: the previous document's streams are gone. */
  mainFrameNavigated: () => void;
  /** Start a new cycle's request and byte totals. */
  resetTotals: () => void;
};

export function createNetworkLedger(): NetworkLedger {
  const inFlight = new Set<string>();
  const openEventSources = new Set<string>();
  const ledger: NetworkLedger = {
    requests: 0,
    encodedBytes: 0,
    inFlight,
    openEventSources,
    requestWillBeSent(requestId, type) {
      ledger.requests += 1;
      if (type === 'EventSource') openEventSources.add(requestId);
      else inFlight.add(requestId);
    },
    loadingFinished(requestId, encodedDataLength) {
      ledger.encodedBytes += encodedDataLength;
      inFlight.delete(requestId);
      openEventSources.delete(requestId);
    },
    loadingFailed(requestId) {
      inFlight.delete(requestId);
      openEventSources.delete(requestId);
    },
    mainFrameNavigated() {
      openEventSources.clear();
    },
    resetTotals() {
      ledger.requests = 0;
      ledger.encodedBytes = 0;
    },
  };
  return ledger;
}
