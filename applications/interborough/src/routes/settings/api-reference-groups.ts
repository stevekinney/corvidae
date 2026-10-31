/**
 * The four groups of Settings › API reference, in the order the side list names them, and the
 * address of each. The open group is the `group` search parameter, so a group is linked to, and
 * survives a reload. An unknown value opens the first group.
 */
import { API_REFERENCE_COPY } from '../../app/copy.ts';

/** Every group's search-parameter value. */
export const API_REFERENCE_GROUPS = ['operations', 'discovery', 'scopes', 'sources'] as const;

/** One group of the API reference. */
export type ApiReferenceGroup = (typeof API_REFERENCE_GROUPS)[number];

/** The page's path. */
export const API_REFERENCE_PATH = '/settings/api-reference';

/** The group an address with no (or an unknown) `group` opens. */
export const DEFAULT_API_REFERENCE_GROUP: ApiReferenceGroup = 'operations';

/** The words that name a group in the side list. */
export function groupLabel(group: ApiReferenceGroup): string {
  return API_REFERENCE_COPY.groups[group];
}

/** The group a search string names, or the first group when it names none. */
export function groupFromSearch(search: URLSearchParams): ApiReferenceGroup {
  const requested = search.get('group');
  return API_REFERENCE_GROUPS.find((group) => group === requested) ?? DEFAULT_API_REFERENCE_GROUP;
}

/** The address of a group, keeping nothing of the group before it. */
export function groupPath(group: ApiReferenceGroup): string {
  return `${API_REFERENCE_PATH}?group=${group}`;
}
