# Release intent

This directory holds release intent for the packages the mirror sync publishes. A changeset is a Markdown file with YAML frontmatter of `"<npm name>": patch|minor|major` lines, followed by a non-empty body that becomes the changelog entry.

Four rules apply:

- Author the intent here, one target per file. Write the changeset in the same pull request as the change it describes, and the next sync copies it into the mirror that releases the package. Every name in a file must belong to the same mirror (`weft`, `cinder` or `agent-bureau`); to release packages in two mirrors, write two files.
- Merged changesets are immutable. Once a changeset is on `main`, do not edit, retarget or rename it. To replace a changeset, delete it in one pull request and add the replacement under a new name in a separate, later pull request; deleting and adding in one commit reads as a rename, and the sync refuses. After it syncs, fix it in the target's `.changeset/`, where the mirror holds the copy as `.changeset/corvidae-<12 hex>-<name>.md`; a corvidae edit made after the file synced is never sent again, and the sync refuses.
- Never reuse a changeset file name, even after the old file is deleted.
- Do not move a package between mirrors while any corvidae changeset names it. Delete those changesets first and add new ones after the move; the sync refuses otherwise.

Corvidae does not version or publish anything. The mirrors own `version`, `CHANGELOG.md` and publishing. A changeset for a target-only package such as `@lostgradient/cinder-mcp` is authored in the target's own `.changeset/` instead.

`scripts/mirror/changesets.test.ts` validates every file here as part of `bun run test:self`.
