/**
 * The words of a check, from the name of the validator it runs and the configuration it was given.
 * A validator is named by the exact text it was registered with, and a name with no space in it is a
 * slug (`contains-phrase`), which reads as the words it stands for ("Contains phrase"). A name that
 * already has spaces is said as it is. A plugin's validator is `<plugin>:<name>`; the plugin's
 * namespace is left off (`demo:accepts-any-answer` reads "Accepts any answer", as an agent's name
 * does in its row), and the picker says where a check comes from by the group it sits in. A
 * configuration adds each of its top-level text and number
 * values in double quotes, joined by ", ", so `contains-phrase` with `{ phrase: "staging fix" }`
 * reads `Contains phrase "staging fix"` in the row, the facts and the picker's choice.
 *
 * The goal pages and the Checks page (COR-2114) say a check the same way, so a check has one name
 * everywhere.
 */
export function checkText(validatorName: string, configuration?: unknown): string {
  const name = validatorName.trim();
  const colon = name.indexOf(':');
  // A name with spaces, or with nothing after its colon, is said as it is, whole.
  const local =
    colon === -1 || colon === name.length - 1 || /\s/.test(name) ? name : name.slice(colon + 1);
  const words = local.replaceAll(/[-_]+/g, ' ').trim();
  const base =
    local === '' || /\s/.test(local)
      ? local
      : words === ''
        ? local
        : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  const values =
    typeof configuration === 'object' && configuration !== null && !Array.isArray(configuration)
      ? Object.values(configuration)
          .filter((value) => typeof value === 'string' || typeof value === 'number')
          .map((value) => `"${String(value)}"`)
      : [];
  return values.length === 0 ? base : `${base} ${values.join(', ')}`;
}
