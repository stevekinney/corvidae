// The production sources import the stream-event codec through
// `@lostgradient/chat/stream-events`, which reaches no Svelte or Cinder module.
// `chat-agent-test-helpers.ts` still imports conversation builders from the
// `@lostgradient/chat` browser barrel, so a program that includes it also reaches
// `@lostgradient/cinder`'s per-component `import './x.css'` statements.
// TypeScript 6 defaults `noUncheckedSideEffectImports` to true and a bare `tsc`
// program has no loader for `.css`, so the wildcard Cinder already declares for
// itself in `components/cinder/src/ambient.d.ts` is repeated here; ambient
// declarations do not cross package boundaries.
//
// Nothing is loaded at runtime. The only path that reaches a stylesheet is a
// type-only import or a test-only helper, and `verbatimModuleSyntax` erases the former.
declare module '*.css' {}
