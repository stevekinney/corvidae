// TypeScript 6 defaults `noUncheckedSideEffectImports` to true. This program type-checks
// `@lostgradient/cinder`'s source directly as a `workspace:*` just-in-time dependency, so its own
// `import './x.css'` statements have to resolve here too: an ambient declaration only applies to
// the program that contains it, which is why this is repeated per program rather than shared. A
// wildcard module satisfies the check without testing that the file exists; the panel build covers
// that, and the compiler does not.
declare module '*.css' {}
