/**
 * COR-2260: fixture-only probes for claim-level source references in a streamed response.
 *
 * Nothing here is a production API. It feeds one response and its two sources through two
 * candidate shapes for "this claim is backed by that source" and reports what each can and cannot
 * do with the seams Chat has today (the Markdown renderer and Cinder's `Citation`):
 *
 * - structured: each completed claim arrives as `{ claimId, markdown, sourceId }`. The claim
 *   owns its own Markdown, so a marker follows it without searching or counting characters.
 * - positional: the response is one growing Markdown string and each claim is
 *   `{ endUtf16, sourceId }`, where `endUtf16` is an exclusive index into the current snapshot,
 *   measured in JavaScript string length (UTF-16 code units).
 *
 * Both reduce to the same view: ordered Markdown segments, a marker after the ones that end a
 * claim, and a footer of the sources the markers cite, in claim order.
 */

export type ClaimSourceFixtureProps = {
  /** Which candidate shape drives the view. */
  representation: 'structured' | 'positional';
};

export type ClaimSourceFixtureApi = {
  /** Feeds one event of the replay. */
  dispatch(event: ClaimStreamEvent): void;
};

export type SourceRecord = { id: string; label: string; detail?: string; url?: string };
export type StructuredClaim = { claimId: string; markdown: string; sourceId: string };
export type PositionalClaim = { endUtf16: number; sourceId: string };

export type ClaimStreamState = {
  /** Source records the evidence has delivered so far. */
  sources: readonly SourceRecord[];
  /**
   * Structured: the text streamed since the last completed claim, which is not a claim yet.
   * Positional: the whole response snapshot.
   */
  text: string;
  structured: readonly StructuredClaim[];
  positional: readonly PositionalClaim[];
};

export type ClaimStreamEvent =
  | { type: 'sources'; sources: readonly SourceRecord[] }
  | { type: 'text'; chunk: string }
  | { type: 'structured-claim'; claim: StructuredClaim }
  | { type: 'positional-claim'; claim: PositionalClaim }
  /** The response is replaced: its text, claims and sources all go before new evidence arrives. */
  | { type: 'replace'; text?: string };

export type ClaimMarker = {
  /** Identity of the claim: its `claimId`, or its position in the positional list. Never its text. */
  key: string;
  sourceId: string;
  /** One-based position of the marker's source in the footer. */
  number: number;
};

export type ClaimSegment = { markdown: string; marker?: ClaimMarker };

export type ClaimView = {
  segments: ClaimSegment[];
  /** The sources the markers cite, in the order their claims appear. */
  footer: SourceRecord[];
};

export function initialClaimStream(): ClaimStreamState {
  return { sources: [], text: '', structured: [], positional: [] };
}

export function reduceClaimStream(
  state: ClaimStreamState,
  event: ClaimStreamEvent,
): ClaimStreamState {
  switch (event.type) {
    case 'sources':
      return { ...state, sources: [...state.sources, ...event.sources] };
    case 'text':
      return { ...state, text: state.text + event.chunk };
    case 'structured-claim':
      // A completed claim supersedes the text streamed towards it. A claim id seen twice is a
      // replay, not a second claim.
      return state.structured.some((claim) => claim.claimId === event.claim.claimId)
        ? state
        : { ...state, text: '', structured: [...state.structured, event.claim] };
    case 'positional-claim':
      return { ...state, positional: [...state.positional, event.claim] };
    case 'replace':
      return { ...initialClaimStream(), text: event.text ?? '' };
  }
}

function sourceById(sources: readonly SourceRecord[], id: string): SourceRecord | undefined {
  return sources.find((source) => source.id === id);
}

/** Builds the footer and numbers each claim's marker by its source's footer position. */
function withFooter(
  sources: readonly SourceRecord[],
  entries: ReadonlyArray<{ markdown: string; key?: string; sourceId?: string }>,
): ClaimView {
  const footer: SourceRecord[] = [];
  const segments: ClaimSegment[] = [];
  for (const entry of entries) {
    const source = entry.sourceId === undefined ? undefined : sourceById(sources, entry.sourceId);
    if (source === undefined || entry.key === undefined) {
      segments.push({ markdown: entry.markdown });
      continue;
    }
    if (!footer.includes(source)) footer.push(source);
    segments.push({
      markdown: entry.markdown,
      marker: { key: entry.key, sourceId: source.id, number: footer.indexOf(source) + 1 },
    });
  }
  return { segments, footer };
}

/** Structured claims: one segment per completed claim, then the text still streaming. */
export function viewStructured(state: ClaimStreamState): ClaimView {
  return withFooter(state.sources, [
    ...state.structured.map((claim) => ({
      markdown: claim.markdown,
      key: claim.claimId,
      sourceId: claim.sourceId,
    })),
    ...(state.text === '' ? [] : [{ markdown: state.text }]),
  ]);
}

const INLINE_LINK = /!?\[[^\]\n]*\]\([^)\s]*(?:\s+"[^"]*")?\)/g;
const OPEN_LABEL = /\[[^\]\n]*$/;
const OPEN_DESTINATION = /\]\([^)\n]*$/;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Where a positional claim's marker goes in the snapshot, or `undefined` while it has no place:
 * the offset is not a whole index into this snapshot (not an integer, outside it, or between the
 * halves of a surrogate pair), or it falls inside a link that the snapshot has not finished. An
 * offset inside a finished link moves to the link's end, so a marker is never part of link text.
 */
export function markerOffset(raw: string, endUtf16: number): number | undefined {
  if (!Number.isInteger(endUtf16) || endUtf16 <= 0 || endUtf16 > raw.length) return undefined;
  if (
    endUtf16 < raw.length &&
    isHighSurrogate(raw.charCodeAt(endUtf16 - 1)) &&
    isLowSurrogate(raw.charCodeAt(endUtf16))
  ) {
    return undefined;
  }
  for (const link of raw.matchAll(INLINE_LINK)) {
    const start = link.index;
    const end = start + link[0].length;
    if (start < endUtf16 && endUtf16 < end) return end;
  }
  const before = raw.slice(0, endUtf16);
  if (OPEN_LABEL.test(before) || OPEN_DESTINATION.test(before)) return undefined;
  return endUtf16;
}

/**
 * Positional claims: the snapshot is cut at each claim's marker offset. A claim without a place
 * yet contributes no marker; its text is still in the snapshot and stays readable.
 */
export function viewPositional(state: ClaimStreamState): ClaimView {
  const raw = state.text;
  const placed = state.positional.flatMap((claim, index) => {
    const offset = markerOffset(raw, claim.endUtf16);
    return offset === undefined || sourceById(state.sources, claim.sourceId) === undefined
      ? []
      : [{ offset, index, claim }];
  });
  // Segments follow the text; the footer follows claim order, which is the order given.
  const byOffset = [...placed].sort((a, b) => a.offset - b.offset || a.index - b.index);
  const numbered = withFooter(
    state.sources,
    placed.map(({ claim, index }) => ({
      markdown: '',
      key: `positional:${index}`,
      sourceId: claim.sourceId,
    })),
  );
  const markers = new Map(
    numbered.segments.map((segment) => [segment.marker!.key, segment.marker!] as const),
  );
  const segments: ClaimSegment[] = [];
  let cursor = 0;
  for (const { offset, index } of byOffset) {
    segments.push({
      markdown: raw.slice(cursor, offset),
      marker: markers.get(`positional:${index}`)!,
    });
    cursor = offset;
  }
  if (cursor < raw.length) segments.push({ markdown: raw.slice(cursor) });
  return { segments, footer: numbered.footer };
}
