/**
 * COR-2260: replays one streamed response, two claims and two sources through both candidate
 * shapes for claim-level source references (see `claim-source-fixture.ts`), and records what each
 * one can and cannot do with Chat's Markdown renderer and Cinder's `Citation`.
 *
 * Each `describe.each` row runs against the structured and the positional shape. A check a shape
 * cannot meet is kept as a passing test under "known limitations" that asserts the exact
 * limitation, so the results matrix in the pull request can name it and a later change that fixes
 * it turns the test red on purpose.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import {
  markerOffset,
  type ClaimSourceFixtureApi,
  type ClaimSourceFixtureProps,
  type ClaimStreamEvent,
  type SourceRecord,
} from './claim-source-fixture.ts';

setupHappyDom();

mock.module('@floating-ui/dom', () => ({
  arrow: () => ({ name: 'arrow', fn: () => ({}) }),
  autoUpdate: (_anchor: unknown, _panel: HTMLElement, update: () => void) => {
    update();
    return () => {};
  },
  computePosition: async (
    _anchor: unknown,
    _panel: HTMLElement,
    options: { placement: string },
  ) => ({
    x: 0,
    y: 0,
    placement: options.placement,
    middlewareData: {},
  }),
  flip: () => ({ name: 'flip', fn: () => ({}) }),
  offset: () => ({ name: 'offset', fn: () => ({}) }),
  shift: () => ({ name: 'shift', fn: () => ({}) }),
  size: () => ({ name: 'size', fn: () => ({}) }),
}));

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { tick } = await import('svelte');
const { default: ClaimSourceFixture } = await import('./claim-source-fixture.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

type Representation = ClaimSourceFixtureProps['representation'];

const SOURCE_A: SourceRecord = {
  id: 'source-a',
  label: 'Annual report',
  detail: 'Page 4',
  url: 'https://example.test/annual-report',
};
const SOURCE_B: SourceRecord = { id: 'source-b', label: 'Investor call', detail: 'Transcript' };
const CLAIM_A = 'Revenue grew 12% in 2025.';
const CLAIM_B = 'Margins held at 31% for the year.';

type ClaimInput = { text: string; sourceId: string; claimId?: string };

/**
 * The events that deliver `claims` in `chunkSize`-character pieces, with each claim's evidence
 * arriving the moment its last piece has. Both shapes receive the same text in the same chunks.
 */
function replay(
  representation: Representation,
  claims: readonly ClaimInput[],
  chunkSize = 7,
): ClaimStreamEvent[] {
  const events: ClaimStreamEvent[] = [];
  let length = 0;
  for (const [index, claim] of claims.entries()) {
    const text = index === 0 ? claim.text : ` ${claim.text}`;
    for (let start = 0; start < text.length; start += chunkSize) {
      events.push({ type: 'text', chunk: text.slice(start, start + chunkSize) });
    }
    length += text.length;
    events.push(
      representation === 'structured'
        ? {
            type: 'structured-claim',
            claim: {
              claimId: claim.claimId ?? `claim-${String.fromCharCode(97 + index)}`,
              markdown: claim.text,
              sourceId: claim.sourceId,
            },
          }
        : { type: 'positional-claim', claim: { endUtf16: length, sourceId: claim.sourceId } },
    );
  }
  return events;
}

async function mount(representation: Representation) {
  const { container, component } = render(ClaimSourceFixture, { props: { representation } });
  const api = component as unknown as ClaimSourceFixtureApi;
  const root = container;
  return {
    root,
    async dispatch(...events: ClaimStreamEvent[]): Promise<void> {
      for (const event of events) api.dispatch(event);
      await tick();
    },
  };
}

function markers(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>('.claim-source-body .cinder-citation__marker'),
  );
}

function footerButtons(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>('.claim-source-footer .cinder-citation__marker'),
  );
}

function bodyText(root: HTMLElement): string {
  return root.querySelector('.claim-source-body')?.textContent ?? '';
}

function openPreview(): HTMLElement | null {
  return document.querySelector<HTMLElement>('section[aria-label]');
}

async function open(button: HTMLButtonElement): Promise<HTMLElement> {
  await fireEvent.click(button);
  await waitFor(() => expect(openPreview()?.outerHTML ?? null).not.toBeNull());
  return openPreview()!;
}

async function pressEscape(): Promise<void> {
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => expect(openPreview()?.outerHTML ?? null).toBeNull());
}

const REPRESENTATIONS: Representation[] = ['structured', 'positional'];

