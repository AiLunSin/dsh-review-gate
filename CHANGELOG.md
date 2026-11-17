# Changelog

## 0.3.5 — 2026-11-18

- Fix: `prune` only considers files matching the snapshot name pattern
  (`<16 hex>-<10 digits>.json`). Previously any `.json` file in
  `review.snapshot.dir` counted toward the 20-entry cap and could be deleted
  when the directory was customised, so a shared or project directory risked
  losing unrelated JSON files. Unrelated files are now never touched.
- 151 tests.

## 0.3.4 — 2026-11-18

- After a DSH restart, a persisted `review-gate/changes` projection now resolves
  to a body-free snapshot of the last successful change summary instead of the
  empty state. The tab shows the file list and counts, labels it with the
  capture time ("Host restarted…"), makes file rows non-clickable, and hides the
  file-open hint, so old data is never presented as the current turn.
- Snapshots live in `$DSH_HOME/review-gate/snapshots` (newest 20 turns) and store
  paths, counts, and binary/oversized flags only — never file contents, diffs, or
  decision-hint text. `review.snapshot.dir` overrides the directory;
  `review.snapshot.enabled: false` restores the 0.3.3 empty-state behavior.
- 150 tests.

## 0.3.3 — 2026-11-18

- Review tab polish: the `error` state is left-aligned like `missing`, and the
  file-open hint only renders in the ready state when at least one changed file
  exists. `missing`/`error` state rendering and scroll reset are now testable
  helpers, with coverage for both states and the empty-file ready state.
- Stale projection after a DSH restart now resets to the empty state when the
  Host no longer serves the persisted turn's summary, instead of rendering a
  missing/old-turn card.
- 142 tests.

## 0.3.2 — 2026-11-17

- Review tab recovery: a persisted `review-gate/changes` projection can point at
  a turn from before a DSH restart, which the Host no longer serves. That state
  now renders a clear missing-state message and recovery hint instead of the
  misleading file-open hint; the body resets its scroll and the message is
  left-aligned for narrow panels. The open hint renders only in the ready state.
- 139 tests.

## 0.3.1 — 2026-11-17

- Fix the P2 authenticated review route: the registered Fetch callback passed
  `(ctx, config, request)` positionally while `handleReviewRequest` takes one
  options object, so every P2 request threw and the client silently fell back
  to P1. Decision hints now render; 0.3.0 shipped with this bug.
- Add a route-wiring test and pin the route path to the browser-relative client
  fetch contract. 138 tests.

## 0.3.0 — 2026-11-17

- P2 import-graph grouping: a Host route (`api/review-gate.units`) reads the
  changed files, parses relative JS/TS/Python imports, and groups changed files
  by entry-reachable weak components; the Client falls back to P1 directory
  grouping when the route or FS is unavailable.
- Decision hints: parse ADR/`docs/decisions` Markdown, CLAUDE.md/AGENTS.md
  bullets, and `@decision` comments; annotate a unit only when an explicit
  `Applies to:` scope matches and a removed line contains a backticked
  identifier from the decision. Suggestions only, never blocking.
- `review.importGraph` and `review.decisionSources` config; bounded reads and
  diffs; authenticated Connection route.
- 136 tests, including import resolution, ADR/comment extraction, decision
  hints, and the authenticated route handler.

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
- 117 tests, including client grouping/render-contract and projection wire tests.

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
