# Changelog

## 0.1.0 — unreleased

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
