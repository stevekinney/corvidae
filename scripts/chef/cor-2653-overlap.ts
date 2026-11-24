export function qualificationMode(
  request: string,
  revision: string,
): 'full' | 'competition-only' | undefined {
  if (!/^[a-f0-9]{40}$/.test(revision)) return undefined;
  if (request === `COR-2653-qualification:${revision}`) return 'full';
  if (request === `COR-2653-qualification:${revision}:competition`) return 'competition-only';
  return undefined;
}

export function competitorActions(output: string): string[] {
  return Array.from(
    output.matchAll(/COR2653_ACTION (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)/g),
    (match) => match[1] ?? '',
  );
}

/** A single passing competitor must record real actions on both sides of the target assertion. */
export function actionsBracketAssertion(
  assertionAt: string | undefined,
  actions: readonly string[],
): boolean {
  if (assertionAt === undefined) return false;
  const assertion = Date.parse(assertionAt);
  if (!Number.isFinite(assertion)) return false;
  const times = actions.map((action) => Date.parse(action)).filter(Number.isFinite);
  return times.some((time) => time < assertion) && times.some((time) => time > assertion);
}
