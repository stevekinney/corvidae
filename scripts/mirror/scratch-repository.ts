/**
 * What makes a repository the throwaway one, in the one place both the driver and the transport
 * can reach.
 *
 * This module exists so the assertions are not reachable around. The driver's
 * `deleteScratchRepository` is the full guard — it reads the repository from GitHub and checks
 * what came back — but the function that actually issues `DELETE /repos/{owner}/{repo}` is in the
 * transport, and a transport that will delete whatever name it is handed is a second door into
 * the same irreversible operation. Both import from here, so the name check runs on both paths
 * and there is exactly one definition of what the pinned name and the sentinel are.
 */

export class ScratchGuardError extends Error {}

/** The account the scratch repository is created under, and the only one the guard accepts. */
export const scratchOwner = 'stevekinney';

/**
 * The description the guard matches, byte for byte.
 *
 * It is the second of the two independent facts a delete requires, and the stronger one: a name
 * can be made to match by typing it, whereas this has to have been written into the repository by
 * a run of this driver.
 */
export const scratchDescription = 'mirror dry run, safe to delete';

/**
 * The pinned name.
 *
 * Anchored at both ends, so a string that merely *contains* a scratch name — a real repository
 * with a matching suffix, a copy-paste that kept a prefix, a trailing newline off a shell — does
 * not match. Nothing is trimmed first: trimming normalizes a name that did not match into one
 * that does, and the whole purpose here is to refuse anything that is not exactly right.
 */
const scratchNamePattern = /^stevekinney\/mirror-dryrun-(\d{4})(\d{2})(\d{2})$/;

/**
 * The facts a delete is allowed to turn on.
 *
 * Structural rather than an import of the transport's record type, so the transport can depend on
 * this module without the two importing each other.
 */
export interface ScratchRepositoryFacts {
  /** `owner/name` as GitHub reports it, which is not always what was asked for. */
  fullName: string;
  description: string | null;
  private: boolean;
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, '0');
}

/** `stevekinney/mirror-dryrun-YYYYMMDD` for the given instant, in UTC. */
export function scratchRepositoryName(now: Date = new Date()): string {
  const stamp = `${now.getUTCFullYear()}${twoDigits(now.getUTCMonth() + 1)}${twoDigits(now.getUTCDate())}`;
  return `${scratchOwner}/mirror-dryrun-${stamp}`;
}

/** The date stamp out of a name the guard has already accepted. */
export function scratchStamp(target: string): string {
  const [, year = '', month = '', day = ''] = scratchNamePattern.exec(target) ?? [];
  return `${year}${month}${day}`;
}

/**
 * The name half of the guard: the pinned pattern, plus a real calendar date.
 *
 * The date check is what makes this "a name this driver could have produced" rather than "a name
 * shaped like one". `\d{8}` alone accepts `mirror-dryrun-00000000` and `mirror-dryrun-99999999`,
 * which no run ever generates, so accepting them would only ever mean accepting a typo.
 */
export function assertScratchName(target: string): void {
  const matched = scratchNamePattern.exec(target);
  if (!matched) {
    throw new ScratchGuardError(
      `Refusing to act on ${JSON.stringify(target)}: a scratch repository is named ${scratchOwner}/mirror-dryrun-YYYYMMDD and nothing else.`,
    );
  }
  const [, year = '', month = '', day = ''] = matched;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const roundTrips =
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day);
  if (!roundTrips) {
    throw new ScratchGuardError(
      `Refusing to act on ${JSON.stringify(target)}: ${year}${month}${day} is not a calendar date, so no run of this driver produced that name.`,
    );
  }
}

/**
 * The repository half of the guard, against the record GitHub returned for the requested name.
 *
 * `fullName` is compared because GitHub follows a rename: ask for a repository that was renamed
 * and the API answers with the repository it became, under its new name. Without this, a scratch
 * name that once existed and was renamed onto something real would resolve to that real
 * repository and pass every other check on its behalf.
 */
export function assertScratchRepository(target: string, repository: ScratchRepositoryFacts): void {
  if (repository.fullName !== target) {
    throw new ScratchGuardError(
      `Refusing to act on ${target}: GitHub answered with ${JSON.stringify(repository.fullName)} instead, so that name now redirects to a different repository.`,
    );
  }
  if (repository.description !== scratchDescription) {
    throw new ScratchGuardError(
      `Refusing to act on ${target}: its description is ${JSON.stringify(repository.description)}, not ${JSON.stringify(scratchDescription)}.`,
    );
  }
  if (repository.private) {
    throw new ScratchGuardError(
      `Refusing to act on ${target}: it is private, and the scratch repository is public by construction, so this is a different repository.`,
    );
  }
}
