// Byte-producing exporters. Pure: no DOM, no host API, so every one of these is
// unit-testable. The UI only decides *where* to write the bytes.

const enc = new TextEncoder();

function cell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// --- CSV ---------------------------------------------------------------------

// RFC 4180: quote when the value contains a delimiter, quote or newline; double
// an inner quote. A leading BOM makes Excel open UTF-8 correctly, which it
// otherwise guesses as the local codepage and mangles non-ASCII data.
export function toCsv(columns, rows, { bom = true } = {}) {
  const lines = [];
  lines.push(columns.map((c) => csvField(c.name ?? String(c))).join(","));
  for (const row of rows) lines.push(row.map(csvField).join(","));
  return (bom ? "\uFEFF" : "") + lines.join("\r\n") + "\r\n";
}

function csvField(value) {
  const text = cell(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// --- XLSX --------------------------------------------------------------------
// A real .xlsx is a ZIP of XML parts. STORED (uncompressed) entries keep this
// dependency-free and deterministic; Excel does not care.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true); // time
    lv.setUint16(12, 0, true); // date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...locals, ...centrals, end];
  const total = all.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of all) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

const xmlEscape = (value) =>
  cell(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

function columnName(index) {
  // 0 -> A, 25 -> Z, 26 -> AA
  let n = index;
  let name = "";
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

export function toXlsx(columns, rows) {
  const headerCells = columns
    .map((c, i) => `<c r="${columnName(i)}1" t="inlineStr"><is><t>${xmlEscape(c.name ?? String(c))}</t></is></c>`)
    .join("");
  const sheetRows = [`<row r="1">${headerCells}</row>`];
  rows.forEach((row, r) => {
    const cells = row
      .map((value, i) => {
        const ref = `${columnName(i)}${r + 2}`;
        if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
      })
      .join("");
    sheetRows.push(`<row r="${r + 2}">${cells}</row>`);
  });

  const parts = [
    {
      name: "[Content_Types].xml",
      data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          "</Types>",
      ),
    },
    {
      name: "_rels/.rels",
      data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          "</Relationships>",
      ),
    },
    {
      name: "xl/workbook.xml",
      data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Result" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          "</Relationships>",
      ),
    },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sheetRows.join("") + "</sheetData></worksheet>") },
  ];

  return zipStore(parts);
}

// --- Results as a printable document -----------------------------------------
// Same reasoning as the diagram: a standalone HTML file the user opens, which
// gives a real print dialog (and Save as PDF) in their own browser.

export function tableHtml({ columns, labels, rows, sql, title = "DBX Visual Query Builder - result" }) {
  const head = columns
    .map((c, i) => `<th>${xmlEscape(labels?.[i] ?? c.name ?? String(c))}<em>${xmlEscape(c.dataType ?? "")}</em></th>`)
    .join("");
  const body = rows
    .map(
      (row) =>
        "<tr>" +
        row
          .map((v) => {
            if (v === null || v === undefined) return '<td class="null">NULL</td>';
            const text = cell(v);
            const long = text.length > 120;
            return `<td${long ? ' class="wrap"' : ""}>${xmlEscape(text)}</td>`;
          })
          .join("") +
        "</tr>",
    )
    .join("");

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${xmlEscape(title)}</title><style>` +
    `body{margin:24px;font:11px/1.45 ui-sans-serif,system-ui,sans-serif;color:#0f172a}` +
    `h1{font-size:15px;margin:0 0 4px}` +
    `.meta{color:#64748b;margin:0 0 12px;font-size:11px}` +
    `pre{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:8px;` +
    `font:11px/1.4 ui-monospace,monospace;white-space:pre-wrap;margin:0 0 14px;overflow-x:auto}` +
    `table{border-collapse:collapse;width:100%}` +
    `th,td{border:1px solid #cbd5e1;padding:3px 6px;text-align:left;vertical-align:top}` +
    `th{background:#f1f5f9}` +
    `th em{display:block;font-style:normal;font-size:9px;color:#64748b;font-weight:400}` +
    `td.null{color:#94a3b8;font-style:italic}` +
    `td.wrap{white-space:pre-wrap;word-break:break-word}` +
    `@media print{body{margin:0}h1{margin-bottom:4px}thead{display:table-header-group}tr{page-break-inside:avoid}}` +
    `</style></head><body>` +
    `<h1>${xmlEscape(title)}</h1>` +
    `<p class="meta">${rows.length} row(s)</p>` +
    (sql ? `<pre>${xmlEscape(sql)}</pre>` : "") +
    `<table><thead><tr>${head}</tr></thead><tbody>${body || '<tr><td>No rows.</td></tr>'}</tbody></table>` +
    `</body></html>`
  );
}

