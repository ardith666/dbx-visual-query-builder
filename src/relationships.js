// Relationship helpers. Kept separate from Diagram.svelte so the rules are
// testable without a DOM.

// Build the join an existing foreign key implies. Returns null when the two
// tables are not both present, so adding an unrelated table never invents a
// relationship. Only real FK metadata is used -- PRD FR-06 forbids inferring a
// relationship from matching column names.
export function joinForForeignKey(model, fk) {
  const byName = new Map(model.tables.map((t) => [t.name, t]));
  const child = byName.get(fk.table);
  const parent = byName.get(fk.refTable);
  if (!child || !parent || child.id === parent.id) return null;
  return {
    key: `${fk.table}.${fk.refTable}`,
    type: "LEFT",
    leftTableId: child.id,
    rightTableId: parent.id,
    conditions: [{ leftColumn: fk.column, rightColumn: fk.refColumn }],
  };
}

// Every FK-implied join that is not already in the model.
export function missingJoins(model, foreignKeys) {
  const present = new Set(
    model.joins.map((j) => `${tableName(model, j.leftTableId)}.${tableName(model, j.rightTableId)}`),
  );
  return foreignKeys
    .map((fk) => joinForForeignKey(model, fk))
    .filter((j) => j && !present.has(j.key));
}

// Cardinality labels for a relationship edge.
//
// A foreign key is N:1 from the child (referencing) side to the parent
// (referenced) side -- many children per parent. The diagram draws the parent
// on the right, so it is labelled 1 and the child N.
//
// A junction table turns that into M:M: when a table's only foreign keys all
// point outward and nothing points at it, it bridges the tables it references.
export function edgeLabels(foreignKeys) {
  const referenced = new Set(foreignKeys.map((fk) => fk.refTable));
  const references = new Map();
  for (const fk of foreignKeys) {
    if (!references.has(fk.table)) references.set(fk.table, []);
    references.get(fk.table).push(fk.refTable);
  }
  const isJunction = (name) => {
    const out = references.get(name) ?? [];
    return out.length > 1 && !referenced.has(name);
  };
  const junctionOf = (name) => (isJunction(name) ? references.get(name) : []);

  return (fk) => {
    // child -> parent
    if (isJunction(fk.refTable) || isJunction(fk.table)) {
      return { parent: "M", child: "N" };
    }
    void junctionOf;
    return { parent: "1", child: "N" };
  };
}

export function tableName(model, id) {
  return model.tables.find((t) => t.id === id)?.name ?? "";
}

// Tidy layout: a centred square-ish grid. Pure so the geometry is testable
// without a DOM.
export function tidyLayout(count, { cardW, gapX, gapY, viewportW, originY = 12 } = {}) {
  if (count <= 0) return [];
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const width = cols * cardW + (cols - 1) * gapX;
  const originX = Math.max(0, Math.round(((viewportW ?? 0) - width) / 2));
  return Array.from({ length: count }, (_, i) => ({
    x: Math.round(originX + (i % cols) * (cardW + gapX)),
    y: Math.round(originY + Math.floor(i / cols) * gapY),
  }));
}

// Which FK edges light up because at least one of their columns is selected.
// Selecting the child FK column or the parent PK column both count: the user
// is pointing at the relationship either way.
export function activeRelations(model, foreignKeys) {
  // select rows carry a tableId, so resolve by id here -- not by name.
  const picked = new Set(
    model.select
      .map((s) => (s.tableId && s.column ? `${s.tableId}.${s.column}` : null))
      .filter(Boolean),
  );
  const byName = new Map(model.tables.map((t) => [t.name, t]));

  const active = new Set();
  for (const fk of foreignKeys) {
    const child = byName.get(fk.table);
    const parent = byName.get(fk.refTable);
    if (!child || !parent) continue;
    if (picked.has(`${child.id}.${fk.column}`) || picked.has(`${parent.id}.${fk.refColumn}`)) {
      active.add(`${fk.table}->${fk.refTable}`);
    }
  }
  return active;
}
