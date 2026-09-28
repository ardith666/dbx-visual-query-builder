<script>
  import { generate } from "./generator.js";
  import { listDatabases, listTables, listColumns, listForeignKeys } from "./metadata.js";
  import { missingJoins } from "./relationships.js";
  import Diagram from "./Diagram.svelte";
  import { paging, clampLimit, ALL_ROWS } from "./paging.js";
  import { toCsv, toXlsx, toPdf, diagramHtml, tableHtml } from "./export.js";
  import { resultHeaders } from "./headers.js";

  const enc = new TextEncoder();

  const AGGREGATES = ["", "COUNT", "SUM", "AVG", "MIN", "MAX"];
  const OPERATORS = ["=", "<>", ">", ">=", "<", "<=", "LIKE", "NOT LIKE", "IN", "NOT IN", "BETWEEN", "IS NULL", "IS NOT NULL"];
  const JOINS = ["INNER", "LEFT", "RIGHT", "FULL", "CROSS"];

  let plugin = $state(null);
  let connectionId = $state(null);
  let dbType = $state(null);
  let dbName = $state("");
  let ctxDatabase = $state("");
  let ctxTable = $state(null);

  let databases = $state([]);
  let tables = $state([]);
  let foreignKeys = $state([]);
  // LIMIT starts at 100: enough to see whether the query is right, small enough
  // that a fat table does not stall the grid. The user can raise it.
  const DEFAULT_LIMIT = 100;
  let model = $state({ tables: [], select: [], joins: [], filters: [], groupBy: [], orderBy: [], limit: DEFAULT_LIMIT });

  let tab = $state("select");
  let view = $state("diagram");
  let search = $state("");
  // Owned here, bound into the diagram: the component unmounts when the user
  // switches tabs, so card positions cannot live inside it.
  let pos = $state({});
  let zoom = $state(1);

  // Bottom panel height in px, dragged by the splitter. Small by default: the
  // diagram is the main surface and the results grid wants the width.
  let panelH = $state(200);
  const PANEL_MIN = 96;
  const PANEL_MAX = () => Math.max(PANEL_MIN, window.innerHeight - 220);

  let resizing = $state(false);
  let mainEl = $state(null);
  // SQL / Results are real tabs: they used to be derived from `result`, so the
  // button looked clickable but had no handler.
  let panelView = $state("sql");
  // Client-side paging over the fetched rows. 10 per page keeps the grid small
  // by default; "all" shows everything the host returned.
  let page = $state(1);
  let pageSize = $state(10);
  const PAGE_SIZES = [10, 25, 50, 100, 500, 1000, ALL_ROWS];
  const pageSizeLabel = (n) => (n === ALL_ROWS ? "all" : String(n));
  function startResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizing = true;
    window.addEventListener("mousemove", onResize);
    window.addEventListener("mouseup", endResize);
  }
  function onResize(event) {
    if (!resizing) return;
    // The divider is measured from the top: dragging it up gives the space to
    // the diagram, so the bottom panel shrinks. (This was inverted before.)
    const dividerTop = event.clientY;
    const mainTop = mainEl?.getBoundingClientRect().top ?? 0;
    const next = window.innerHeight - (dividerTop - mainTop);
    panelH = Math.min(PANEL_MAX(), Math.max(PANEL_MIN, Math.round(next)));
  }
  function endResize() {
    resizing = false;
    window.removeEventListener("mousemove", onResize);
    window.removeEventListener("mouseup", endResize);
  }
  // Keyboard equivalent, so the splitter is not mouse-only (PRD FR-14).
  // Arrows follow the divider: Up gives room to the diagram.
  function nudge(event) {
    const step = { ArrowUp: -40, ArrowDown: 40, PageUp: -120, PageDown: 120 }[event.key];
    if (!step) return;
    event.preventDefault();
    panelH = Math.min(PANEL_MAX(), Math.max(PANEL_MIN, panelH + step));
  }
  let banner = $state(null);
  let busy = $state(false);
  let running = $state(false);
  let result = $state(null);
  // Visible status so a bug report never depends on guessing what loaded.
  let status = $state({ connection: false, dbs: 0, tables: 0, fks: 0, opened: null, error: null });

  const hasData = $derived(!!plugin?.capabilities?.dataApi);

  const sql = $derived.by(() => {
    try {
      return generate(model, dbType ?? "postgres");
    } catch (error) {
      return `-- ${error.message}`;
    }
  });

  // Joins implied by real foreign keys that are not in the model yet.
  const pendingJoins = $derived(model.tables.length > 1 ? missingJoins(model, foreignKeys) : []);

  const canRun = $derived(hasData && dbName && dbType && !sql.startsWith("--") && !running);

  function setPageSize(size) {
    pageSize = Number(size);
    page = 1;
  }
  function goPage(delta) {
    page = Math.min(pageCount, Math.max(1, page + delta));
  }

  // Filtering shrinks the row set, so paging must work off the filtered rows.
  const totalRows = $derived(filteredRows.length);
  const pg = $derived(paging(totalRows, pageSize, page));
  const pageCount = $derived(pg.pageCount);
  const pageStart = $derived(pg.start);
  const pageRows = $derived(filteredRows.slice(pg.start, pg.end));
  // Manual SQL editing. The generated SQL stays authoritative until the user
  // edits it; from then on their text is what runs, and the builder shows that
  // it has diverged rather than silently overwriting their work.
  let editingSql = $state(false);
  let manualSql = $state("");
  let sqlEdited = $derived(manualSql.trim() !== "" && manualSql.trim() !== sql.trim());

  function startEdit() {
    manualSql = sql.replace(/;\s*$/, "");
    editingSql = true;
  }
  function stopEdit() {
    editingSql = false;
  }
  function cancelEdit() {
    editingSql = false;
    manualSql = "";
  }
  const runnableSql = $derived(sqlEdited ? manualSql : sql.replace(/;\s*$/, ""));

  // Column widths, dragged on the header border. Reset whenever a new result
  // arrives, because column identity changes with it.
  let colWidths = $state({});
  let detailRow = $state(null);

  function startResizeCol(event, index) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const cell = event.currentTarget.parentElement;
    const startX = event.clientX;
    const startW = cell.getBoundingClientRect().width;
    const move = (e) => {
      colWidths = { ...colWidths, [index]: Math.max(40, Math.round(startW + e.clientX - startX)) };
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  function resetWidths() {
    colWidths = {};
  }
  // Keyboard equivalent for the drag handle, so column sizing is not mouse-only.
  function nudgeWidth(event, index) {
    const step = { ArrowLeft: -16, ArrowRight: 16 }[event.key];
    if (!step) return;
    event.preventDefault();
    const cell = event.currentTarget.parentElement;
    const current = colWidths[index] ?? cell.getBoundingClientRect().width;
    colWidths = { ...colWidths, [index]: Math.max(40, Math.round(current + step)) };
  }
  function prettyCell(value) {
    if (value === null) return { text: "NULL", cls: "null" };
    if (typeof value === "object") return { text: JSON.stringify(value, null, 2), cls: "" };
    return { text: String(value), cls: "" };
  }

  const filtering = $derived(globalFilter.trim() !== "" || activeColumnFilters.length > 0);

  // The generator emits SELECT items in model order, so a result column can be
  // traced back to the table it came from. Colliding names get a table suffix.
  const resultLabels = $derived(
    result
      ? resultHeaders(
          result.columns,
          model.select.map((s) => ({ ...s, tableName: model.tables.find((t) => t.id === s.tableId)?.alias || model.tables.find((t) => t.id === s.tableId)?.name })),
        )
      : [],
  );

  function hasJoin(key) {
    return model.joins.some((j) => `${tableName(j.leftTableId)}.${tableName(j.rightTableId)}` === key);
  }

  // A real foreign key is not a guess, so adding a related table wires the
  // join immediately. No confirmation step: the FK metadata is the evidence.
  function autoJoin() {
    const added = [];
    let joins = [...model.joins];
    for (const j of missingJoins({ ...model, joins }, foreignKeys)) {
      joins.push({ id: `j${joins.length + 1}`, type: j.type, leftTableId: j.leftTableId, rightTableId: j.rightTableId, conditions: j.conditions, viaForeignKey: true });
      added.push(j.key);
    }
    if (added.length) {
      model.joins = joins;
      autoJoined = [...autoJoined, ...added];
    }
  }
  let autoJoined = $state([]);

  function toggleColumn(tableId, column) {
    const on = model.select.some((s) => s.tableId === tableId && s.column === column);
    model.select = on
      ? model.select.filter((s) => !(s.tableId === tableId && s.column === column))
      : [...model.select, { tableId, column }];
  }

  // Result filtering: one global needle plus an optional needle per column.
  // Applied before paging, so the page count reflects what you can see.
  let globalFilter = $state("");
  let columnFilters = $state({});
  let exportNote = $state(null);
  let exportKind = $state(null);
  $effect(() => {
    if (exportKind) exportCurrent();
  });

  const activeColumnFilters = $derived(
    Object.entries(columnFilters).filter(([i, v]) => v && v.trim() !== ""),
  );

  const filteredRows = $derived.by(() => {
    if (!result) return [];
    const global = globalFilter.trim().toLowerCase();
    if (!global && activeColumnFilters.length === 0) return result.rows;
    return result.rows.filter((row) => {
      if (global && !row.some((cell) => String(cell ?? "").toLowerCase().includes(global))) return false;
      for (const [index, needle] of activeColumnFilters) {
        const value = String(row[Number(index)] ?? "").toLowerCase();
        if (!value.includes(needle.trim().toLowerCase())) return false;
      }
      return true;
    });
  });

  function setColumnFilter(index, value) {
    columnFilters = { ...columnFilters, [index]: value };
    page = 1;
  }
  function clearFilters() {
    globalFilter = "";
    columnFilters = {};
    page = 1;
  }
  function tableName(id) {
    return model.tables.find((t) => t.id === id)?.name ?? "";
  }
  function columnsOf(tableId) {
    const table = model.tables.find((t) => t.id === tableId);
    return table?.columns ?? [];
  }

  async function init() {
    // Grab the bridge first. Without this, `plugin.ready` throws on null and an
    // unhandled rejection in $effect leaves the UI silently empty.
    plugin = window.dbxPlugin;
    status = { ...status, error: null };
    try {
      await plugin.ready;
    } catch (error) {
      status = { ...status, error: `dbxPlugin.ready: ${String(error)}` };
      banner = { kind: "error", text: "DBX never finished initialising the plugin." };
      return;
    }
    const ctx = plugin.context ?? {};
    // Gate 1 result: the host hands us exactly this, and nothing more.
    // A table context-menu invocation also carries `database` and `table`;
    // a connection one carries `database: ""` and no table.
    connectionId = ctx.connectionId ?? ctx.id ?? null;
    dbType = ctx.dbType ?? null;
    ctxDatabase = ctx.database || "";
    ctxTable = ctx.table || null;
    dbName = ctx.database || "";
    // A table context carries no dbType; listDatabases() learns it from the
    // first queryData response and writes it back onto the bridge object.
    plugin.dialect = dbType;

    if (!connectionId) {
      status = { ...status, opened: "none", error: "no connectionId in context" };
      banner = {
        kind: "error",
        text: "No connection in the workbench context. Right-click a table in the sidebar, or a connection, and pick Visual Query Builder.",
      };
      return;
    }
    status = { ...status, connection: true, opened: ctxTable ? `table:${ctxTable}` : ctxDatabase ? `db:${ctxDatabase}` : "connection" };
    if (!hasData) {
      banner = { kind: "error", text: "This DBX host has no data API, so queries cannot run." };
      return;
    }

    try {
      databases = await listDatabases(plugin, connectionId);
      status = { ...status, dbs: databases.length };
    } catch (error) {
      status = { ...status, error: `listDatabases: ${error.message}` };
      banner = { kind: "error", text: `Cannot list databases: ${error.message}` };
      return;
    }

    if (!dbName) {
      // No database in context: the user opened us from a connection, so they
      // must pick one. Skipping the system schemas gets them a useful default.
      dbName = databases.find((d) => !/^(information_schema|mysql|performance_schema|sys)$/i.test(d)) ?? "";
    }
    if (!dbName) {
      banner = { kind: "error", text: "This connection exposes no usable database. Right-click a table instead." };
      return;
    }
    await loadDatabase(dbName);
    // listDatabases may have learned the dialect from the response.
    dbType = plugin.dialect ?? dbType;

    // Opening from a table means the user already named one: add it for them.
    if (ctxTable) await addTable(ctxTable);
  }

  async function loadDatabase(name) {
    if (!name) return;
    dbName = name;
    busy = true;
    result = null;
    try {
      tables = await listTables(plugin, connectionId, name);
      foreignKeys = await listForeignKeys(plugin, connectionId, name);
      status = { ...status, tables: tables.length, fks: foreignKeys.length, error: null };
    } catch (error) {
      status = { ...status, error: `loadDatabase(${name}): ${error.message}` };
      banner = { kind: "error", text: error.message };
    } finally {
      busy = false;
    }
  }

  async function addTable(name) {
    if (model.tables.some((t) => t.name === name)) return;
    busy = true;
    let columns = [];
    try {
      columns = await listColumns(plugin, connectionId, dbName, name);
    } catch (error) {
      banner = { kind: "warn", text: `Columns for ${name} unavailable: ${error.message}` };
    }
    model.tables = [...model.tables, { id: `t${model.tables.length + 1}`, name, columns }];
    autoJoin();
    busy = false;
  }

  function removeTable(id) {
    const gone = model.tables.find((t) => t.id === id);
    if (!gone) return;
    model.tables = model.tables.filter((t) => t.id !== id);
    // Never leave a dangling reference: a removed table must take its
    // SELECT / WHERE / ORDER rows with it, not silently read a different table.
    model.select = model.select.filter((s) => s.tableId !== id);
    model.filters = model.filters.filter((f) => f.tableId !== id);
    model.groupBy = model.groupBy.filter((g) => g.tableId !== id);
    model.orderBy = model.orderBy.filter((o) => o.tableId !== id);
    model.joins = model.joins.filter((j) => j.leftTableId !== id && j.rightTableId !== id);
    autoJoined = [];
  }

  // The host caps maxRows at 5000, so ask for the ceiling and page locally.
  // Querying the DB again per page would re-run the whole query anyway.
  const HOST_MAX_ROWS = 5000;

  async function run() {
    if (!canRun) return;
    running = true;
    result = null;
    banner = null;
    page = 1;
    globalFilter = "";
    columnFilters = {};
    try {
      result = await plugin.queryData({
        connectionId,
        database: dbName,
        sql: runnableSql,
        maxRows: HOST_MAX_ROWS,
      });
      panelView = "results";
      colWidths = {};
      detailRow = null;
    } catch (error) {
      banner = { kind: "error", text: error.message };
    } finally {
      running = false;
    }
  }

  function toBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // The host runs the native save dialog, so the bytes never touch a blob
  // navigation (which the sandboxed webview cancels). Base64 keeps us off the
  // binary-transfer path, which would need an extra host permission.
  async function writeFile(fileName, contentType, bytes) {
    if (!plugin?.saveFile) {
      exportNote = "This DBX host cannot save files from a plugin.";
      return false;
    }
    try {
      const saved = await plugin.saveFile({ fileName, contentType }, toBase64(bytes));
      exportNote = saved?.path ? `Saved to ${saved.path}` : "Save cancelled.";
      return !!saved;
    } catch (error) {
      exportNote = `Export failed: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  const safeStamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  async function exportCsv() {
    if (!result) return;
    await writeFile(`vqb-result-${safeStamp()}.csv`, "text/csv", enc.encode(toCsv(result.columns, filteredRows)));
  }

  async function exportXlsx() {
    if (!result) return;
    await writeFile(
      `vqb-result-${safeStamp()}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      toXlsx(result.columns, filteredRows),
    );
  }

  async function exportPdf() {
    if (!result) return;
    const { bytes, lost, pages } = toPdf(result.columns, filteredRows, { title: `VQB result - ${dbName}` });
    // Base-14 Helvetica with no embedded font is WinAnsi only. Say so rather
    // than handing back a file full of "?" and calling it a success.
    if (lost > 0) {
      const proceed = `Some characters cannot be encoded in PDF and will appear as "?" (${lost} characters). Continue?`;
      if (!window.confirm(proceed)) return;
    }
    await writeFile(`vqb-result-${safeStamp()}.pdf`, "application/pdf", bytes);
    exportNote = `PDF: ${pages} page${pages === 1 ? "" : "s"}${lost ? `, ${lost} character(s) replaced with "?"` : ""}.`;
  }

  async function exportCurrent() {
    const kind = exportKind;
    exportKind = null;
    if (kind === "csv") return exportCsv();
    if (kind === "xlsx") return exportXlsx();
    if (kind === "pdf") return exportPdf();
  }

  // window.print() is unreliable inside the sandboxed workbench iframe, so
  // Print hands the user a standalone HTML file instead. Same for the results.
  async function exportPrint() {
    if (!result) return;
    const html = tableHtml({
      columns: result.columns,
      labels: resultLabels,
      rows: filteredRows,
      sql: sql.replace(/;\s*$/, ""),
      title: `VQB result - ${dbName}`,
    });
    await writeFile(`vqb-result-${safeStamp()}.html`, "text/html", enc.encode(html));
  }

  // Diagram print: window.print() is unreliable in the sandboxed iframe, so we
  // hand over a standalone HTML file. Opening it gives a real print dialog.
  async function printDiagram() {
    if (model.tables.length === 0) return;
    const byName = new Map(model.tables.map((t) => [t.name, t]));
    const edges = foreignKeys.flatMap((fk) => {
      const child = byName.get(fk.table);
      const parent = byName.get(fk.refTable);
      if (!child || !parent || child.id === parent.id) return [];
      return [{ child, parent, from: "1", to: "N" }];
    });
    const html = diagramHtml({
      tables: model.tables,
      pos,
      edges,
      title: `DBX Visual Query Builder - ${dbName}`,
    });
    await writeFile(`vqb-diagram-${safeStamp()}.html`, "text/html", enc.encode(html));
  }

  async function copySql() {
    if (plugin.capabilities?.clipboardWrite) await plugin.clipboard.writeText(sql);
    else banner = { kind: "warn", text: "Clipboard is not available on this host." };
  }

  // Escape closes the row-detail dialog.
  $effect(() => {
    if (!detailRow) return;
    const onKey = (event) => {
      if (event.key === "Escape") detailRow = null;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Guarded: init() writes state, and an unguarded $effect that writes state
  // re-runs itself on every assignment. The try/catch matters as much as the
  // guard -- a rejected init must surface in the status line, not vanish.
  let started = false;
  $effect(() => {
    if (started) return;
    started = true;
    init().catch((error) => {
      status = { ...status, error: `init: ${error instanceof Error ? error.message : String(error)}` };
      banner = { kind: "error", text: "Startup failed. See the status line below the header." };
    });
  });
</script>

<main class:resizing bind:this={mainEl}>
  <header>
    <div class="title">
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
        <ellipse cx="12" cy="6" rx="7.5" ry="3" />
        <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
        <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
      </svg>
      <span class="brand">Visual Query Builder</span>
      <span class="by">ardith666</span>
      <span class="conn">{dbName || "no database"}{ctxDatabase ? " · from sidebar" : ""}</span>
    </div>
    <div class="actions">
      <select
        value={dbName}
        onchange={(e) => loadDatabase(e.currentTarget.value)}
        disabled={busy || databases.length === 0}
        aria-label="Database"
      >
        {#each databases as d (d)}<option value={d} selected={d === dbName}>{d}</option>{/each}
      </select>
      <button type="button" onclick={copySql} disabled={!plugin?.capabilities?.clipboardWrite}>Copy SQL</button>
      <button type="button" class="run" onclick={run} disabled={!canRun}>
        {running ? "Running…" : "Run SELECT"}
      </button>
    </div>
  </header>

  {#if banner}
    <p class="banner {banner.kind}">{banner.text}</p>
  {/if}

  <p class="status" title="Open this panel and copy the line when reporting a problem.">
    <span>{status.opened ?? "…"}</span>
    <span>conn {status.connection ? "ok" : "no"}</span>
    <span>db {status.dbs}</span>
    <span>tables {status.tables}</span>
    <span>fk {status.fks}</span>
    {#if status.error}<span class="err">{status.error}</span>{/if}
  </p>

  <div class="body">
  <aside>
    <input type="search" placeholder="Filter tables" bind:value={search} />
    <p class="hint">Click a table to add it. Right-click a table in DBX to start here with it.</p>
    <ul>
      {#each tables.filter((t) => !search || t.name.toLowerCase().includes(search.toLowerCase())) as t (t.name)}
        <li>
          <button type="button" onclick={() => addTable(t.name)} disabled={busy || model.tables.some((m) => m.name === t.name)}>
            {t.name}
          </button>
        </li>
      {:else}
        <li class="empty">{tables.length ? "No match." : busy ? "Loading…" : "No tables."}</li>
      {/each}
    </ul>
  </aside>

    <section>
      {#if model.tables.length === 0}
        <div class="empty-state">
          <h2>No tables yet</h2>
          <p>Pick a database above, then click a table on the left to start building a query.</p>
        </div>
      {:else}
        <div class="tabs">
          <button type="button" class:active={view === "diagram"} onclick={() => (view = "diagram")}>Diagram</button>
          {#each ["select", "join", "where", "order"] as t (t)}
            <button type="button" class:active={view === "grid" && tab === t} onclick={() => { view = "grid"; tab = t; }}>
              {t === "select" ? "Columns" : t === "join" ? "Joins" : t === "where" ? "Where" : "Order / Limit"}
            </button>
          {/each}
        </div>

        {#if autoJoined.length}
          <p class="autojoin">Auto-joined from foreign keys: {autoJoined.join(", ")}</p>
        {/if}

        <div class="grid-wrap" class:diagram={view === "diagram"}>
          {#if view === "diagram"}
            <Diagram {model} {foreignKeys} onselect={toggleColumn} onremove={removeTable} onprint={printDiagram} bind:pos bind:zoom />
          {:else if tab === "select"}
            <table class="grid">
              <thead><tr><th></th><th>Table</th><th>Column</th><th>Alias</th><th>Aggregate</th></tr></thead>
              <tbody>
                {#each model.select as item, i (i)}
                  <tr>
                    <td><input type="checkbox" checked onchange={() => (model.select = model.select.filter((_, n) => n !== i))} /></td>
                    <td>{tableName(item.tableId)}</td>
                    <td>{item.column}</td>
                    <td><input value={item.alias ?? ""} placeholder="—" oninput={(e) => (model.select[i].alias = e.currentTarget.value || undefined)} /></td>
                    <td>{item.aggregate ?? "—"}</td>
                  </tr>
                {:else}
                  <tr><td colspan="5" class="empty">Tick columns from the tables below to add them to SELECT.</td></tr>
                {/each}
              </tbody>
            </table>
            <div class="picker">
              {#each model.tables as t (t.id)}
                <div>
                  <h3>{t.name}</h3>
                  {#each t.columns as c (c.name)}
                    <label>
                      <input
                        type="checkbox"
                        checked={model.select.some((s) => s.tableId === t.id && s.column === c.name)}
                        onchange={(e) => {
                          model.select = e.currentTarget.checked
                            ? [...model.select, { tableId: t.id, column: c.name }]
                            : model.select.filter((s) => !(s.tableId === t.id && s.column === c.name));
                        }}
                      />
                      <span>{c.name}</span>
                      <em>{c.dataType}</em>
                    </label>
                  {/each}
                </div>
              {/each}
            </div>
          {:else if tab === "join"}
            {#if pendingJoins.length}
              <div class="suggest">
                <h3>Foreign keys not joined yet</h3>
                {#each pendingJoins as s (s.key)}
                  <button type="button" onclick={() => (model.joins = [...model.joins, { id: `j${model.joins.length + 1}`, ...s }])}>Add {s.key}</button>
                {/each}
              </div>
            {/if}
            <table class="grid">
              <thead><tr><th>Type</th><th>Left</th><th>Right</th><th>On</th><th></th></tr></thead>
              <tbody>
                {#each model.joins as j, i (i)}
                  <tr>
                    <td>
                      <select value={j.type} onchange={(e) => (model.joins[i].type = e.currentTarget.value)}>
                        {#each JOINS as t (t)}<option value={t}>{t}</option>{/each}
                      </select>
                    </td>
                    <td>{tableName(j.leftTableId)}</td>
                    <td>{tableName(j.rightTableId)}</td>
                    <td class="mono">
                      {#each j.conditions as c, n (n)}{tableName(j.leftTableId)}.{c.leftColumn} = {tableName(j.rightTableId)}.{c.rightColumn}{/each}
                    </td>
                    <td><button type="button" onclick={() => (model.joins = model.joins.filter((_, m) => m !== i))}>Remove</button></td>
                  </tr>
                {:else}
                  <tr><td colspan="5" class="empty">No joins. Add a second table, then use a foreign-key suggestion.</td></tr>
                {/each}
              </tbody>
            </table>
          {:else if tab === "where"}
            <table class="grid">
              <thead><tr><th>Table</th><th>Column</th><th>Operator</th><th>Value</th><th></th></tr></thead>
              <tbody>
                {#each model.filters as f, i (i)}
                  <tr>
                    <td>{tableName(f.tableId)}</td>
                    <td>{f.column}</td>
                    <td>
                      <select value={f.operator} onchange={(e) => (model.filters[i].operator = e.currentTarget.value)}>
                        {#each OPERATORS as o (o)}<option value={o}>{o}</option>{/each}
                      </select>
                    </td>
                    <td>
                      {#if f.operator !== "IS NULL" && f.operator !== "IS NOT NULL"}
                        <input
                          value={Array.isArray(f.value) ? f.value.join(", ") : (f.value ?? "")}
                          placeholder={f.operator === "IN" || f.operator === "NOT IN" ? "comma separated" : f.operator === "BETWEEN" ? "min, max" : "value"}
                          oninput={(e) => (model.filters[i].value = coerce(e.currentTarget.value))}
                        />
                      {:else}—{/if}
                    </td>
                    <td><button type="button" onclick={() => (model.filters = model.filters.filter((_, m) => m !== i))}>Remove</button></td>
                  </tr>
                {:else}
                  <tr><td colspan="5" class="empty">No filters yet. Pick a column below to add one.</td></tr>
                {/each}
              </tbody>
            </table>
            <div class="picker">
              {#each model.tables as t (t.id)}
                <div>
                  <h3>{t.name}</h3>
                  {#each t.columns as c (c.name)}
                    <button type="button" onclick={() => (model.filters = [...model.filters, { tableId: t.id, column: c.name, operator: "=", value: "", connector: model.filters.length ? "AND" : undefined }])}>
                      <span>{c.name}</span>
                    </button>
                  {/each}
                </div>
              {/each}
            </div>
          {:else}
            <table class="grid">
              <thead><tr><th>Table</th><th>Column</th><th>Direction</th><th></th></tr></thead>
              <tbody>
                {#each model.orderBy as o, i (i)}
                  <tr>
                    <td>{tableName(o.tableId)}</td>
                    <td>{o.column}</td>
                    <td>
                      <select value={o.direction} onchange={(e) => (model.orderBy[i].direction = e.currentTarget.value)}>
                        <option value="ASC">ASC</option><option value="DESC">DESC</option>
                      </select>
                    </td>
                    <td><button type="button" onclick={() => (model.orderBy = model.orderBy.filter((_, m) => m !== i))}>Remove</button></td>
                  </tr>
                {:else}
                  <tr><td colspan="4" class="empty">No sorting yet. Pick a column below.</td></tr>
                {/each}
              </tbody>
            </table>
            <div class="picker">
              {#each model.tables as t (t.id)}
                <div>
                  <h3>{t.name}</h3>
                  {#each t.columns as c (c.name)}
                    <button type="button" onclick={() => (model.orderBy = [...model.orderBy, { tableId: t.id, column: c.name, direction: "ASC" }])}>
                      <span>{c.name}</span>
                    </button>
                  {/each}
                </div>
              {/each}
            </div>
            <div class="limit">
              <label>
                Limit
                <input
                  type="number"
                  min="0"
                  max={HOST_MAX_ROWS}
                  value={model.limit ?? ""}
                  placeholder="no limit"
                  oninput={(e) => (model.limit = clampLimit(e.currentTarget.value, HOST_MAX_ROWS))}
                />
              </label>
              <span class="hint">
                {model.limit ? `${model.limit} rows — raise it only if you need more.` : "No LIMIT. The host still returns at most 5000 rows."}
              </span>
            </div>
          {/if}
        </div>

        <div class="selected">
          {#each model.tables as t (t.id)}
            <span>{t.name}<button type="button" onclick={() => removeTable(t.id)} aria-label="Remove {t.name}">×</button></span>
          {/each}
        </div>
      {/if}
    </section>
  </div>

  <button
    type="button"
    class="splitter"
    class:active={resizing}
    aria-label="Resize SQL panel. Use arrow keys to adjust."
    title="Drag to resize. Arrow keys also work."
    onmousedown={startResize}
    onkeydown={nudge}
  ></button>

  <footer style:height="{panelH}px">
    <div class="tabs small">
      <button type="button" class:active={panelView === "sql"} onclick={() => (panelView = "sql")}>SQL</button>
      <button
        type="button"
        class:active={panelView === "results"}
        disabled={!result}
        onclick={() => (panelView = "results")}
      >
        Results{result ? ` (${result.rows.length}${result.truncated ? "+" : ""})` : ""}
      </button>
    </div>
    {#if panelView === "results" && result}
      <div class="results">
        <div class="filterbar">
          <input
            type="search"
            class="global"
            placeholder="Filter all columns…"
            value={globalFilter}
            oninput={(e) => { globalFilter = e.currentTarget.value; page = 1; }}
            aria-label="Filter all columns"
          />
          {#if filtering}
            <button type="button" class="clear" onclick={clearFilters}>Clear filter</button>
          {/if}
          <span class="sep"></span>
          <span class="exlbl">Export</span>
          <button type="button" onclick={() => (exportKind = "csv")} disabled={!result || totalRows === 0}>CSV</button>
          <button type="button" onclick={() => (exportKind = "xlsx")} disabled={!result || totalRows === 0}>Excel</button>
          <button type="button" onclick={() => (exportKind = "pdf")} disabled={!result || totalRows === 0}>PDF</button>
          <button type="button" onclick={exportPrint} disabled={!result || totalRows === 0} title="Saves a printable PDF through the host dialog">Print</button>
        </div>
        {#if exportNote}<p class="exportnote">{exportNote}</p>{/if}
        <div class="pager">
          <button type="button" onclick={() => goPage(-1)} disabled={page <= 1} aria-label="Previous page">‹</button>
          <span class="pageinfo">
{pg.label}
          </span>
          <button type="button" onclick={() => goPage(1)} disabled={page >= pageCount} aria-label="Next page">›</button>
          <label class="sizepick">
            rows
            <select value={pageSize} onchange={(e) => setPageSize(e.currentTarget.value)}>
              {#each PAGE_SIZES as n (n)}<option value={n} selected={n === pageSize}>{pageSizeLabel(n)}</option>{/each}
            </select>
          </label>
          <span class="meta">
            page {page}/{pageCount} · {result.elapsedMs} ms{result.truncated ? " · host truncated the result" : ""}
          </span>
        </div>
        {#if result.truncated}
          <p class="banner warn">
            The host cut the result at {HOST_MAX_ROWS} rows, so this is not the whole result set. Add a LIMIT or a filter to narrow the query.
          </p>
        {/if}
        <table>
          <thead>
            <tr>
              <th class="gutter" title="Row detail"></th>
              {#each result.columns as c, i (i)}
                <th title={c.name} style:width="{colWidths[i]}px">
                  <span class="hlabel">{resultLabels[i] ?? c.name}<em>{c.dataType ?? ""}</em></span>
                  <button
                    type="button"
                    class="grip"
                    title="Drag to resize, or use arrow keys"
                    aria-label="Resize column {c.name}"
                    onmousedown={(e) => startResizeCol(e, i)}
                    onkeydown={(e) => nudgeWidth(e, i)}
                  ></button>
                </th>
              {/each}
            </tr>
            <tr class="colfilter">
              <th class="gutter"></th>
              {#each result.columns as c, i (i)}
                <th>
                  <input
                    type="search"
                    value={columnFilters[i] ?? ""}
                    placeholder="filter"
                    aria-label="Filter {c.name}"
                    oninput={(e) => setColumnFilter(i, e.currentTarget.value)}
                  />
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each pageRows as row, i (i)}
              <tr>
                <td class="gutter">
                  <button
                    type="button"
                    class="eye"
                    title="Row detail"
                    aria-label="Show row detail"
                    onclick={() => (detailRow = { row, absolute: pageStart + i + 1 })}
                  >◎</button>
                </td>
                {#each row as cell, n (n)}
                  {@const pretty = prettyCell(cell)}
                  <td class={pretty.cls} title={pretty.text}>{pretty.text}</td>
                {/each}
              </tr>
            {:else}
              <tr><td colspan={(result.columns.length ?? 0) + 1} class="null">No rows.</td></tr>
            {/each}
          </tbody>
        </table>
        {#if Object.keys(colWidths).length}
          <div class="resetbar"><button type="button" onclick={resetWidths}>Reset column widths</button></div>
        {/if}
      </div>
    {:else if editingSql}
      <div class="editor">
        <p class="hint">Editing the SQL by hand. Nothing runs until you save.</p>
        <textarea bind:value={manualSql} spellcheck="false" aria-label="SQL editor"></textarea>
        <div class="editorbar">
          <button type="button" class="save" onclick={stopEdit} disabled={manualSql.trim() === ""}>Save</button>
          <button type="button" onclick={cancelEdit}>Cancel</button>
          {#if sqlEdited}<span class="edited">saved — this text is what runs</span>{/if}
        </div>
      </div>
    {:else}
      <div class="sqlwrap">
        <div class="sqlbtns">
          <button type="button" class="editbtn" onclick={startEdit}>Edit</button>
          {#if sqlEdited}
            <button type="button" class="revert" onclick={cancelEdit} title="Discard your edit and go back to the generated SQL">Back to generated</button>
          {/if}
        </div>
        {#if sqlEdited}<p class="editednote">modified — this SQL is what runs</p>{/if}
        <pre class="sql">{sqlEdited ? manualSql : sql}</pre>
      </div>
    {/if}
  </footer>
  {#if detailRow}
    <div class="modal" role="dialog" aria-modal="true" aria-label="Row detail">
      <button type="button" class="backdrop" aria-label="Close row detail" onclick={() => (detailRow = null)}></button>
      <div class="sheet">
        <header>
          <strong>Row {detailRow.absolute}</strong>
          <button type="button" onclick={() => (detailRow = null)} aria-label="Close">×</button>
        </header>
        <dl>
          {#each detailRow.row as cell, n (n)}
            {@const pretty = prettyCell(cell)}
            <dt title={result.columns[n]?.name}>{resultLabels[n] ?? result.columns[n]?.name ?? `column ${n + 1}`}<em>{result.columns[n]?.dataType ?? ""}</em></dt>
            <dd class={pretty.cls}>{pretty.text}</dd>
          {/each}
        </dl>
      </div>
    </div>
  {/if}
</main>

<script module>
  function coerce(raw) {
    const text = String(raw).trim();
    if (text === "") return "";
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    return text;
  }
</script>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    height: 100vh;
    overflow: hidden;
    font: 12px/1.5 ui-sans-serif, system-ui, sans-serif;
    /* System colors, not --color-*: guaranteed opaque and theme-aware without
       depending on which tokens this DBX version happens to define. */
    background: Canvas;
    color: CanvasText;
  }
  main { display: flex; flex-direction: column; height: 100vh; }
  main > .body { flex: 1 1 auto; min-height: 0; }
  main.resizing { cursor: row-resize; user-select: none; }
  @media print {
    /* Print the SQL and the diagram; the sidebar, chrome and results grid are
       noise on paper. Save-as-PDF comes free from the print dialog. */
    header, aside, .status, .tabs.small, .splitter, .selected, .results { display: none !important; }
    main { display: block; height: auto; }
    .body, .grid-wrap, .canvas { display: block; overflow: visible; height: auto; }
    footer { display: block; height: auto; border: 0; }
    .card { position: static; box-shadow: none; page-break-inside: avoid; margin-bottom: 8px; }
    .stage { position: static; transform: none !important; }
    .sql { white-space: pre-wrap; border: 0; }
  }

  .splitter {
    background: color-mix(in srgb, CanvasText 10%, Canvas);
    border: 0; padding: 0; cursor: row-resize; width: 100%; position: relative;
  }
  /* A visible grip, so the 9px target is findable without hunting. */
  .splitter::after {
    content: ""; position: absolute; inset: 0; margin: auto;
    width: 44px; height: 2px; border-radius: 2px;
    background: color-mix(in srgb, CanvasText 32%, Canvas);
  }
  .splitter:hover, .splitter:focus-visible, .splitter.active { background: color-mix(in srgb, LinkText 30%, Canvas); }
  .splitter:focus-visible { outline: 2px solid LinkText; outline-offset: -2px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--color-border, #e4e4e7); }
  .title { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .mark { width: 17px; height: 17px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.6; }
  .brand { font-weight: 600; white-space: nowrap; }
  .by { color: GrayText; font-size: 11px; white-space: nowrap; }
  .by::before { content: "("; }
  .by::after { content: ")"; }
  .conn {
    color: GrayText; font-family: ui-monospace, monospace; font-size: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .actions { display: flex; gap: 6px; }
  .banner { margin: 0; padding: 6px 12px; font-size: 12px; }
  .banner.error { background: color-mix(in srgb, #dc2626 12%, transparent); color: #b91c1c; }
  .banner.warn { background: color-mix(in srgb, #d97706 14%, transparent); color: #a16207; }
  .status {
    display: flex; gap: 10px; flex-wrap: wrap; margin: 0; padding: 3px 12px;
    font-family: ui-monospace, monospace; font-size: 10px;
    color: var(--color-muted-foreground, #71717a);
    border-bottom: 1px solid var(--color-border, #e4e4e7);
  }
  .status .err { color: #b91c1c; }
  .body { display: grid; grid-template-columns: 220px 1fr; }
  aside { border-right: 1px solid var(--color-border, #e4e4e7); padding: 8px; overflow: auto; }
  aside ul { list-style: none; margin: 4px 0 0; padding: 0; }
  aside li button { width: 100%; text-align: left; border: 0; background: none; padding: 3px 6px; border-radius: 4px; cursor: pointer; color: inherit; font: inherit; }
  aside li button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 8%, transparent); }
  aside li button:disabled { opacity: .45; cursor: default; }
  .empty, .hint { color: var(--color-muted-foreground, #71717a); }
  .hint { margin: 6px 0; font-size: 11px; }
  /* Flex, not grid: the auto-join banner appears and disappears, and a fixed
     grid-template-rows would hand 1fr to the wrong child when it is absent. */
  section { display: flex; flex-direction: column; min-height: 0; }
  section > .tabs, section > .autojoin, section > .selected { flex: 0 0 auto; }
  .grid-wrap { flex: 1 1 auto; }
  .empty-state { display: grid; place-content: center; text-align: center; color: var(--color-muted-foreground, #71717a); }
  .empty-state h2 { margin: 0 0 4px; font-size: 15px; }
  .tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--color-border, #e4e4e7); }
  .tabs button { border: 1px solid transparent; border-bottom: 0; background: none; padding: 5px 10px; border-radius: 5px 5px 0 0; cursor: pointer; color: var(--color-muted-foreground, #71717a); font: inherit; }
  .tabs button.active { border-color: var(--color-border, #e4e4e7); background: Canvas; color: CanvasText; font-weight: 600; }
  .grid-wrap { overflow: auto; padding: 8px; min-height: 0; }
  .grid-wrap.diagram { padding: 0; overflow: hidden; }
  .autojoin {
    margin: 0; padding: 4px 10px; font-size: 11px;
    background: color-mix(in srgb, #16a34a 12%, transparent); color: #15803d;
  }
  .grid { border-collapse: collapse; width: 100%; margin-bottom: 10px; background: Canvas; }
  .grid th, .grid td { border: 1px solid var(--color-border, #e4e4e7); padding: 4px 7px; text-align: left; }
  .grid th { font-weight: 600; color: CanvasText; background: color-mix(in srgb, CanvasText 7%, Canvas); }
  .grid td.empty { color: GrayText; text-align: center; padding: 12px 8px; }
  .grid tr:hover td:not(.empty) { background: color-mix(in srgb, LinkText 6%, Canvas); }
  .mono { font-family: ui-monospace, monospace; }
  /* Each table becomes its own bordered card with a header bar, and rows are
     separated, so the column lists read as tables rather than loose links. */
  .picker { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; align-items: start; }
  .picker > div {
    border: 1px solid var(--color-border, #e4e4e7);
    border-radius: 7px; overflow: hidden; background: Canvas;
  }
  .picker h3 {
    margin: 0; padding: 5px 8px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .04em;
    color: CanvasText; background: color-mix(in srgb, CanvasText 7%, Canvas);
    border-bottom: 1px solid var(--color-border, #e4e4e7);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .picker label, .picker button {
    display: flex; align-items: center; gap: 6px;
    width: 100%; box-sizing: border-box; padding: 3px 8px;
    border: 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, Canvas);
    background: none; cursor: pointer; font: inherit; color: CanvasText; text-align: left;
  }
  .picker > div > :last-child { border-bottom: 0; }
  .picker label:hover, .picker button:hover { background: color-mix(in srgb, LinkText 10%, Canvas); }
  .picker em { margin-left: auto; font-size: 10px; font-style: normal; color: GrayText; }
  .picker label span, .picker button span { font-family: ui-monospace, monospace; font-size: 11px; }
  .suggest { margin-bottom: 10px; padding: 6px 8px; border: 1px dashed var(--color-border, #e4e4e7); border-radius: 6px; }
  .suggest h3 { margin: 0 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--color-muted-foreground, #71717a); }
  .suggest button { border: 1px solid var(--color-border, #e4e4e7); background: none; border-radius: 5px; padding: 3px 8px; margin-right: 4px; cursor: pointer; font: inherit; color: inherit; }
  .selected { display: flex; gap: 4px; flex-wrap: wrap; padding: 6px 8px; border-top: 1px solid var(--color-border, #e4e4e7); }
  .selected span { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; border-radius: 999px; background: color-mix(in srgb, currentColor 8%, transparent); font-family: ui-monospace, monospace; }
  .selected button { border: 0; background: none; cursor: pointer; color: inherit; font: inherit; line-height: 1; padding: 0 2px; }
  .limit { margin-top: 10px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .limit label { display: inline-flex; align-items: center; gap: 6px; }
  .limit input { width: 96px; }
  footer { background: Canvas; color: CanvasText; display: grid; grid-template-rows: auto 1fr; min-height: 0; overflow: hidden; }
  .tabs.small { padding: 4px 8px 0; }
  .sql { margin: 0; padding: 8px 12px; overflow: auto; min-height: 0; background: Canvas; color: CanvasText; font-family: ui-monospace, monospace; font-size: 11px; white-space: pre-wrap; word-break: break-word; }
  .filterbar {
    position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding: 5px 0; background: Canvas; border-bottom: 1px solid var(--color-border, #e4e4e7);
  }
  .filterbar .global { min-width: 200px; }
  .filterbar .clear { border: 0; background: none; color: LinkText; cursor: pointer; font: inherit; font-size: 11px; }
  .filterbar .sep { flex: 0 0 1px; height: 16px; background: var(--color-border, #e4e4e7); margin: 0 4px; }
  .exlbl { font-size: 11px; color: GrayText; }
  .filterbar button:not(.clear) {
    border: 1px solid var(--color-border, #e4e4e7); background: Canvas; color: CanvasText;
    border-radius: 5px; padding: 2px 9px; cursor: pointer; font: inherit; font-size: 11px;
  }
  .filterbar button:disabled { opacity: .4; cursor: default; }
  .exportnote { margin: 4px 0 0; font-size: 11px; color: GrayText; }
  .results thead tr.colfilter th { padding: 2px 4px; }
  .results thead tr.colfilter input { width: 100%; min-width: 60px; padding: 2px 4px; font-size: 11px; }
  .results th { position: relative; }
  .hlabel { display: block; padding-right: 10px; }
  .grip {
    position: absolute; top: 0; right: -3px; width: 7px; height: 100%;
    border: 0; padding: 0; background: none; cursor: col-resize; z-index: 1;
  }
  .grip:hover, .grip:focus-visible { background: color-mix(in srgb, LinkText 40%, Canvas); outline: none; }
  .gutter { width: 1%; white-space: nowrap; padding: 2px 4px !important; }
  .eye {
    border: 0; background: none; cursor: pointer;
    /* Blue so it reads as an action at a glance, not as body text. */
    color: color-mix(in srgb, LinkText 80%, Canvas);
    font: inherit; font-size: 13px; line-height: 1; padding: 0 3px;
  }
  .eye:hover, .eye:focus-visible {
    color: Canvas;
    background: LinkText;
    border-radius: 4px;
  }
  .resetbar { padding: 4px 0 0; }
  .resetbar button { border: 1px solid var(--color-border, #e4e4e7); background: Canvas; color: CanvasText; border-radius: 5px; padding: 1px 8px; font: inherit; font-size: 11px; cursor: pointer; }

  .sqlwrap { position: relative; display: flex; flex-direction: column; min-height: 0; }
  .sqlbtns { position: absolute; top: 4px; right: 6px; z-index: 2; display: flex; gap: 5px; }
  .editbtn, .revert {
    border: 1px solid var(--color-border, #e4e4e7); background: Canvas; color: CanvasText;
    border-radius: 5px; padding: 1px 9px; font: inherit; font-size: 11px; cursor: pointer;
  }
  .revert { border-color: color-mix(in srgb, #d97706 50%, Canvas); color: #a16207; }
  .editednote {
    position: absolute; top: 6px; right: 96px; margin: 0; z-index: 1;
    font-size: 11px; color: #a16207; background: Canvas; padding: 0 4px;
  }
  .editor { display: flex; flex-direction: column; min-height: 0; gap: 4px; padding: 0 8px 8px; }
  .editor textarea {
    flex: 1 1 auto; min-height: 0; resize: none; width: 100%;
    font: 11px/1.45 ui-monospace, monospace; padding: 8px;
    background: Canvas; color: CanvasText;
    border: 1px solid var(--color-border, #e4e4e7); border-radius: 6px;
  }
  .editorbar { display: flex; align-items: center; gap: 8px; }
  .editorbar button {
    border: 1px solid var(--color-border, #e4e4e7); background: Canvas; color: CanvasText;
    border-radius: 5px; padding: 2px 9px; font: inherit; font-size: 11px; cursor: pointer;
  }
  .editorbar button.save { border-color: transparent; background: LinkText; color: Canvas; }
  .editorbar button:disabled { opacity: .45; cursor: default; }

  .modal {
    position: fixed; inset: 0; z-index: 20; display: grid; place-items: center;
  }
  .backdrop { position: absolute; inset: 0; border: 0; padding: 0; cursor: pointer; background: color-mix(in srgb, CanvasText 35%, transparent); }
  .sheet {
    /* Must be positioned: the absolutely-positioned backdrop otherwise paints
       on top of the dialog and darkens the whole sheet. */
    position: relative;
    z-index: 1;
    background: Canvas; color: CanvasText; border: 1px solid var(--color-border, #e4e4e7);
    border-radius: 10px; min-width: min(560px, 92vw); max-width: 92vw;
    max-height: 82vh; display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 18px 48px rgb(0 0 0 / .3);
  }
  .sheet header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; border-bottom: 1px solid var(--color-border, #e4e4e7);
  }
  .sheet header button { border: 0; background: none; color: inherit; font: inherit; font-size: 16px; line-height: 1; cursor: pointer; }
  .sheet dl { margin: 0; padding: 6px 12px 12px; overflow: auto; }
  .sheet dt {
    font-weight: 600; font-size: 11px; margin-top: 8px; color: GrayText;
    display: flex; gap: 6px; align-items: baseline;
  }
  .sheet dt em { font-style: normal; font-weight: 400; font-size: 10px; }
  .sheet dd {
    margin: 2px 0 0; font-family: ui-monospace, monospace; font-size: 11px;
    white-space: pre-wrap; word-break: break-word;
    background: color-mix(in srgb, CanvasText 5%, Canvas);
    border: 1px solid var(--color-border, #e4e4e7); border-radius: 5px; padding: 5px 7px;
  }
  .sheet dd.null { color: GrayText; font-style: italic; }

  .results { overflow: auto; padding: 0 8px 8px; }
  /* Natural width, minimum the container: a wide result scrolls sideways
     instead of squeezing every column until the text is unreadable. */
  .results table { width: max-content; min-width: 100%; }
  .results th, .results td { min-width: 72px; }
  .pager {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, Canvas);
  }
  .pager button {
    border: 1px solid var(--color-border, #e4e4e7); background: Canvas; color: CanvasText;
    border-radius: 5px; padding: 1px 9px; cursor: pointer; font: inherit; line-height: 1.4;
  }
  .pager button:disabled { opacity: .4; cursor: default; }
  .pageinfo { font-family: ui-monospace, monospace; font-size: 11px; min-width: 130px; text-align: center; }
  .sizepick { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: GrayText; }
  .sizepick select { padding: 1px 4px; }
  .pager .meta { margin-left: auto; font-size: 10px; color: GrayText; }
  .results table { border-collapse: collapse; font-family: ui-monospace, monospace; }
  .results th, .results td { border: 1px solid var(--color-border, #e4e4e7); padding: 2px 6px; white-space: nowrap; }
  .results td.wrap { white-space: normal; }
  .results th em { display: block; font-size: 10px; font-style: normal; color: var(--color-muted-foreground, #71717a); font-weight: 400; }
  .results td.null { color: var(--color-muted-foreground, #71717a); font-style: italic; }
  button, select, input { font: inherit; }
  input, select { border: 1px solid var(--color-border, #e4e4e7); border-radius: 4px; padding: 3px 5px; background: var(--color-background, #fff); color: inherit; }
  header button { border: 1px solid var(--color-border, #e4e4e7); background: none; border-radius: 6px; padding: 4px 10px; cursor: pointer; color: inherit; }
  header button:disabled { opacity: .5; cursor: default; }
  header button.run { background: var(--color-primary, #2563eb); border-color: transparent; color: var(--color-primary-foreground, #fff); }
  .grid button { border: 1px solid var(--color-border, #e4e4e7); background: none; border-radius: 4px; padding: 1px 6px; cursor: pointer; color: inherit; }
</style>
