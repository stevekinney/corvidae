export type CompetitorInterval = { assertionAt: string; finishedAt: string };

export function qualificationMode(
  request: string,
  revision: string,
): 'full' | 'competition-only' | undefined {
  if (!/^[a-f0-9]{40}$/.test(revision)) return undefined;
  if (request === `COR-2653-qualification:${revision}`) return 'full';
  if (request === `COR-2653-qualification:${revision}:competition`) return 'competition-only';
  return undefined;
}

/** Pair the reporter's first assertion and end for each independently completed browser case. */
export function competitorIntervals(output: string): CompetitorInterval[] {
  const intervals: CompetitorInterval[] = [];
  let assertionAt: string | undefined;
  for (const match of output.matchAll(
    /COR2653_(ASSERTION|TEST_END) (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)(?: (\w+))?/g,
  )) {
    if (match[1] === 'ASSERTION') assertionAt = match[2];
    else {
      if (assertionAt !== undefined && match[2] !== undefined && match[3] === 'passed') {
        intervals.push({ assertionAt, finishedAt: match[2] });
      }
      assertionAt = undefined;
    }
  }
  return intervals;
}

/** A competitor must have reached a real assertion and still be running at this assertion. */
export function assertionOverlapsCompetitor(
  assertionAt: string | undefined,
  competitors: readonly CompetitorInterval[],
): boolean {
  if (assertionAt === undefined) return false;
  const assertion = Date.parse(assertionAt);
  if (!Number.isFinite(assertion)) return false;
  return competitors.some(({ assertionAt: start, finishedAt: end }) => {
    const first = Date.parse(start);
    const last = Date.parse(end);
    return (
      Number.isFinite(first) && Number.isFinite(last) && first <= assertion && assertion < last
    );
  });
}
