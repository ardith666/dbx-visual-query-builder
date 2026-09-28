<script>
  // Relationship diagram: draggable table cards + FK edges, in the spirit of
  // DBX's built-in relationship diagram.
  // ponytail: no pan/zoom or graph library. Zoom is a CSS transform, drag is
  // plain mouse events, tidy is a grid layout. All three are ~30 lines each.
  import { activeRelations, tidyLayout, edgeLabels } from "./relationships.js";

  const CARD_W = 208;
  const HEAD_H = 30;
  const ROW_H = 22;
  const PAD = 8;
  const GAP_X = 90;
  const GAP_Y = 200;

  // `pos` and `zoom` are owned by the parent and bound. They used to live here,
  // which meant switching tabs unmounted the component and threw away every
  // card position the user had arranged.
  let { model, foreignKeys, onselect, onremove, onprint, pos = $bindable(), zoom = $bindable() } = $props();

  // Plain object, reassigned on write. A Map inside $state is not deeply
  // reactive in Svelte 5, which silently pinned every card to 0,0.

  function cardHeight(table) {
    return HEAD_H + PAD + Math.max(table.columns.length, 1) * ROW_H + PAD;
  }

  // Tidy: a centred grid via the tested pure layout helper.
  function arrange() {
    const tables = model.tables;
    if (!tables.length) return;
    const slots = tidyLayout(tables.length, { cardW: CARD_W, gapX: GAP_X, gapY: GAP_Y, viewportW: viewportWidth() });
    const next = { ...pos };
    tables.forEach((table, i) => {
      next[table.id] = slots[i];
    });
    pos = next;
    zoom = 1;
  }

  let canvasEl = $state(null);
  function viewportWidth() {
    return canvasEl?.clientWidth ?? 700;
  }

  $effect(() => {
    const tables = model.tables;
    const next = { ...pos };
    let added = false;
    tables.forEach((table, i) => {
      if (next[table.id]) return;
      next[table.id] = {
        x: 20 + Math.floor(i / 6) * (CARD_W + GAP_X),
        y: 20 + (i % 6) * GAP_Y,
      };
      added = true;
    });
    if (added) pos = next;
  });

  const edges = $derived.by(() => {
    const byName = new Map(model.tables.map((t) => [t.name, t]));
    return foreignKeys.flatMap((fk) => {
      const child = byName.get(fk.table);
      const parent = byName.get(fk.refTable);
      if (!child || !parent || child.id === parent.id) return [];
      return [{ fk, child, parent }];
    });
  });

  const hot = $derived(activeRelations(model, foreignKeys));
  const labels = $derived(edgeLabels(foreignKeys));

  function anchor(table, side) {
    const p = pos[table.id] ?? { x: 0, y: 0 };
    return {
      x: side === "right" ? p.x + CARD_W : p.x,
      y: p.y + Math.min(HEAD_H / 2 + 8, cardHeight(table) / 2),
    };
  }

  function endpoints(child, parent) {
    const childX = pos[child.id]?.x ?? 0;
    const parentX = pos[parent.id]?.x ?? 0;
    const parentFirst = parentX >= childX;
    return {
      from: anchor(parentFirst ? parent : child, parentFirst ? "right" : "left"),
      to: anchor(parentFirst ? child : parent, parentFirst ? "left" : "right"),
    };
  }

  // Dragging via mouse events on window. Pointer capture inside a nested
  // WKWebView was unreliable; window-level mouse events are not.
  // Midpoint of the cubic at t=0.5, so the cardinality badge sits ON the line
  // instead of floating at the card ends where it reads as a column header.
  function edgeMidpoint(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    const p1 = { x: a.x + dx, y: a.y };
    const p2 = { x: b.x - dx, y: b.y };
    return {
      x: (a.x + 3 * p1.x + 3 * p2.x + b.x) / 8,
      y: (a.y + 3 * p1.y + 3 * p2.y + b.y) / 8,
    };
  }

  let drag = $state(null);
  function startDrag(event, table) {
    if (event.target.closest("button, input, label")) return;
    event.preventDefault();
    const p = pos[table.id] ?? { x: 0, y: 0 };
    drag = { id: table.id, dx: (event.clientX - p.x * zoom) / zoom, dy: (event.clientY - p.y * zoom) / zoom };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", endDrag);
  }
  function onMove(event) {
    if (!drag) return;
    pos = {
      ...pos,
      [drag.id]: {
        x: Math.max(0, Math.round((event.clientX - drag.dx * zoom) / zoom)),
        y: Math.max(0, Math.round((event.clientY - drag.dy * zoom) / zoom)),
      },
    };
  }
  function endDrag() {
    drag = null;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", endDrag);
  }

  function isLinked(table, column) {
    return model.select.some((s) => s.tableId === table.id && s.column === column);
  }

  const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  function stepZoom(direction) {
    const i = ZOOMS.indexOf(zoom);
    zoom = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i === -1 ? 2 : i) + direction))];
  }
</script>

<div class="toolbar">
  <button type="button" onclick={() => stepZoom(-1)} disabled={zoom <= ZOOMS[0]} aria-label="Zoom out">−</button>
  <span class="level">{Math.round(zoom * 100)}%</span>
  <button type="button" onclick={() => stepZoom(1)} disabled={zoom >= ZOOMS.at(-1)} aria-label="Zoom in">+</button>
  <button type="button" onclick={arrange} disabled={model.tables.length === 0}>Tidy</button>
  <button type="button" onclick={onprint} title="Print, or save as PDF from the print dialog">Print</button>
</div>

