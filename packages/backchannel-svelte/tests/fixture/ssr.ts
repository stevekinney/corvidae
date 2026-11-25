import { render } from 'svelte/server';
import Ssr from './Ssr.svelte';

export function renderFixture() {
  return render(Ssr).body;
}
