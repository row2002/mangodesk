# 🥭 MangoDesk

Free Studio 3T-style MongoDB GUI. Local web app: Node + Express + the official
`mongodb` driver, vanilla-JS frontend, no build step.

![MangoDesk — data browser with query builder](docs/screenshot.png)

Build a filter without writing JSON — condition, sort, Run:

![Query Builder — add a condition and a sort, then run it](docs/querybuilder.gif)

## Run

```
npx mangodesk
```

or from a clone:

```
npm install
npm start
```

Open http://localhost:27080 (override with `PORT`). The server listens on
127.0.0.1 only — the API exposes stored credentials and unauthenticated DB access.

## Features

- **Connections** — startup connection picker; settings form (host, port,
  user/password, auth DB, TLS, extra options) or a raw connection string, with
  test-before-save. Stored in `~/.mangodesk.json`, or in `connections.json` next to
  the app if that file already exists (plaintext — local tool).
- **Data browser** — sidebar with a connection → databases → collections tree
  (document counts) and a filter box; Table / Tree / JSON views; pagination,
  column-click sorting, resizable columns and panels; insert / edit / delete
  documents; row selection with bulk delete; right-click to copy a value, a field
  name or the whole document.
- **Queries** — the query bar takes mongo-shell syntax, not just strict JSON:
  unquoted keys, `ObjectId("…")`, `ISODate("…")`, `/regex/i` and trailing commas are
  accepted and normalised before they are sent. Multi-line input, recent-query
  history, and per-collection recall of filter / projection / sort / skip / limit.
- **Editing** — inline cell editors typed per BSON kind (bare ObjectId hex, unquoted
  strings, boolean select, native date picker) that put the original BSON type back
  on save; Undo on every edit; documents without `_id` are read-only rather than
  half-written.
- **Explain** — query planner verdict (`COLLSCAN` is called out), the collection's
  indexes, and the winning plan.
- **Query Builder** — drag fields from the grid into AND/OR condition groups;
  type-aware operators and value inputs (ObjectId, date, number, boolean);
  drag-to-sort and drag-to-projection strips; live filter preview; state is kept
  per collection; Run sends the query to the Data tab.
- **Export** — current query results as JSON array, NDJSON, or CSV (streamed).
  CSV renders BSON scalars as plain values (`12.34`, not `{"$numberDecimal":"12.34"}`)
  and has an Excel mode: UTF-8 BOM, `;` separator, CRLF.
- **Shell** — light and dark themes (follows the OS by default), keyboard shortcuts
  (`Ctrl+Enter` run, `Ctrl+F` filter, `Alt+←/→` paging, `Esc` close), visible focus
  rings.

## No local MongoDB?

```
docker run -d --name mangodesk-test -p 27017:27017 mongo:7
```

then connect to `mongodb://localhost:27017`.

## Tests

```
npm test
```

Covers the pure CSV helpers (escaping, BSON-scalar rendering, dotted field paths).

## License

MIT — see [LICENSE](LICENSE).
