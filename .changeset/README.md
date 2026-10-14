# Release intent

This directory holds release intent for the packages the mirror sync publishes. A changeset is a Markdown file with YAML frontmatter of `"<npm name>": patch|minor|major` lines, followed by a non-empty body that becomes the changelog entry.

Five rules apply:

- Author the intent here. Write the changeset in the same pull request as the change it describes, and the next sync copies it into the mirror that releases the package.
- One target per file. Every name in a file must belong to the same mirror (`weft`, `cinder` or `agent-bureau`). To release packages in two mirrors, write two files.
- After a file has synced, fix mistakes in the target's `.changeset/`, not here. The mirror holds the copy as `.changeset/corvidae-<12 hex>-<name>.md`, and a corvidae edit made after the file synced is never sent again.
- Never reuse a changeset file name. Delete or consume a changeset and pick a new name for the next one; a name that comes back between two syncs makes the sync refuse.
- Never change which mirror a changeset targets. Write a new file instead; a retargeted file was never pending in its new mirror, so the sync refuses.

Corvidae does not version or publish anything. The mirrors own `version`, `CHANGELOG.md` and publishing. A changeset for a target-only package such as `@lostgradient/cinder-mcp` is authored in the target's own `.changeset/` instead.

`scripts/mirror/changesets.test.ts` validates every file here as part of `bun run test:self`.