// --- Diagram as a printable document -----------------------------------------
// window.print() is unreliable inside the sandboxed workbench iframe, so Print
// hands the user a standalone HTML file instead. Opening it gives a real print
// dialog (and "Save as PDF") in their own browser.

const CARD_W = 208;
const HEAD_H = 30;
const ROW_H = 22;
const PAD = 8;

export function diagramHtml({ tables, pos, edges, title = "DBX Visual Query Builder" }) {
  const height = (table) => HEAD_H + PAD + Math.max(table.columns?.length ?? 1, 1) * ROW_H + PAD;
  const anchor = (table, side) => {
    const p = pos?.[table.id] ?? { x: 20, y: 20 };
    return { x: side === "right" ? p.x + CARD_W : p.x, y: p.y + Math.min(HEAD_H / 2 + 8, height(table) / 2) };
  };

  const svg = edges
    .map(({ child, parent, from: labelFrom, to: labelTo }) => {
      const parentFirst = (pos?.[parent.id]?.x ?? 0) >= (pos?.[child.id]?.x ?? 0);
      const a = anchor(parentFirst ? parent : child, parentFirst ? "right" : "left");
      const b = anchor(parentFirst ? child : parent, parentFirst ? "left" : "right");
      const mid = (b.x - a.x) / 2;
      const path = `M ${a.x} ${a.y} C ${a.x + mid} ${a.y}, ${b.x - mid} ${b.y}, ${b.x} ${b.y}`;
      return (
        `<path d="${path}" fill="none" stroke="#94a3b8" stroke-width="1.4"/>` +
        `<text x="${a.x + 9}" y="${a.y - 6}" font-family="monospace" font-size="10" fill="#64748b">${xmlEscape(labelFrom)}</text>` +
        `<text x="${b.x - 7}" y="${b.y - 6}" font-family="monospace" font-size="10" fill="#64748b">${xmlEscape(labelTo)}</text>`
      );
    })
    .join("");

  const cards = tables
    .map((table) => {
      const p = pos?.[table.id] ?? { x: 20, y: 20 };
      const rows = (table.columns ?? [])
        .map(
          (c) =>
            `<li><span>${xmlEscape(c.name)}</span><em>${xmlEscape(c.dataType ?? "")}</em></li>`,
        )
        .join("");
      return (
        `<div class="card" style="left:${p.x}px;top:${p.y}px">` +
        `<header>${xmlEscape(table.name)}</header><ul>${rows}</ul></div>`
      );
    })
    .join("");

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${xmlEscape(title)}</title><style>` +
    `body{margin:0;background:#f8fafc;font:12px/1.5 ui-sans-serif,system-ui,sans-serif;color:#0f172a}` +
    `h1{font-size:14px;margin:0 0 12px;padding:10px 14px;background:#fff;border-bottom:1px solid #e2e8f0}` +
    `.stage{position:relative;width:100%;height:100vh;background-image:radial-gradient(circle,#cbd5e1 1px,transparent 1px);background-size:18px 18px}` +
    `svg{position:absolute;inset:0;width:4000px;height:3000px}` +
    `.card{position:absolute;width:${CARD_W}px;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1)}` +
    `.card header{padding:6px 8px;font-weight:600;font-size:11px;background:#f1f5f9;border-bottom:1px solid #e2e8f0;border-radius:7px 7px 0 0}` +
    `.card ul{list-style:none;margin:0;padding:4px}` +
    `.card li{display:flex;gap:8px;padding:2px 4px;font-family:ui-monospace,monospace;font-size:11px;border-bottom:1px solid #f1f5f9}` +
    `.card li:last-child{border-bottom:0}` +
    `.card em{margin-left:auto;font-style:normal;font-size:9px;color:#94a3b8}` +
    `@media print{body{background:#fff}.stage{height:auto;min-height:0}}` +
    `</style></head><body><h1>${xmlEscape(title)}</h1>` +
    `<div class="stage"><svg width="4000" height="3000">${svg}</svg>${cards}</div></body></html>`
  );
}

// A paginated PDF using the base-14 Helvetica font. No font embedding means
// WinAnsi (Latin-1) encoding, so characters outside that range become "?" and
// the count is returned -- the UI reports it instead of silently corrupting the
// data.

function pdfEscape(text) {
  return text.replace(/([\\()])/g, "\\$1");
}

