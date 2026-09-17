/** Return a value after checking that an indexed test fixture exists. */
export function assertDefined<T>(value: T | undefined, label = 'Expected a value'): T {
  if (value === undefined) throw new Error(label);
  return value;
}
