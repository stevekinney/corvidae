---
name: add-dependency
description: Add or update a dependency in this internal Bun workspace, with explicit ownership, workspace references, and shared catalog versions.
---

# Add a dependency

Read the root `AGENTS.md`, target workspace manifest, root catalog, and imports before changing dependencies. Infer the owning workspace from the requested capability; declare it in each workspace that actually imports it. If the import or script owner remains unknown, stop before editing and report `needs input` with the candidate owners and evidence.

## Ownership

- Declare runtime imports and types consumed by another package's public source contract in the owning workspace's `dependencies`. Put test-only and compiler tools in `devDependencies`.
- Declare tools run by root scripts in the root manifest and tools run by workspace scripts in that workspace. Shared tool versions belong in the root catalog. This repository has no publishing, CI/CD, deployment, or Git-hook setup.
- Internal imports use the provider's actual `@lostgradient/*` name with `workspace:*`. Do not add compatibility aliases, subpaths, or dependency cycles.
- Reuse an existing root catalog version for external dependencies. For a new shared version, run `bun add <package> --catalog` from the owning workspace; add `--dev` for developer tooling. Run the same command from the root for root-owned tooling. Inspect the resulting manifests rather than assuming the command chose the intended owner. Upgrade a catalog entry only when required by the requested capability and validate every affected consumer. If required versions or peer contracts cannot coexist, report `needs input` with the conflict before changing them.

## Verification

Manifest changes authorize `bun install` to update the root lockfile; expected dependency edits are the owning manifest, root catalog, and `bun.lock`. Then run `bun install --frozen-lockfile`. Run `bunx turbo run lint typecheck test --filter=@lostgradient/<name> --concurrency=1` for the affected workspace and `bun run test:self` for dependency and architecture contracts. A root-only tooling change also requires `bun run validate`.

Report the owning manifest, catalog and lockfile changes with exact command exit statuses. Diagnose failures without suppressing checks or changing limits.