describe.each(REPRESENTATIONS)('claim source references (%s)', (representation) => {
  const both: ClaimInput[] = [
    { text: CLAIM_A, sourceId: 'source-a' },
    { text: CLAIM_B, sourceId: 'source-b' },
  ];

  async function mountBoth() {
    const view = await mount(representation);
    await view.dispatch(
      { type: 'sources', sources: [SOURCE_A, SOURCE_B] },
      ...replay(representation, both),
    );
    return view;
  }

  test('maps claim-a to source-a and claim-b to source-b, in that order in the footer', async () => {
    const { root } = await mountBoth();

    expect(markers(root).map((marker) => marker.getAttribute('aria-label'))).toEqual([
      'Annual report (1)',
      'Investor call (1)',
    ]);
    expect(root.querySelectorAll('[data-claim-marker]')).toHaveLength(2);
    expect(
      Array.from(root.querySelectorAll('[data-source-entry]'), (entry) =>
        entry.getAttribute('data-source-entry'),
      ),
    ).toEqual(['source-a', 'source-b']);
    expect(footerButtons(root).map((button) => button.textContent)).toEqual([
      'Annual report',
      'Investor call',
    ]);
    // Both claims stay readable, and the marker numbers are generated content, not text.
    expect(bodyText(root)).toContain(CLAIM_A);
    expect(bodyText(root)).toContain(CLAIM_B);
    expect(bodyText(root)).not.toMatch(/\[\d\]/);
  });

  test('each marker and each footer entry opens its own source, and Escape restores focus', async () => {
    const { root } = await mountBoth();

    for (const [group, buttons] of [
      ['marker', markers(root)],
      ['footer entry', footerButtons(root)],
    ] as const) {
      for (const [index, button] of buttons.entries()) {
        const source = index === 0 ? SOURCE_A : SOURCE_B;
        const preview = await open(button);
        expect(preview.getAttribute('aria-label'), `${group} ${index}`).toBe(source.label);
        expect(preview.querySelector('strong')?.textContent).toBe(source.label);
        expect(preview.textContent).toContain(source.detail!);
        expect(preview.querySelector('a')?.getAttribute('href') ?? null).toBe(source.url ?? null);
        await pressEscape();
        await waitFor(() => expect(document.activeElement === button).toBe(true));
      }
    }
  });

  test('a missing or invalid target keeps the claim readable without a broken control', async () => {
    const { root, dispatch } = await mount(representation);
    await dispatch(
      { type: 'sources', sources: [SOURCE_A] },
      ...replay(representation, [{ text: CLAIM_A, sourceId: 'source-missing' }]),
    );
    expect(markers(root)).toHaveLength(0);
    expect(footerButtons(root)).toHaveLength(0);
    expect(root.querySelector('.claim-source-footer')).toBeNull();
    expect(bodyText(root)).toContain(CLAIM_A);
  });

  test('a source with an unsafe or absent URL opens a preview with no link', async () => {
    const unsafe: SourceRecord = { id: 'unsafe', label: 'Unsafe', url: 'javascript:alert(1)' };
    const textOnly: SourceRecord = { id: 'text-only', label: 'Text only', detail: 'No link' };
    const { root, dispatch } = await mount(representation);
    await dispatch(
      { type: 'sources', sources: [unsafe, textOnly] },
      ...replay(representation, [
        { text: CLAIM_A, sourceId: 'unsafe' },
        { text: CLAIM_B, sourceId: 'text-only' },
      ]),
    );
    for (const button of markers(root)) {
      const preview = await open(button);
      expect(preview.querySelector('a')).toBeNull();
      await pressEscape();
    }
  });

  test('opening a preview starts no request', async () => {
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => {
      requests.push(String(input));
      return Promise.reject(new Error('The fixture must not fetch.'));
    }) as typeof fetch;
    try {
      const { root } = await mountBoth();
      const preview = await open(markers(root)[0]!);
      expect(preview.querySelector('img, iframe, script, link, video, audio, object')).toBeNull();
      await pressEscape();
      await open(footerButtons(root)[1]!);
      expect(requests).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('shows no marker until its claim boundary is complete, then exactly one', async () => {
    const { root, dispatch } = await mount(representation);
    await dispatch({ type: 'sources', sources: [SOURCE_A, SOURCE_B] });
    const events = replay(representation, both);
    const counts: number[] = [];
    for (const event of events) {
      await dispatch(event);
      counts.push(markers(root).length);
    }
    // Each claim's marker appears with its evidence event and never before it.
    const firstEvidence = events.findIndex((event) => event.type !== 'text');
    expect(counts.slice(0, firstEvidence)).toEqual(Array(firstEvidence).fill(0));
    expect(counts.at(-1)).toBe(2);
    expect(Math.max(...counts)).toBe(2);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  test('evidence that arrives before its text adds no marker until the snapshot reaches it', async () => {
    const { root, dispatch } = await mount(representation);
    await dispatch({ type: 'sources', sources: [SOURCE_A] });
    // Structured claims are complete by definition. Positional evidence can lead its text.
    if (representation === 'positional') {
      await dispatch({
        type: 'positional-claim',
        claim: { endUtf16: CLAIM_A.length, sourceId: 'source-a' },
      });
      await dispatch({ type: 'text', chunk: CLAIM_A.slice(0, 10) });
      expect(markers(root)).toHaveLength(0);
      await dispatch({ type: 'text', chunk: CLAIM_A.slice(10) });
      expect(markers(root)).toHaveLength(1);
    } else {
      await dispatch({ type: 'text', chunk: CLAIM_A });
      expect(markers(root)).toHaveLength(0);
      await dispatch({
        type: 'structured-claim',
        claim: { claimId: 'claim-a', markdown: CLAIM_A, sourceId: 'source-a' },
      });
      expect(markers(root)).toHaveLength(1);
    }
  });

  test('a replayed claim is not a second claim', async () => {
    const { root, dispatch } = await mount(representation);
    await dispatch({ type: 'sources', sources: [SOURCE_A] });
    const events = replay(representation, [{ text: CLAIM_A, sourceId: 'source-a' }]);
    await dispatch(...events);
    // Structured claims carry an id. A positional claim has none, so this is the shape's limit.
    await dispatch(events.at(-1)!);
    expect(markers(root)).toHaveLength(representation === 'structured' ? 1 : 2);
  });

  test('two occurrences of the same claim text cite their own sources', async () => {
    const { root, dispatch } = await mount(representation);
    await dispatch(
      { type: 'sources', sources: [SOURCE_A, SOURCE_B] },
      ...replay(representation, [
        { text: CLAIM_A, sourceId: 'source-a' },
        { text: CLAIM_A, sourceId: 'source-b' },
      ]),
    );
    const found = markers(root);
    expect(found).toHaveLength(2);
    expect(bodyText(root).split(CLAIM_A)).toHaveLength(3);
    const previews: string[] = [];
    for (const marker of found) {
      const preview = await open(marker);
      previews.push(preview.getAttribute('aria-label')!);
      await pressEscape();
    }
    expect(previews).toEqual(['Annual report', 'Investor call']);
  });

  test('puts no marker inside a Markdown link, whichever claim ends in or after it', async () => {
    const linked = 'Revenue grew [per the filing](https://example.test/filing)';
    const { root, dispatch } = await mount(representation);
    await dispatch({ type: 'sources', sources: [SOURCE_A, SOURCE_B] });
    if (representation === 'positional') {
      // The offsets fall inside the link: after "per the" and in the middle of the URL.
      const text = `${linked}. ${CLAIM_B}`;
      await dispatch({ type: 'text', chunk: text });
      await dispatch(
        {
          type: 'positional-claim',
          claim: { endUtf16: linked.indexOf('the filing') + 3, sourceId: 'source-a' },
        },
        {
          type: 'positional-claim',
          claim: { endUtf16: text.indexOf('example') + 4, sourceId: 'source-b' },
        },
      );
    } else {
      await dispatch(
        {
          type: 'structured-claim',
          claim: { claimId: 'a', markdown: linked, sourceId: 'source-a' },
        },
        {
          type: 'structured-claim',
          claim: {
            claimId: 'b',
            markdown: `${CLAIM_B} [more](https://example.test/more)`,
            sourceId: 'source-b',
          },
        },
      );
    }
    expect(markers(root)).toHaveLength(2);
    expect(root.querySelectorAll('a').length).toBeGreaterThan(0);
    for (const marker of markers(root)) expect(marker.closest('a')).toBeNull();
    for (const link of root.querySelectorAll('.claim-source-body a')) {
      expect(link.querySelector('[data-claim-marker], .cinder-citation')).toBeNull();
    }
    // The link still reads whole.
    expect(root.querySelector('.claim-source-body a')?.textContent).toBe('per the filing');
  });

  test('replacing the response removes every marker and footer entry before new evidence', async () => {
    const { root, dispatch } = await mountBoth();
    expect(markers(root)).toHaveLength(2);
    await open(markers(root)[0]!);

    await dispatch({ type: 'replace', text: 'A different answer.' });
    expect(markers(root)).toHaveLength(0);
    expect(footerButtons(root)).toHaveLength(0);
    expect(root.querySelector('[data-source-entry], .claim-source-footer')).toBeNull();
    expect(bodyText(root)).toContain('A different answer.');
    expect(bodyText(root)).not.toContain(CLAIM_A);

    // Old sources are gone too: evidence naming one finds nothing to cite.
    await dispatch(...replay(representation, [{ text: 'Late evidence.', sourceId: 'source-a' }]));
    expect(markers(root)).toHaveLength(0);

    const fresh: SourceRecord = { id: 'source-c', label: 'New source' };
    await dispatch(
      { type: 'replace' },
      { type: 'sources', sources: [fresh] },
      ...replay(representation, [{ text: 'Fresh claim.', sourceId: 'source-c' }]),
    );
    expect(markers(root).map((marker) => marker.getAttribute('aria-label'))).toEqual([
      'New source (1)',
    ]);
    expect(footerButtons(root).map((button) => button.textContent)).toEqual(['New source']);
  });
});

describe('positional offsets', () => {
  const text = 'Alpha beta. Gamma 😀 delta.';
  const afterEmoji = text.indexOf('😀') + 2;

  test('are exclusive UTF-16 indexes into the current snapshot', () => {
    expect(markerOffset(text, 'Alpha beta.'.length)).toBe(11);
    expect(markerOffset(text, text.length)).toBe(text.length);
    expect(afterEmoji - text.indexOf('😀')).toBe(2);
    expect(markerOffset(text, afterEmoji)).toBe(afterEmoji);
  });

  test.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 2.5],
    ['not a number', Number.NaN],
    ['past the snapshot', text.length + 1],
    ['between the halves of a surrogate pair', text.indexOf('😀') + 1],
  ])('place no marker at an offset that is %s', (_name, offset) => {
    expect(markerOffset(text, offset)).toBeUndefined();
  });

  test('inside a finished link move to its end; inside an unfinished one they wait', () => {
    const raw = 'See [the filing](https://example.test/f) now.';
    const end = raw.indexOf(')') + 1;
    expect(markerOffset(raw, 8)).toBe(end);
    expect(markerOffset(raw, raw.indexOf('example'))).toBe(end);
    expect(markerOffset('See [the fil', 8)).toBeUndefined();
    expect(markerOffset('See [the filing](https://exa', 24)).toBeUndefined();
  });
});

describe('known limitations of these seams', () => {
  const rendered = async (representation: Representation, events: ClaimStreamEvent[]) => {
    const view = await mount(representation);
    await view.dispatch({ type: 'sources', sources: [SOURCE_A, SOURCE_B] }, ...events);
    return view;
  };

  test('positional: a boundary inside emphasis splits it, so its asterisks show as text', async () => {
    const raw = 'Margins were **very strong** this year.';
    const { root } = await rendered('positional', [
      { type: 'text', chunk: raw },
      {
        type: 'positional-claim',
        claim: { endUtf16: raw.indexOf('strong'), sourceId: 'source-a' },
      },
    ]);
    expect(markers(root)).toHaveLength(1);
    expect(root.querySelector('strong')).toBeNull();
    expect(bodyText(root)).toContain('**very');
    expect(bodyText(root)).toContain('strong**');
  });

  test('positional: a literal open bracket holds every later marker, because it may become a link', async () => {
    const raw = 'Index a[0 is first. Index b is second.';
    const { root } = await rendered('positional', [
      { type: 'text', chunk: raw },
      { type: 'positional-claim', claim: { endUtf16: raw.length, sourceId: 'source-a' } },
    ]);
    expect(markers(root)).toHaveLength(0);
    expect(bodyText(root)).toContain('Index b is second.');
  });

  test('positional: two claims at one offset get two markers; nothing says they are one claim', async () => {
    const { root } = await rendered('positional', [
      { type: 'text', chunk: CLAIM_A },
      { type: 'positional-claim', claim: { endUtf16: CLAIM_A.length, sourceId: 'source-a' } },
      { type: 'positional-claim', claim: { endUtf16: CLAIM_A.length, sourceId: 'source-b' } },
    ]);
    expect(markers(root)).toHaveLength(2);
  });

  test('structured: claims that are list items render as separate lists', async () => {
    const { root } = await rendered('structured', [
      {
        type: 'structured-claim',
        claim: { claimId: 'a', markdown: '- first item', sourceId: 'source-a' },
      },
      {
        type: 'structured-claim',
        claim: { claimId: 'b', markdown: '- second item', sourceId: 'source-b' },
      },
    ]);
    expect(markers(root)).toHaveLength(2);
    expect(root.querySelectorAll('.claim-source-body ul')).toHaveLength(2);
  });

  test('structured: only completed claims get markers, so text streamed towards one carries none', async () => {
    const { root } = await rendered('structured', [{ type: 'text', chunk: CLAIM_A }]);
    expect(markers(root)).toHaveLength(0);
    expect(bodyText(root)).toContain(CLAIM_A);
  });
});
