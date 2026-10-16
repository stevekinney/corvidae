import { mount } from 'svelte';

import App from './app.svelte';

const target = document.getElementById('app');
if (target === null) throw new Error('The page has no #app element to mount into.');

mount(App, { target });
