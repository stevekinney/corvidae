/**
 * Entry point for `/theme-builder`. The page is a client-rendered application: the server
 * sends a document with an empty mount point, a canonical URL, and this bundle, which
 * documentation routes never load.
 */

import { mount } from 'svelte';

import { filtersFromSearch } from './theme-builder-catalogue.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { ThemeBuilderPersistence } from './theme-builder-persistence.svelte.ts';
import { openIndexedDbThemeStore } from './theme-draft-store.ts';
import { THEME_CHANNEL_NAME } from './theme-draft-sync.ts';
import { installThemeEvaluator } from './theme-runtime-evaluator.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';
import ThemeWorkbench from './theme-workbench.svelte';
import { createWorkerEvaluator, type EvaluationWorker } from './theme-worker-evaluator.ts';

const target = document.getElementById('theme-builder-root');
if (target === null) throw new Error('[theme builder] #theme-builder-root target not found');

const THEME_WORKER_URL = '/theme-builder-bundle/theme-runtime-worker.js';

// Evaluation runs in module workers, so the first (slow) evaluation never holds the page. The
// draft's own evaluation has a worker to itself: the checks, export and proposal surfaces
// evaluate every context of every revision, and a worker works through its requests in order,
// so sharing one would queue an edit's preview behind the previous edit's background checks.
const newWorker = () => new Worker(THEME_WORKER_URL, { type: 'module' }) as EvaluationWorker;
const evaluator = createWorkerEvaluator(newWorker);
installThemeEvaluator(createWorkerEvaluator(newWorker));

const workbench = new ThemeWorkbenchState();
workbench.setFilters(filtersFromSearch(window.location.search));
const persistence = new ThemeBuilderPersistence({
  openStore: () => openIndexedDbThemeStore(globalThis.indexedDB),
  channel: typeof BroadcastChannel === 'function' ? new BroadcastChannel(THEME_CHANNEL_NAME) : null,
  tabId: crypto.randomUUID(),
});
const controller = new ThemeBuilderController({
  workbench,
  evaluator,
  persistence,
});

mount(ThemeWorkbench, { target, props: { workbench, controller } });
