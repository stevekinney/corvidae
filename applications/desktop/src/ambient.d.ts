// TypeScript 6 defaults `noUncheckedSideEffectImports` to true, so the
// per-component `import './x.css'` statements throughout `@lostgradient/cinder`
// need a declaration to resolve against. Ambient declarations do not cross
// package boundaries, so each consuming workspace repeats the wildcard that
// Cinder already declares for itself in `components/cinder/src/ambient.d.ts`.
//
// The renderer reaches these through Cinder's component barrels. The main
// process reaches the same modules through one type-only import in
// `@lostgradient/chat`'s wire types; `verbatimModuleSyntax` erases that import, so
// no stylesheet is ever loaded into the Bun process.
declare module '*.css' {}

// Svelte 5 ambient types for `.svelte` module resolution under plain tsc.
// svelte2tsx provides a proper per-file declaration, but tsc still needs the
// fallback `*.svelte` module shape to resolve imports in `.ts` barrels.
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<Record<string, unknown>>;
  export default component;
}
