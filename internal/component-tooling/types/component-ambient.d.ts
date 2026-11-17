// The ambient module shapes every Cinder component package compiles against (P-COR-101). Core
// keeps its own copy in `src/ambient.d.ts`; each package extracted from it includes this file from
// its `tsconfig.json` and `tsconfig.browser.json`.

// Svelte 5 ambient types for `.svelte` module resolution under plain tsc.
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<Record<string, unknown>>;
  export default component;
}

// TypeScript 6 defaults `noUncheckedSideEffectImports` to true, so a component's
// `import './x.css'` needs a declaration to resolve against.
declare module '*.css' {}