<div class="canvas" bind:this={canvasEl}>
  <div class="stage" style:transform="scale({zoom})">
    <svg class="edges" width="3200" height="2400" aria-hidden="true">
      {#each edges as e (e.fk.table + "|" + e.fk.column + "|" + e.fk.refTable)}
        {@const { from, to } = endpoints(e.child, e.parent)}
        {@const lit = hot.has(`${e.fk.table}->${e.fk.refTable}`)}
        {@const mid = (to.x - from.x) / 2}
        {@const card = labels(e.fk)}
        {@const centre = edgeMidpoint(from, to)}
        <g class="edge" class:lit>
          <path d="M {from.x} {from.y} C {from.x + mid} {from.y}, {to.x - mid} {to.y}, {to.x} {to.y}" />
          <!-- Cardinality rides on the line itself, as one badge at the curve's
               midpoint, rather than two loose glyphs at the card ends. -->
          <g class="badge" transform="translate({centre.x}, {centre.y})">
            <rect x="-15" y="-8" width="30" height="16" rx="8" />
            <text y="4">{card.parent}:{card.child}</text>
          </g>
        </g>
      {/each}
    </svg>

    {#each model.tables as table (table.id)}
      {@const p = pos[table.id] ?? { x: 0, y: 0 }}
      <div
        class="card"
        class:dragging={drag?.id === table.id}
        style:left="{p.x}px"
        style:top="{p.y}px"
        style:width="{CARD_W}px"
      >
        <header onmousedown={(e) => startDrag(e, table)} role="presentation">
          <span class="name">{table.name}</span>
          <button type="button" onclick={() => onremove(table.id)} aria-label="Remove {table.name}">×</button>
        </header>
        <ul>
          {#each table.columns as column (column.name)}
            <li>
              <label>
                <input
                  type="checkbox"
                  checked={isLinked(table, column.name)}
                  onchange={() => onselect(table.id, column.name)}
                />
                <span class="col" class:linked={isLinked(table, column.name)}>{column.name}</span>
                <em>{column.dataType ?? ""}</em>
              </label>
            </li>
          {:else}
            <li class="muted">no columns loaded</li>
          {/each}
        </ul>
      </div>
    {/each}
  </div>

  {#if model.tables.length === 0}
    <p class="empty">Add a table to see it here.</p>
  {:else if edges.length === 0}
    <p class="empty note">No foreign keys between these tables. Add a related table, or set one up in the Joins tab.</p>
  {/if}
</div>

<style>
  /* Surfaces use system colors: guaranteed opaque, and they follow the OS/theme
     without depending on which --color-* tokens this host version defines. */
  .toolbar {
    display: flex; align-items: center; gap: 6px; padding: 4px 8px;
    border-bottom: 1px solid var(--color-border, #e4e4e7);
  }
  .toolbar button {
    border: 1px solid var(--color-border, #e4e4e7); background: Canvas; color: CanvasText;
    border-radius: 5px; padding: 2px 9px; cursor: pointer; font: inherit; min-width: 26px;
  }
  .toolbar button:disabled { opacity: .45; cursor: default; }
  .level { font-size: 11px; min-width: 38px; text-align: center; color: GrayText; }

  .canvas {
    position: relative; height: calc(100% - 27px); overflow: auto; color: CanvasText;
    /* Lightly tinted, with a dot grid so the surface reads as a canvas. */
    background-color: color-mix(in srgb, CanvasText 4%, Canvas);
    background-image: radial-gradient(circle, color-mix(in srgb, CanvasText 16%, Canvas) 1px, transparent 1px);
    background-size: 18px 18px;
  }
  .stage { position: absolute; top: 0; left: 0; width: 3200px; height: 2400px; transform-origin: 0 0; }
  .edges { position: absolute; inset: 0; pointer-events: none; }
  .edge { fill: none; stroke: GrayText; stroke-width: 1.5; }
  .edge.lit { stroke: LinkText; }
  .edge .badge rect { fill: Canvas; stroke: GrayText; stroke-width: 1; }
  .edge .badge text {
    fill: GrayText; font: 700 9px ui-monospace, monospace;
    stroke: none; text-anchor: middle;
  }
  .edge.lit .badge rect { fill: LinkText; stroke: LinkText; }
  .edge.lit .badge text { fill: Canvas; }

  .card {
    position: absolute;
    background: Canvas;
    color: CanvasText;
    border: 1px solid var(--color-border, #d4d4d8);
    border-radius: 8px;
    box-shadow: 0 1px 3px rgb(0 0 0 / .18);
    user-select: none;
  }
  .card.dragging { box-shadow: 0 10px 26px rgb(0 0 0 / .32); z-index: 3; }
  .card header {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
    padding: 6px 8px; cursor: grab;
    border-bottom: 1px solid var(--color-border, #d4d4d8);
    border-radius: 7px 7px 0 0; background: color-mix(in srgb, CanvasText 6%, Canvas);
  }
  .name { font-weight: 600; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card header button { border: 0; background: none; cursor: pointer; color: inherit; font: inherit; line-height: 1; }
  .card ul { list-style: none; margin: 0; padding: 4px; }
  .card li label { display: flex; align-items: center; gap: 5px; height: 18px; cursor: pointer; }
  .col { font-family: ui-monospace, monospace; font-size: 11px; }
  .col.linked { font-weight: 700; color: LinkText; }
  .card em { margin-left: auto; font-size: 9px; font-style: normal; opacity: .65; }
  .muted { color: GrayText; font-size: 10px; padding: 2px 4px; }
  .empty {
    position: absolute; left: 0; right: 0; bottom: 10px; margin: 0; text-align: center;
    color: GrayText; font-size: 11px; pointer-events: none;
  }
  .note { padding: 4px 8px; }
</style>
