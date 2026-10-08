/// <reference lib="dom" />
import { describe, expect, it } from 'bun:test';

import { readAdvertisedLiveReloadUrl } from './live-reload-advertisement.ts';

function documentWith(head: string): Document {
  const document = window.document.implementation.createHTMLDocument('page');
  document.head.innerHTML = head;
  return document;
}

describe('readAdvertisedLiveReloadUrl', () => {
  it('returns the stream address a live dev server advertised', () => {
    expect(
      readAdvertisedLiveReloadUrl(
        documentWith('<meta name="cinder-live-reload" content="/events" />'),
      ),
    ).toBe('/events');
  });

  it('returns null for a page rendered without a live server, as every exported page is', () => {
    expect(
      readAdvertisedLiveReloadUrl(
        documentWith('<meta name="viewport" content="width=device-width" />'),
      ),
    ).toBeNull();
  });

  it('returns null for an empty address', () => {
    expect(
      readAdvertisedLiveReloadUrl(documentWith('<meta name="cinder-live-reload" content="" />')),
    ).toBeNull();
  });
});
