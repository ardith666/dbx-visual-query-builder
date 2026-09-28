// A stand-in for window.dbxPlugin, used only by the DOM test harness
// (test/mock-entry.js). It exists so the results panel -- filters, paging,
// column resizing, the row-detail dialog, SQL editing, export -- can be driven
// in a real browser, because the development host has no dataApi and can
// therefore never reach that UI.
//
// The shape mirrors the real bridge, including the two things that have already
// bitten us: queryData reports `dbType`, and a table context-menu invocation
// carries no `dbType` at all.

const TABLES = [
  { name: "produk_jenis_produk", columns: [
    { name: "id", dataType: "int", nullable: false },
    { name: "produk_id", dataType: "int", nullable: false },
    { name: "jenis_produk_id", dataType: "int", nullable: false },
    { name: "tenant_id", dataType: "int", nullable: false },
  ] },
  { name: "jenis_produk", columns: [
    { name: "id", dataType: "int", nullable: false },
    { name: "nama", dataType: "varchar(255)", nullable: false },
  ] },
  { name: "tenant", columns: [
    { name: "id", dataType: "int", nullable: false },
    { name: "nama", dataType: "varchar(255)", nullable: false },
  ] },
];

const FK = [
  { table: "produk_jenis_produk", column: "jenis_produk_id", refTable: "jenis_produk", refColumn: "id" },
  { table: "produk_jenis_produk", column: "tenant_id", refTable: "tenant", refColumn: "id" },
];

// Wide enough to force horizontal scrolling.
const COLUMNS = [
  { name: "nama", dataType: "varchar(255)" },
  { name: "deskripsi_panjang", dataType: "text" },
  { name: "kategori", dataType: "varchar(64)" },
  { name: "harga", dataType: "decimal" },
  { name: "stok", dataType: "int" },
];

// `nama` repeats, one value carries a quote, one cell is NULL.
const ROWS = Array.from({ length: 57 }, (_, i) => [
  ["Makanan", "Minuman", "Perawatan Diri"][i % 3],
  i === 4 ? "O'Brien & Sons - deskripsi dengan kutipan" : `Deskripsi baris ${i}`,
  i % 2 === 0 ? "pangan" : "ritel",
  (i * 37) % 9000,
  i === 7 ? null : (i * 13) % 250,
]);

export function installMockBridge() {
  const bridge = {
    context: {
      connectionId: "mock-connection",
      database: "praktikum-basis-data",
      schema: "",
      table: "produk_jenis_produk",
    },
    locale: "en",
    theme: { appearance: "light", tokens: {} },
    capabilities: {
      dataApi: true, schemaMetadataApi: true, storage: true,
      clipboardWrite: true, downloadFile: true, planApi: true,
    },
    dialect: undefined,
    queries: [],
    saves: [],
    ready: Promise.resolve(),
    onContext() { return () => {}; },
    onInit() { return () => {}; },
    onEvent() { return () => {}; },
    async getPlanCapabilities() { return { dbType: "mysql", supports: { estimatedPlan: true } }; },
    async getTableMetadata({ table }) {
      const found = TABLES.find((t) => t.name === table);
      if (!found) throw new Error(`No such table: ${table}`);
      return {
        columns: found.columns.map((c) => ({ name: c.name, dataType: c.dataType, nullable: c.nullable })),
        fieldCapabilities: { precision: "supported", default: "unsupported" },
      };
    },
    async queryData({ sql }) {
      bridge.queries.push(sql);
      if (/information_schema\.schemata/.test(sql)) {
        return { dbType: "mysql", columns: [{ name: "schema_name" }], rows: [["praktikum-basis-data"]], truncated: false, elapsedMs: 3 };
      }
      if (/information_schema\.tables/.test(sql)) {
        return {
          dbType: "mysql",
          columns: [{ name: "table_name" }, { name: "table_type" }],
          rows: TABLES.map((t) => [t.name, "BASE TABLE"]),
          truncated: false,
          elapsedMs: 4,
        };
      }
      if (/information_schema\.key_column_usage/.test(sql)) {
        return {
          dbType: "mysql",
          columns: [
            { name: "table_name" }, { name: "column_name" },
            { name: "referenced_table_name" }, { name: "referenced_column_name" },
          ],
          rows: FK.map((f) => [f.table, f.column, f.refTable, f.refColumn]),
          truncated: false,
          elapsedMs: 5,
        };
      }
      return { dbType: "mysql", columns: COLUMNS, rows: ROWS, truncated: false, elapsedMs: 42 };
    },
    storage: { async set() {}, async get() { return null; }, async delete() {} },
    clipboard: { async writeText(text) { bridge.saves.push({ kind: "clipboard", text }); } },
    async saveFile(options, data) {
      bridge.saves.push({
        kind: "file",
        fileName: options?.fileName,
        contentType: options?.contentType,
        bytes: typeof data === "string" ? data.length : 0,
      });
      return { path: `/tmp/${options?.fileName}` };
    },
    async copy(text) { bridge.saves.push({ kind: "copy", text }); },
  };
  window.dbxPlugin = bridge;
  return bridge;
}

export const MOCK = { TABLES, FK, COLUMNS, ROWS };
