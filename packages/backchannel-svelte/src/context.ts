import { createContext } from 'svelte';
import type { CatalogHost } from './index.ts';

/** The host belongs to the current Svelte component tree, not a server global. */
export const [getCatalogHost, setCatalogHost] = createContext<CatalogHost>();
