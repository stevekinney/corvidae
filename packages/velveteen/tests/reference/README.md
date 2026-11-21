# Pinned reference boundary

Run `bun run prepare:reference` from the repository root. It prepares a clean checkout at `a58e0a92c35dbeee161e96c733464dc7397e073a`, installs this directory's frozen toolchain, copies the exact Kit package source into its installed package location, and checks source identity. A symlink cannot be used here: Kit's server-only import guard interprets the checkout's real path differently. No Kit source is patched.

The reference uses Kit 3.3.0, Vite 8.3.3, `@sveltejs/vite-plugin-svelte` 7.3.1, `@sveltejs/adapter-node` 6.0.4, and Svelte 5.57.1. The root Playwright 1.63.0 browser driver exercises both targets. All launcher commands execute through Bun; the Node adapter is reference build tooling only.

The reference dependency closure, generated files, and Vite ambient declarations are isolated from candidate compilation and packaging. The root type gate checks this directory's Vite configuration and endpoint source using its separate `tsconfig.json`, with library checking enabled. The launch contract is a JSON line containing `url`, followed by graceful `SIGTERM` cleanup.
