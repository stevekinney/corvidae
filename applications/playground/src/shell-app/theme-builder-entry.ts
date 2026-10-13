/**
 * Entry point for `/theme-builder`. The page is a client-rendered application: the server
 * sends a document with an empty mount point, a canonical URL, and this bundle, which
 * documentation routes never load.
 */

import { mount } from 'svelte';

import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { ThemeBuilderPersistence } from './theme-builder-persistence.svelte.ts';
import { openIndexedDbThemeStore } from './theme-draft-store.ts';
import { THEME_CHANNEL_NAME } from './theme-draft-sync.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';
import ThemeWorkbench from './theme-workbench.svelte';

const target = document.getElementById('theme-builder-root');
if (target === null) throw new Error('[theme builder] #theme-builder-root target not found');

const workbench = new ThemeWorkbenchState();
const persistence = new ThemeBuilderPersistence({
  openStore: () => openIndexedDbThemeStore(globalThis.indexedDB),
  channel: typeof BroadcastChannel === 'function' ? new BroadcastChannel(THEME_CHANNEL_NAME) : null,
  tabId: crypto.randomUUID(),
});
const controller = new ThemeBuilderController({
  workbench,
  evaluator: createRuntimeEvaluator(),
  persistence,
});

mount(ThemeWorkbench, { target, props: { workbench, controller } });
