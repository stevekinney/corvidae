/** Read only host-attested review identifiers and rounds; malformed entries grant nothing. */
export function readReviewEligibility(metadata: unknown): Map<string, number> {
  const targets = new Map<string, number>();
  if (!Array.isArray(metadata)) return targets;
  for (const entry of metadata) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !Object.hasOwn(entry, 'id') ||
      !Object.hasOwn(entry, 'round')
    )
      continue;
    const id = Reflect.get(entry, 'id');
    const round = Reflect.get(entry, 'round');
    if (
      typeof id === 'string' &&
      id.length > 0 &&
      typeof round === 'number' &&
      Number.isSafeInteger(round) &&
      round >= 0
    )
      targets.set(id, round);
  }
  return targets;
}
