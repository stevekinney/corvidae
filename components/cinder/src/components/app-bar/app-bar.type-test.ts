/**
 * Compile-time regression tests for AppBar's icon actions. An icon has no name of its own, so an
 * action without a `label` must not compile. svelte-check processes this file.
 */
import type { Snippet } from 'svelte';

import type { AppBarAction } from './index.ts';

declare const icon: Snippet;

const named: AppBarAction = { label: 'Share', icon };

// @ts-expect-error An icon-only action needs a label: it is the accessible name and the tooltip.
const unnamed: AppBarAction = { icon };

void named;
void unnamed;
