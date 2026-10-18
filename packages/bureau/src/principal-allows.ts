import { ownerOrLocal } from './owner-of-record';

/**
 * Whether a caller naming `requested` may act on a record owned by `owner`.
 *
 * Omitting `requested` is a trusted, internal call, so the comparison passes.
 * A record with no recorded owner is owned by `anonymous:local`, the read rule for
 * a record persisted before owners existed, so it admits that owner and no other
 * stated principal. Both `bureau.children` and `bureau.goals` answer a denial
 * exactly as they answer a record that is not there, so a caller cannot tell
 * "wrong id" from "not yours".
 */
export function principalAllows(requested: string | undefined, owner: string | undefined): boolean {
  return requested === undefined || requested === ownerOrLocal(owner);
}
