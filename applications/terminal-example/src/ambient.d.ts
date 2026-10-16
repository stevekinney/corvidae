// Side-effect stylesheet imports in the workspace sources the example compiles (Cinder, the
// terminal) are resolved by the bundler, not by the type checker.
declare module '*.css' {}
