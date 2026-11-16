# Changelog

## 0.2.0 — 2026-11-17

- P1 side panel: a `review-gate` tab type in the Web right sidebar, discovered
  through the sidebar guide, rendering the latest turn's changed files as 3–5
  deterministic review units (directory + entry-file heuristic).
- Client-visible projections: `review-gate/changes` (latest
  `workspace/changes` seq/turn), `review-gate/meta` (`review.maxUnits` and
  `entryPatterns`), and the scope state.
- Clicking a file opens the built-in `changes-review` tab at the matching index;
  the plugin does not render diffs.
- `review` config section with `maxUnits` and `entryPatterns`.
- Client module and `dsh.client` manifest; verified as an active tab body via
  live Client Inspect in the Desktop profile.
- 116 tests, including client grouping and projection wire tests.

## 0.1.0 — 2026-11-17

- Initial P0 implementation for DSH `0.2.2-rc.3`.
- `/review-scope <glob...>` and `/review-scope clear`, persisted through a
  session projection over durable `command/run` events.
- Deterministic pre-write scope gate for `write`, `edit`, `apply_patch`, and
  `str_replace_editor`.
- Sensitive-deletion rule set (RG-AUTH-001, RG-GUARD-002, RG-VALID-003) with
  path, rule, line, and file-header suppression.
- Decision synthesis with `ask` by default for out-of-scope writes, `deny` for
  protected paths and `block` rules, and a configurable approval-unavailable
  fallback.
- Local JSONL audit trail without file contents.
- `fs/*-intent` safety net for unmapped file tools and synchronous protected
  path guard.
