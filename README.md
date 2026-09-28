# DBX Visual Query Builder

Build read-only `SELECT` queries visually inside [DBX](https://dbxio.com), with a
draggable relationship diagram and a SQL preview that stays in sync with what you
build.

## What it does

- **Relationship diagram.** Add tables, drag them where you want, and the real
  foreign keys between them are drawn with `1`/`N` cardinality. Selecting a
  column lights up the relation it belongs to.
- **Auto-join.** Add a table that has a foreign key to one already on the
  canvas and the join is created for you. Only actual FK metadata is used —
  matching column names never invent a relationship.
- **Live SQL.** Every change rewrites the query. Read it, copy it, or edit it by
  hand and run your version.
- **Run it.** The generated statement is executed through DBX's read-only query
  API on a connection you have already opened and approved.
- **Work with the results.** Filter globally or per column, page through the
  rows, resize columns, and inspect one row at a time.
- **Export.** CSV, real `.xlsx`, and PDF, plus a printable HTML document.

## Supported databases

| Database | Status |
|---|---|
| PostgreSQL | tested |
| MySQL / MariaDB | tested |
| SQLite | generator tested, not yet run against a live SQLite connection |

Other databases fail closed with an "unsupported dialect" message rather than
emitting SQL the server may reject.

## Requirements

- DBX `0.6.26` or newer (the query API is Host API `1.4`)
- A connection that is already **open** in DBX

The plugin has no driver, no connection pool, and no credentials of its own. It
reads metadata and runs queries through DBX's own APIs, under the permission you
grant per connection.

## Install

From the DBX Store, or build it yourself:

```bash
npm install
npm test
npm run build
dbx-plugin package . --target universal
```

Then in DBX: **Plugin Center → Settings → install** the resulting
`dist/*.dbxp`. Unsigned packages need the development-install toggle.

## Using it

The plugin has no connection picker of its own — DBX's plugin API does not let a
plugin enumerate the host's connections. Open it from the sidebar instead:

1. Expand a database in the sidebar tree.
2. Right-click a **table** (not the connection, not the database) →
   **Visual Query Builder**. The workbench opens already scoped to that
   database, with that table added.
3. Add more tables from the left, or from the diagram.
4. Pick columns, set filters, and press **Run SELECT**.

Opening from a connection also works, but then you choose the database yourself
from the header dropdown.

## Permissions

| Permission | Why |
|---|---|
| `host.schema:read` | read table and column metadata |
| `host.data:read` | run one read-only `SELECT` per query |
| `host.storage` | per-plugin UI state |

Nothing is sent to any external network service. File export and print go
through DBX's own save dialog, so the plugin never downloads anything itself.

## Safety notes

- Only one read-only `SELECT` is ever run, and DBX re-checks that on its side.
- The plugin has no parameter binding in the host API, so values are serialised
  per dialect. On MySQL this means backslashes are escaped before apostrophes —
  doing it in the other order is exploitable. See `src/dialect.js`.
- Diagram positions are cosmetic. They never change the SQL.

## Development

```bash
npm install
npm test        # 113 unit tests
npm run build
```

Useful while iterating:

```bash
dbx-plugin dev --port 5190
```

The development host implements only a subset of the Host API, so `queryData`
and `getTableMetadata` are unavailable there. Test against the desktop app.

## Known limitations

- Column filters are substring matches, not typed comparisons.
- `RIGHT` and `FULL OUTER JOIN` are generated but have not been run against a
  live database; MySQL and SQLite differ in support.
- A `HAVING` clause typed as a raw expression is passed through unchecked.
- PDF export uses the base-14 Helvetica font without embedding, so characters
  outside Latin-1 are replaced with `?` and you are told how many.
- The diagram is a relationship view, not a general ERD designer.

## License

[Apache-2.0](LICENSE)
