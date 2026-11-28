/**
 * Internal context a component publishes when it renders a Table's size container itself, around
 * its own scroll box (DataTable does, since its scroll box is its own and a container query cannot
 * style the container's ancestors). The Table inside then renders no `.cinder-table-container` of
 * its own. The value carries no data; its presence is the signal (COR-2771).
 */

import { createContext } from 'svelte';

import { optionalContext } from '../../_internal/optional-context.ts';

const [getTableContainerProvidedStrict, setTableContainerProvidedRaw] = createContext<true>();

/** Tell the Table inside that its size container is already rendered around it. */
export function setTableContainerProvided(): void {
  setTableContainerProvidedRaw(true);
}

/** Whether an ancestor renders this Table's size container. */
export const getTableContainerProvided: () => true | undefined = optionalContext(
  getTableContainerProvidedStrict,
);
