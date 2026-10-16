/**
 * How the consumer parity check compares two computed custom property values (COR-486):
 * exact equality after whitespace normalization, numeric parts within 1e-6, nothing looser.
 * Geometry is compared separately, within 1 CSS pixel.
 */

export const NUMERIC_TOLERANCE = 1e-6;
export const GEOMETRY_TOLERANCE = 1;

const NUMBER = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

function normalize(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/,\s*/g, ', ')
    .trim();
}

export function equalWithinTolerance(actual: string, expected: string): boolean {
  const a = normalize(actual);
  const b = normalize(expected);
  if (a === b) return true;
  if (a.replace(NUMBER, '#') !== b.replace(NUMBER, '#')) return false;
  const aNumbers = a.match(NUMBER) ?? [];
  const bNumbers = b.match(NUMBER) ?? [];
  return (
    aNumbers.length === bNumbers.length &&
    aNumbers.every((n, i) => Math.abs(Number(n) - Number(bNumbers[i])) <= NUMERIC_TOLERANCE)
  );
}
