# @lostgradient/component-tooling

Tooling that component packages share. For now it holds the Cinder family map (COR-2446): `family-rules.json` groups Cinder's component directories into families and places every other module, `scripts/derive-families.ts` combines the rules with the import graph, and `families.json` is its committed output (memberships, moves and dependency layers).

## Commands

```sh
bun run families:generate   # rewrite families.json from family-rules.json and the import graph
bun run families:check      # exit 1 when families.json is stale
```

`family-rules.fixture.json` holds the reviewed rules; a test keeps `family-rules.json` equal to it.
