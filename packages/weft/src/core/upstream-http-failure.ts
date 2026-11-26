/** Bounded, non-text facts about an upstream HTTP failure. */
export interface UpstreamHttpFailure {
  readonly source: 'github' | 'other';
  readonly status: number;
}

function isHttpFailureStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599;
}

export function isUpstreamHttpFailure(value: unknown): value is UpstreamHttpFailure {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const fact = value as Record<string, unknown>;
  return (
    Object.hasOwn(fact, 'source') &&
    Object.hasOwn(fact, 'status') &&
    (fact['source'] === 'github' || fact['source'] === 'other') &&
    isHttpFailureStatus(fact['status']) &&
    Object.keys(fact).every((key) => key === 'source' || key === 'status')
  );
}

/** An explicit failure from a provider boundary; free-form messages never supply its facts. */
export class UpstreamHttpError extends Error {
  readonly upstreamFailure: UpstreamHttpFailure;
  constructor(failure: UpstreamHttpFailure, message: string) {
    super(message);
    if (!isUpstreamHttpFailure(failure)) throw new TypeError('Invalid upstream HTTP failure');
    this.name = 'UpstreamHttpError';
    this.upstreamFailure = { ...failure };
  }
}

const attached = new WeakMap<Error, UpstreamHttpFailure>();

export function attachUpstreamFailure(error: Error, value: unknown): void {
  if (isUpstreamHttpFailure(value)) attached.set(error, { ...value });
}

/** Extract facts only from typed errors or explicitly reconstructed typed failures. */
export function upstreamFailureOf(error: unknown): UpstreamHttpFailure | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const fact =
      current instanceof UpstreamHttpError ? current.upstreamFailure : attached.get(current);
    if (fact !== undefined && isUpstreamHttpFailure(fact)) return { ...fact };
    current = current.cause;
  }
  return undefined;
}
