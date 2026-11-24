/** Validate untrusted server data before placing it in the scoped cache. */
export function validateSeed(value: unknown): value is {
  jobs: { id: string; tenant: string }[];
  next: string | null;
  total: number;
} {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record['jobs']) &&
    record['jobs'].every(
      (item: unknown) =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>)['id'] === 'string' &&
        typeof (item as Record<string, unknown>)['tenant'] === 'string',
    ) &&
    (record['next'] === null || typeof record['next'] === 'string') &&
    typeof record['total'] === 'number' &&
    Number.isFinite(record['total']) &&
    record['total'] >= 0
  );
}
