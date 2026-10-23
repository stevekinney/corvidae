import type { ToolMetadata } from './is-tool';

const PLACEHOLDER = /\{([A-Za-z_][\w.]*)(?::([a-z-]+))?\}/g;

/** How a placeholder's value is written: `{cents:usd-cents}` turns `4200` into `$42.00`. */
const FORMATTERS: Readonly<Record<string, (value: unknown) => string | undefined>> = {
  'usd-cents': (value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? `$${(value / 100).toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`
      : undefined,
};

function lookup(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Writes a tool's `metadata.summary` template for one call: `{orderId}` is the call's `orderId`
 * argument, `{customer.name}` reaches into an object, and `{cents:usd-cents}` formats a number of
 * cents as dollars. The result is a short clause a person can decide on, such as
 * `Refund order order-1001 for $42.00`.
 *
 * Returns `undefined` when the tool declares no template or when a placeholder has no value in
 * `parameters` (or names a formatter that cannot write it), so a caller falls back to the plain
 * wording instead of showing a half-filled sentence. The result is a pure function of its inputs,
 * which approval matching relies on.
 */
export function renderToolSummary(
  metadata: ToolMetadata | undefined,
  parameters: unknown,
): string | undefined {
  const template = metadata?.['summary'];
  if (typeof template !== 'string' || template.trim() === '') return undefined;
  let complete = true;
  const text = template.replace(PLACEHOLDER, (_match, path: string, format?: string) => {
    const value = lookup(parameters, path);
    let written: string | undefined;
    if (format !== undefined) written = FORMATTERS[format]?.(value);
    else if (typeof value === 'string') written = value;
    else if (typeof value === 'number' || typeof value === 'boolean') written = String(value);
    if (written === undefined) complete = false;
    return written ?? '';
  });
  return complete ? text : undefined;
}
