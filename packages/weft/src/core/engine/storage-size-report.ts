export function normalizeStorageSizeReportInterval(
  value: unknown,
  fieldName: string,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer when provided`);
  }
  return value;
}
