// Result column labels. When two selected columns share a name and neither is
// aliased, the result header alone cannot tell them apart -- so the ambiguous
// ones get their source table attached.

export function resultHeaders(resultColumns, select = []) {
  const names = resultColumns.map((c) => (typeof c === "string" ? c : c?.name) ?? "");
  const items = Array.isArray(select) ? select : [];

  // How many select items produced each output name.
  const counts = new Map();
  for (const item of items) {
    const out = item.alias || item.column;
    counts.set(out, (counts.get(out) ?? 0) + 1);
  }

  // Index each select item by its output name, in model order, so a result
  // column can be matched back to the table it came from.
  const byName = new Map();
  for (const item of items) {
    const out = item.alias || item.column;
    if (!byName.has(out)) byName.set(out, []);
    byName.get(out).push(item);
  }

  const used = new Map();
  return names.map((name) => {
    const candidates = byName.get(name);
    if (!candidates || (counts.get(name) ?? 0) < 2) return name;
    // Ambiguous: label each with its table so the grid is readable.
    const n = used.get(name) ?? 0;
    used.set(name, n + 1);
    const item = candidates[n];
    const source = item?.tableName;
    return source ? `${name} · ${source}` : name;
  });
}
