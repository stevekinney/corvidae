export type ValueChangeNotification<T> = (next: T) => void;
export type ValueChangeRequestHandler<T> = (next: T) => T | void;

/**
 * What a control held before the pick. When it is given and the final value is the same, the pick
 * was refused (the request hook returned the current value), so `onValueChange` is not called.
 */
export type CommitPrevious = { readonly value: unknown };

/**
 * Runs a pick through the request hook, writes the final value with `setValue`, then tells
 * `onValueChange` about it. Pass `previous` so a pick the hook refused does not notify.
 */
export function commitValue<T>(
  proposed: T,
  onValueChangeRequest: ValueChangeRequestHandler<T> | undefined,
  setValue: (next: T) => void,
  onValueChange?: ValueChangeNotification<T>,
  previous?: CommitPrevious,
): T {
  const requested = onValueChangeRequest?.(proposed);
  const committed = requested === undefined ? proposed : requested;
  setValue(committed);
  if (previous === undefined || !Object.is(committed, previous.value)) onValueChange?.(committed);
  return committed;
}
