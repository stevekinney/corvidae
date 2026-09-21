// The package root loads Cinder's base cascade as a side effect, and it must
// come before the application's own stylesheet. Bound to a name rather than
// left as a bare side-effect import, which the workspace lint policy reserves
// for stylesheets.
import * as cinderCascade from '@lostgradient/cinder';
import { mount } from 'svelte';

import { connectRendererRpc } from '../renderer-rpc.ts';
import App from './application.svelte';

import './styles.css';

void cinderCascade;

const target = document.getElementById('app');
if (target === null) throw new Error('Missing #app renderer mount target.');

const { rpc, subscribeToChatStream } = connectRendererRpc();

export default mount(App, {
  target,
  props: { rpc, subscribeToChatStream },
});
