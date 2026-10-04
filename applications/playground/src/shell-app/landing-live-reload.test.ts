/// <reference lib="dom" />
import { afterEach, describe, expect, it } from 'bun:test';

import { attachLandingLiveReload } from './landing-live-reload.ts';

/** An `EventSource` that records what the page asked of it and lets a test deliver server events. */
class RecordingEventSource {
  static instances: RecordingEventSource[] = [];
  readonly listeners = new Map<string, () => void>();
  closed = false;

  constructor(readonly url: string) {
    RecordingEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }

  close(): void {
    this.closed = true;
  }

  dispatch(name: string): void {
    this.listeners.get(name)?.();
  }
}

const originalEventSource = Reflect.get(globalThis, 'EventSource') as unknown;

function installEventSource(): void {
  RecordingEventSource.instances = [];
  Reflect.set(globalThis, 'EventSource', RecordingEventSource);
}

function documentWith(head: string): Document {
  const document = window.document.implementation.createHTMLDocument('landing');
  document.head.innerHTML = head;
  return document;
}

afterEach(() => {
  if (originalEventSource === undefined) Reflect.deleteProperty(globalThis, 'EventSource');
  else Reflect.set(globalThis, 'EventSource', originalEventSource);
});

describe('attachLandingLiveReload', () => {
  it('subscribes to the stream the server advertised, before the shell hydrates', () => {
    installEventSource();

    const liveReload = attachLandingLiveReload(
      documentWith('<meta name="cinder-live-reload" content="/events" />'),
      () => {},
    );

    expect(liveReload).not.toBeNull();
    expect(RecordingEventSource.instances.map((source) => source.url)).toEqual(['/events']);
    const [source] = RecordingEventSource.instances;
    expect([...source!.listeners.keys()].toSorted()).toEqual(['reload', 'shell-reload']);
  });

  it('reloads the page on either event the dev server sends, and only once', () => {
    installEventSource();
    let reloads = 0;
    attachLandingLiveReload(
      documentWith('<meta name="cinder-live-reload" content="/events" />'),
      () => {
        reloads += 1;
      },
    );
    const [source] = RecordingEventSource.instances;

    source!.dispatch('reload');
    source!.dispatch('shell-reload');
    source!.dispatch('reload');

    // The first reload tears the page down; a burst of events behind it must not queue more.
    expect(reloads).toBe(1);
  });

  it('reloads for a shell-reload on its own', () => {
    installEventSource();
    let reloads = 0;
    attachLandingLiveReload(
      documentWith('<meta name="cinder-live-reload" content="/events" />'),
      () => {
        reloads += 1;
      },
    );

    RecordingEventSource.instances[0]!.dispatch('shell-reload');

    expect(reloads).toBe(1);
  });

  it('opens nothing on a page the server did not advertise a stream for', () => {
    installEventSource();

    expect(attachLandingLiveReload(documentWith(''), () => {})).toBeNull();
    expect(RecordingEventSource.instances).toEqual([]);
  });

  it('opens nothing when the advertised address is empty', () => {
    installEventSource();

    expect(
      attachLandingLiveReload(
        documentWith('<meta name="cinder-live-reload" content="" />'),
        () => {},
      ),
    ).toBeNull();
    expect(RecordingEventSource.instances).toEqual([]);
  });

  it('closes its stream when asked, so the hydrated page is the only subscriber', () => {
    installEventSource();
    const liveReload = attachLandingLiveReload(
      documentWith('<meta name="cinder-live-reload" content="/events" />'),
      () => {},
    );

    liveReload!.close();

    expect(RecordingEventSource.instances[0]!.closed).toBe(true);
  });

  it('does nothing and does not throw where EventSource does not exist', () => {
    Reflect.deleteProperty(globalThis, 'EventSource');

    expect(
      attachLandingLiveReload(
        documentWith('<meta name="cinder-live-reload" content="/events" />'),
        () => {},
      ),
    ).toBeNull();
  });
});
