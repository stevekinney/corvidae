# @lostgradient/component-tooling

The generators, checks, scaffolding, schemas and component-free test helpers that component packages share (COR-2079). Cinder's package scripts run them by path (`bun ../../packages/component-tooling/scripts/<script>.ts`) from the package's own directory, so a check reads the package it runs in.

## What it holds

- `scripts/`: the component artifact generators (`generate-*.ts`), the checks (`check-*.ts`), `create-component.ts` and `create-package.ts`, the shared test preload (`preload.ts`), and the family map (`derive-families.ts`, with `family-rules.json` and the generated `families.json`).
- `src/schemas/`, `src/manifest.meta.ts` and `src/schema-types.ts`: the schemas and types the generators write against. Cinder re-exports the schema types its generated modules import.
- `src/test/`: test helpers that import no component, exported as `@lostgradient/component-tooling/test/<file>`.

## Commands

```sh
bun run create-package <name>   # scaffold components/<name> as a family package
bun run families:generate       # rewrite families.json from family-rules.json and the import graph
bun run families:check          # exit 1 when families.json is stale
bun run tokens:audit            # the token-usage report over every component workspace
```

`test` runs the tooling's own tests and the token-usage audit in strict mode, so a change to any component workspace's source re-runs it. `family-rules.fixture.json` holds the reviewed rules (COR-2446); a test keeps `family-rules.json` equal to it. `scripts/move-cinder-tooling.ts` is the re-runnable script that moved this code out of Cinder.
