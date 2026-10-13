/**
 * Entry point for `/theme-builder`. The page is a client-rendered application: the server
 * sends a document with an empty mount point, a canonical URL, and this bundle, which
 * documentation routes never load.
 */

import { mount } from 'svelte';

import ThemeWorkbench from './theme-workbench.svelte';

const target = document.getElementById('theme-builder-root');
if (target === null) throw new Error('[theme builder] #theme-builder-root target not found');

mount(ThemeWorkbench, { target });