function winAnsi(value) {
  const text = cell(value);
  let out = "";
  let lost = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === "\n" || ch === "\r" || ch === "\t") { out += " "; continue; }
    if (code >= 32 && code <= 126) out += ch;
    else if (code >= 160 && code <= 255) out += String.fromCharCode(code);
    else { out += "?"; lost++; }
  }
  return { text: out, lost };
}

const A4 = { w: 595.28, h: 841.89 };
const PAGE_MARGIN = 32;
const FONT_SIZE = 7;

function renderPage(columns, rows, { index, total, title, rowCount, perCol }) {
  const out = [];
  let y = A4.h - PAGE_MARGIN;
  const line = (text, x, size) => {
    y -= size + 2.2;
    out.push(`BT /F1 ${size} Tf ${x} ${y.toFixed(2)} Td (${pdfEscape(text)}) Tj ET`);
  };
  const clip = (value) => winAnsi(value).text.slice(0, Math.max(4, Math.floor(perCol / 3.4)));

  if (index === 0) line(winAnsi(title).text, PAGE_MARGIN, 12);
  line(`page ${index + 1} / ${total} - ${rowCount} rows`, PAGE_MARGIN, 8);
  y -= 4;

  y -= FONT_SIZE + 2.6;
  out.push(`0.85 0.85 0.85 rg ${PAGE_MARGIN} ${(y - 3).toFixed(2)} ${A4.w - PAGE_MARGIN * 2} ${FONT_SIZE + 4} re f`);
  // Reset the fill to black. Without this the header band's grey leaks into
  // every following text run, which is why the rows came out grey.
  out.push("0 0 0 rg");
  columns.forEach((c, i) => {
    out.push(`BT /F1 ${FONT_SIZE} Tf ${PAGE_MARGIN + 4 + i * perCol} ${y.toFixed(2)} Td (${pdfEscape(clip(c.name ?? String(c)))}) Tj ET`);
  });

  for (const row of rows) {
    y -= FONT_SIZE + 2.6;
    if (y < PAGE_MARGIN) break;
    row.forEach((value, i) => {
      out.push(`BT /F1 ${FONT_SIZE} Tf ${PAGE_MARGIN + 4 + i * perCol} ${y.toFixed(2)} Td (${pdfEscape(clip(value))}) Tj ET`);
    });
  }
  out.push(
    `0.6 0.6 0.6 RG 0.4 w ${PAGE_MARGIN} ${PAGE_MARGIN} ${A4.w - PAGE_MARGIN * 2} ${A4.h - PAGE_MARGIN * 2} re S`,
  );
  out.push("0 0 0 rg");
  return out.join("\n");
}

export function toPdf(columns, rows, { title = "Query result", rowsPerPage = 45 } = {}) {
  const chunks = [];
  for (const row of rows) for (const value of row) chunks.push(winAnsi(value).lost);
  for (const c of columns) chunks.push(winAnsi(c.name ?? String(c)).lost);
  const lost = chunks.reduce((a, b) => a + b, 0);

  const perCol = Math.max(24, Math.floor((A4.w - PAGE_MARGIN * 2 - 150) / Math.max(columns.length, 1)));
  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  const pageStreams = [];
  for (let i = 0; i < pageCount; i++) {
    pageStreams.push(
      renderPage(columns, rows.slice(i * rowsPerPage, (i + 1) * rowsPerPage), {
        index: i,
        total: pageCount,
        title,
        rowCount: rows.length,
        perCol,
      }),
    );
  }

  // Sequential object numbering keeps the xref correct by construction.
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pagesId = add(null);
  const contentIds = pageStreams.map((stream) =>
    add({ dict: `<< /Length ${enc.encode(stream).length} >>`, stream }),
  );
  const pageIds = contentIds.map((cid) =>
    add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${cid} 0 R >>`,
    ),
  );
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  // Offsets must be BYTE positions. Building against a JS string and using
  // .length silently breaks as soon as any character is non-ASCII, because
  // .length counts UTF-16 units while the file is written as UTF-8.
  const parts = [];
  let offset = 0;
  const push = (text) => {
    const bytes = enc.encode(text);
    parts.push(bytes);
    offset += bytes.length;
    return offset - bytes.length;
  };

  push("%PDF-1.4\n");
  const offsets = objects.map((body, i) => {
    const at = offset;
    const text = typeof body === "string" ? body : `${body.dict}\nstream\n${body.stream}\nendstream`;
    push(`${i + 1} 0 obj\n${text}\nendobj\n`);
    return at;
  });

  const xref = push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) push(`${String(off).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const total = parts.reduce((sum, c) => sum + c.length, 0);
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of parts) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }

  return { bytes, lost, pages: pageCount };
}
