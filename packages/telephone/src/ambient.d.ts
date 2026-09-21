// This package imports `@lostgradient/chat` for `encodeChatStreamEvent`, and that
// package has one public entry point — its browser barrel — so the program
// also reaches `@lostgradient/cinder`'s per-component `import './x.css'`
// statements. TypeScript 6 defaults `noUncheckedSideEffectImports` to true and
// a bare `tsc` program has no loader for `.css`, so the wildcard Cinder already
// declares for itself in `components/cinder/src/ambient.d.ts` is repeated here;
// ambient declarations do not cross package boundaries.
//
// Nothing is loaded at runtime. The only path that reaches a stylesheet is a
// type-only import, which `verbatimModuleSyntax` erases.
declare module '*.css' {}
