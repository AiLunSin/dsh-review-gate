# Security policy

## Reporting

Report a vulnerability privately to the repository owner (AiLunSin) rather than
opening a public issue. Include the plugin version, DSH version, configuration,
and the smallest command sequence that reproduces the problem.

## Scope

- The plugin never reads or stores file contents in its audit log. It stores
  paths, rule identifiers, line numbers, and truncated hashes only.
- The plugin is advisory at the Host boundary: it can deny or ask through
  `tools/pre-execute`, the tool guard, and `fs/*-intent`. It does **not** sandbox
  `bash` / `pwsh` / MCP tools, so it must be combined with DSH sandbox modes for
  a hard filesystem boundary.
- Rule hits are deterministic regular-expression matches. They are not a
  security proof and can both miss and falsely flag changes.
