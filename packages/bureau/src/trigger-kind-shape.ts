/**
 * Whether a contributed trigger kind has the shape Bureau can run (COR-2168): a configuration
 * schema, and a `start`, a `receive` or both, each a function when it is present. A member that is
 * there and is not a function is refused where the kind is first seen, so it is never retried
 * forever as a failed listener, nor answered 503 to every request.
 *
 * @module trigger-kind-shape
 */

/** Throws a `TypeError` naming `name` unless `kind` has the shape of a trigger kind. */
export function assertTriggerKindShape(name: string, kind: unknown): void {
  const candidate = kind as {
    readonly start?: unknown;
    readonly receive?: unknown;
    readonly configuration?: { readonly safeParse?: unknown };
  } | null;
  const startIsValid = candidate?.start === undefined || typeof candidate.start === 'function';
  const receiveIsValid =
    candidate?.receive === undefined || typeof candidate.receive === 'function';
  const defined = candidate?.start !== undefined || candidate?.receive !== undefined;
  if (
    !startIsValid ||
    !receiveIsValid ||
    !defined ||
    typeof candidate?.configuration?.safeParse !== 'function'
  ) {
    throw new TypeError(
      `The trigger "${name}" needs a configuration schema and a \`start\` or \`receive\` function.`,
    );
  }
}
