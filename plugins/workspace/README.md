# @lostgradient/plugin-workspace

The workspace plugin contributes read-only `glob`, `grep`, and `read-file` tools for configured directories. Each root is named by an identifier and jailed to its canonical path, so an agent can be granted only the root it needs.

Configure the plugin with `roots`, each containing an `id`, an absolute readable directory `path`, and a descriptive `description`. Configuration is read when the host starts; invalid roots leave the plugin in `setup-failed`.
