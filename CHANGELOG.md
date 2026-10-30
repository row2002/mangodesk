# Changelog

All notable changes to MangoDesk. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The release workflow copies the section
for a tag (`## [X.Y.Z] - date`) into the GitHub release notes.

## [Unreleased]

### Added
- Right-click menu in the sidebar tree: create a database (by creating its first
  collection), create / rename / clear / drop a collection, drop a database. Drops
  need the name typed to confirm; the system databases `admin`, `config` and `local`
  are not dropped. The tree, the counts and the open collection follow each change.
  The menu also opens from the keyboard (context-menu key or Shift+F10).
- Index management on the Explain tab: create an index (keys in mongosh syntax;
  unique, sparse, TTL and name options) and drop any index but `_id_`. The plan
  re-runs afterwards, so a new index shows up as an `IXSCAN` straight away.
- `routes/admin.js` API: `POST|PATCH|DELETE /api/connections/:id/databases/:db/collections[/:coll]`,
  `DELETE …/collections/:coll/documents` (clear), `DELETE /api/connections/:id/databases/:db`,
  `POST …/collections/:coll/indexes` and `DELETE …/indexes/:name`. Creating a
  collection that exists is a 400 and dropping an index that doesn't a 404, on every
  server version (MongoDB 7 accepts the first and MongoDB 8 the second silently).
- Import tab: load a JSON array, NDJSON or CSV file into a collection by drag and drop
  or the file picker. JSON and NDJSON are read as canonical Extended JSON, so
  MangoDesk's own exports come back with Long, Double `1.0`, Decimal128, dates and
  ObjectIds intact. CSV: field names from the header row (dotted names build nested
  documents), separator detection including export's Excel mode (`;`, UTF-8 BOM), and
  a type per column (Auto, String, Number, Boolean, Date, ObjectId). Insert or upsert
  by `_id`; stop at the first error or continue. The upload is streamed and written in
  batches, and the result shows inserted / replaced / failed counts with the first
  errors by line. The sidebar picks up the new counts, and a new collection.

## [0.3.0] - 2026-10-25

### Added
- Published on npm: `npx mangodesk` runs the latest release, `npx mangodesk@0.3.0`
  pins one.

### Changed
- Node 22 is now the minimum (`engines`), and CI tests on 22, 24 and 26. Node 18 and
  20 are both past end-of-life, and the MongoDB driver needs 20.19 or newer.
- express 4.22.3 → 5.3.0. The only behaviour the app exposed was the unset `req.body`
  noted under Fixed; the export download builds its own `Content-Disposition`, so the
  quoting change in express 5 does not reach it.
- MongoDB driver 6.21.0 → 7.7.0 (bson 7). Reads, writes and exports keep their exact
  BSON types as before — `promoteValues` moved to bson's deserialize options but is
  still honoured. This driver is what raises the Node floor to 20.19.

### Fixed
- A POST without a JSON `Content-Type` answers 404/400 again instead of 500. Under
  express 5 the body parser leaves `req.body` unset rather than empty, which the
  routes read straight through.

## [0.2.0] - 2026-10-24

### Added
- Standalone executables for Windows x64, macOS (Apple Silicon and Intel) and Linux
  (x64 and arm64), attached to each GitHub release with `SHA256SUMS.txt`; no Node.js
  needed. `npm run build:sea` builds one for the current system.
- Command line: `--port`/`-p`, `--no-open`, `--version`/`-v`, `--help`/`-h`. The
  browser opens by default. A second launch reuses the running MangoDesk; a busy
  default port moves on to the next free one.
- Portable mode: a `connections.json` next to the executable is used instead of
  `~/.mangodesk.json`. The version and the connections file in use are shown on
  start, in the top bar, the connection form and the help dialog.
- Values are shown and edited in mongosh syntax: `ObjectId("…")`, `ISODate("…")`,
  `NumberLong("…")`, `NumberDecimal("…")`, `1.0` for doubles.
- Undo for single and bulk deletes; "Filter by / Exclude this value" in the context menu.
- URL deep links per collection (`#/connection/db/collection`) with Back/Forward.
- First-run welcome with one-click "Connect to localhost:27017"; plain-language
  connection errors; a banner when the server has stopped.
- Colour tag per connection, shown on the top bar.
- Connection form: `mongodb+srv://` and replica-set host lists; switching between
  fields and a pasted connection string carries the values over.
- Query Builder: `null`, `long` and `decimal` types.
- Keyboard shortcuts dialog (`?`); keyboard navigation in the sidebar tree.

### Changed
- JSON and NDJSON exports are canonical Extended JSON, so Long, Double and Decimal128
  keep their types through `mongoimport`.
- "Copy document" copies mongosh syntax instead of Extended JSON.
- Ctrl+C (or closing the console window) shuts down cleanly and closes all database
  connections.
- Tests live in `test/` and run with `node --test`; CI runs them on Linux, macOS and
  Windows with Node 20, 22 and 24, plus integration tests against MongoDB 7.

### Fixed
- Saving a document no longer changes number types: Long, Double `1.0`, Int32 and
  Longs past 2^53 come back exactly as they were.
- Inline edits update only the edited field, so fields hidden by a projection are kept.
- A slow query for the previous collection no longer replaces the current one.
- The Query Code tab produces mongosh code that runs for ObjectId, date and regex
  filters.
- Query Builder dates match the exact instant (no timezone shift or truncation);
  `null` matches null instead of `""`; dragged Decimal128 values match.
- Export errors are shown instead of producing an empty file; CSV columns include
  fields that first appear after document 200.
- Queries that cannot be counted (`$near`, `$where`) page with "total unknown"
  instead of failing.
- A filter, sort or projection that is not an object (`42`, `[1]`) is rejected with
  a clear message.
- Sidebar counts refresh after inserts and deletes; deleting the active connection
  clears the grid.
- Explain spots COLLSCAN in SBE and sharded plans.
- The startup connection picker shows even when the sidebar is hidden.
- The edit dialog no longer closes when a text selection ends outside it.
- A busy port or other startup problem prints one readable line instead of a stack
  trace (and a double-clicked Windows binary waits for Enter before closing).

### Security
- Requests with a foreign `Host` header (DNS rebinding) or from another site (CSRF,
  including form posts) are refused.
- The connections file is written atomically and owner-only (0600); a corrupt file
  is reported, never overwritten.
- Dependencies updated; `npm audit` reports no vulnerabilities.

## [0.1.0] - 2026-07-27

First public release.

### Added
- Connection manager: settings form or connection string, test before save, stored
  in `~/.mangodesk.json`.
- Data browser: Table / Tree / JSON views, paging, sorting, insert / edit / delete,
  bulk delete, copy from the context menu.
- Query bar with mongo-shell syntax (unquoted keys, `ObjectId("…")`, `ISODate("…")`,
  `/regex/i`), history and per-collection recall.
- Typed inline editors with Undo; Explain with the planner verdict and indexes.
- Drag-and-drop Query Builder with AND/OR groups, sort and projection strips.
- Export as JSON, NDJSON or CSV (with an Excel mode).
- Light and dark themes, keyboard shortcuts.

[Unreleased]: https://github.com/row2002/mangodesk/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/row2002/mangodesk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/row2002/mangodesk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/row2002/mangodesk/releases/tag/v0.1.0
