import { mount } from 'svelte';

import { WeftConsole as App } from '@corvidae/weft-ui';

const target = document.getElementById('app');

if (!target) {
  throw new Error('weft-ui: #app mount element not found in index.html');
}

mount(App, { target });
