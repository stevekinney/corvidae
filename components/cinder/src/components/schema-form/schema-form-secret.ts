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

/** The longest a key reads in an option before its middle is cut. */
export const SECRET_OPTION_LABEL_LIMIT = 32;

/**
 * A key as an option reads it: whole when it is short, and cut in the middle with an ellipsis when
 * it is longer than {@link SECRET_OPTION_LABEL_LIMIT}, so the start (which plugin) and the end
 * (which secret) both show.
 */
export function secretOptionLabel(key: string): string {
  if (key.length <= SECRET_OPTION_LABEL_LIMIT) return key;
  const keep = SECRET_OPTION_LABEL_LIMIT - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${key.slice(0, head)}…${key.slice(key.length - tail)}`;
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
