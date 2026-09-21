import { Button, shikiHighlighter } from '@lostgradient/cinder';
import { mount } from 'svelte';
export const highlighter = shikiHighlighter({
  languageLoaders: { typescript: () => import('@shikijs/langs/typescript') },
  themeLoaders: { 'github-light': () => import('@shikijs/themes/github-light') },
  theme: 'github-light',
});

const output = document.createElement('div');
output.innerHTML = await highlighter('const answer = 42;', 'typescript');
document.body.appendChild(output);

mount(Button, { target: document.body, props: { label: 'Highlight TypeScript' } });
