import type { SchemaFormSecretCopy } from './schema-form.types.ts';

/** The words of the secret field, until a host gives its own. */
export const DEFAULT_SECRET_COPY: SchemaFormSecretCopy = {
  help: 'Pick a saved secret. The form keeps its name, never its value.',
  placeholder: 'Choose a secret',
  emptyPlaceholder: 'No secrets to choose',
  emptyHelp: 'No secrets are saved yet.',
  emptyHelpEnd: '',
  failed: 'Couldn’t load the saved secrets.',
  retry: 'Try again',
  missing: (key) => `${key} isn’t saved yet.`,
  addKey: 'Add the key',
  none: 'None',
  set: 'Set',
  missingNote: 'Missing',
  hidden: 'Hidden',
  notChosen: 'Not chosen',
  yes: 'Yes',
  no: 'No',
};

/** `copy` over the defaults. */
export function resolveSecretCopy(copy: Partial<SchemaFormSecretCopy> | undefined) {
  return { ...DEFAULT_SECRET_COPY, ...copy };
}

/** `text` split around the first `key` in it, so the key can be drawn in monospace; `undefined` when it holds none. */
export function splitAroundKey(
  text: string,
  key: string,
): { readonly before: string; readonly after: string } | undefined {
  const index = text.indexOf(key);
  if (index === -1) return undefined;
  return { before: text.slice(0, index), after: text.slice(index + key.length) };
}
