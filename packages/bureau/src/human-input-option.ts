import { checkHumanInputSchemas, type HumanInputSchema } from '@lostgradient/operative';

import type { BureauHumanInputOption } from './types';

/**
 * COR-1700 — whether {@link BureauHumanInputOption} offers `requestHumanInput`: it does unless the
 * option is `false`. Callers still decide whether the run kind and engine can offer it at all.
 */
export function humanInputEnabled(option: BureauHumanInputOption | undefined): boolean {
  return option !== false;
}

/** COR-1674 — the per-signal answer schemas the option carries, if any. */
export function humanInputSchemasOf(
  option: BureauHumanInputOption | undefined,
): Readonly<Record<string, HumanInputSchema>> | undefined {
  return typeof option === 'object' && option !== null ? option.inputSchemas : undefined;
}

/**
 * COR-1674 — fails fast at `createBureau` for an `inputSchemas` map operative would refuse, so a
 * bad schema is a startup error and never a failure on the first run that parks.
 */
export function validateHumanInputOption(option: BureauHumanInputOption | undefined): void {
  const schemas = humanInputSchemasOf(option);
  if (schemas !== undefined) checkHumanInputSchemas(schemas);
}
