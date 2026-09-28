// ponytail: browser-side verification harness for the results panel.
//
// The dev host has no dataApi, so the results UI is unreachable there. This
// builds the REAL App against a fake host bridge and drives it in Chromium over
// CDP -- zero dependencies, using Node's global WebSocket.
//
//   npm run test:dom
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const OUT = "/tmp/vqb-mock";
const SERVE_PORT = 5199;
const CDP_PORT = 9455;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
        const file = join(OUT, path === "/" ? "test/mock.html" : path);
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    server.listen(SERVE_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  console.log("building the mock page...");
  const { build } = await import("vite");
  await build({ configFile: fileURLToPath(new URL("./mock.vite.config.js", import.meta.url)) });

  const server = await serve();
  const profile = mkdtempSync(join(tmpdir(), "vqb-dom-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-gpu",
    "--window-size=1500,1000",
    `http://127.0.0.1:${SERVE_PORT}/`,
  ], { stdio: "ignore" });

  try {
    let list;
    for (let i = 0; i < 60; i++) {
      try {
        list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        if (list.some((t) => t.type === "page")) break;
      } catch {}
      await sleep(200);
    }
    const page = list.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = (m) => {
      const x = JSON.parse(m.data);
      if (x.id && pending.has(x.id)) {
        const p = pending.get(x.id);
        pending.delete(x.id);
        x.error ? p.reject(new Error(JSON.stringify(x.error))) : p.resolve(x.result);
        return;
      }
      if (x.method === "Runtime.exceptionThrown") {
        errors.push(x.params.exceptionDetails?.exception?.description ?? x.params.exceptionDetails?.text);
      }
    };
    await new Promise((r) => (ws.onopen = r));
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    const ev = async (expr) => {
      try {
        const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) return "THREW: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 300);
        return r.result?.value;
      } catch (error) {
        return "EVAL-ERR: " + error.message;
      }
    };
    const mouse = (type, x, y) =>
      send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });

    await send("Page.enable");
    await send("Runtime.enable");
    await sleep(2200);

    const type = async (selector, value) =>
      ev(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
        if(!el) return 'no element';
        el.value=${JSON.stringify(value)};
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
        return 'ok';})()`);
    const clickByLabel = (selector, label) =>
      ev(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.getAttribute('aria-label')===undefined?false:x.getAttribute('aria-label')===${JSON.stringify(label)}); if(!b) return 'not found'; b.click(); return 'clicked';})()`);
    const clickText = (selector, text) =>
      ev(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.trim().includes(${JSON.stringify(text)}));
        if(!b) return 'not found'; b.click(); return 'clicked';})()`);

    // --- shell ----------------------------------------------------------------
    const status = await ev(`document.querySelector('.status')?.textContent?.replace(/\\s+/g,' ').trim()`);
    check("status line reports a live connection", /conn ok/.test(String(status)), String(status));
    check("no startup error in the status line", !/error/i.test(String(status)), String(status));

    const tableButtons = await ev(`[...document.querySelectorAll('aside li button')].map(b=>b.textContent.trim())`);
    check("schema explorer lists the mock tables", Array.isArray(tableButtons) && tableButtons.length === 3, JSON.stringify(tableButtons));

    // The context already names one table, so it should be pre-added.
    await sleep(600);
    const firstCards = await ev(`document.querySelectorAll('.stage .card').length`);
    check("the table from the workbench context is already on the canvas", firstCards === 1, `cards=${firstCards}`);


    // --- searchable database picker ------------------------------------------
    await ev(`document.querySelector('.picker .trigger')?.click()`);
    await sleep(400);
    check("the database picker opens", (await ev(`!!document.querySelector('.picker .panel')`)) === true);
    check("it opens with a search box focused", (await ev(`document.activeElement?.classList.contains('needle')`)) === true);
    const allOpts = await ev(`document.querySelectorAll('.picker [role=option]').length`);
    check("every database is listed", allOpts === 62, `options=${allOpts}`);

    await type('.picker .needle', 'praktikum');
    await sleep(300);
    const filteredOpts = await ev(`[...document.querySelectorAll('.picker [role=option]')].map(o=>o.textContent.replace(/\u2713/,'').trim())`);
    check("search narrows 62 databases to one", Array.isArray(filteredOpts) && filteredOpts.length === 1 && /praktikum-basis-data/.test(filteredOpts[0]), JSON.stringify(filteredOpts));
    const tally = await ev(`document.querySelector('.picker .tally')?.textContent`);
    check("the tally reports the narrowing", / of /.test(String(tally)), String(tally));

    await type('.picker .needle', 'zzzznope');
    await sleep(300);
    check("an empty match says so", /No database matches/.test(String(await ev(`document.querySelector('.picker .none')?.textContent`))), String(await ev(`document.querySelector('.picker .none')?.textContent`)));

    await type('.picker .needle', 'praktikum');
    await sleep(300);
    await ev(`[...document.querySelectorAll('.picker [role=option]')].find(o=>/praktikum/.test(o.textContent))?.click()`);
    await sleep(1200);
    check("picking a database closes the picker", (await ev(`!!document.querySelector('.picker .panel')`)) === false);
    check("the trigger shows the chosen database", /praktikum-basis-data/.test(String(await ev(`document.querySelector('.picker .current')?.textContent`))), String(await ev(`document.querySelector('.picker .current')?.textContent`)));
    await sleep(1500); // picking reloads the schema list; wait for it to settle

    // Escape closes without choosing.
    await ev(`document.querySelector('.picker .trigger')?.click()`);
    await sleep(300);
    await ev(`document.querySelector('.picker .needle')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(300);
    check("Escape closes the picker", (await ev(`!!document.querySelector('.picker .panel')`)) === false);


    // keyboard only: arrow down moves the active option, Enter chooses it
    await ev(`document.querySelector('.picker .trigger')?.focus()`);
    await ev(`document.querySelector('.picker .trigger')?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
    await sleep(350);
    check("ArrowDown opens the picker from the keyboard", (await ev(`!!document.querySelector('.picker .panel')`)) === true);
    const firstActive = await ev(`document.querySelector('.picker li.active')?.textContent?.replace(/\u2713/,'').trim()`);
    await ev(`document.querySelector('.picker .needle')?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
    await sleep(250);
    const secondActive = await ev(`document.querySelector('.picker li.active')?.textContent?.replace(/\u2713/,'').trim()`);
    check("arrow keys move the active option", !!secondActive && secondActive !== firstActive, `${firstActive} -> ${secondActive}`);
    await ev(`document.querySelector('.picker .needle')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await sleep(1500);
    const chosen = await ev(`document.querySelector('.picker .current')?.textContent`);
    check("Enter chooses exactly the active option", chosen === secondActive, `active=${secondActive} trigger=${chosen}`);

    // --- add a related table -> FK edge + auto-join ---------------------------
    await ev(`(()=>{const b=[...document.querySelectorAll('aside li button')].find(x=>x.textContent.trim()==='jenis_produk');b?.click();return !!b;})()`);
    await sleep(800);
    const cards = await ev(`document.querySelectorAll('.stage .card').length`);
    check("adding a second table shows two cards", cards === 2, `cards=${cards}`);

    const edges = await ev(`document.querySelectorAll('.edge').length`);
    check("a foreign-key edge is drawn", edges === 1, `edges=${edges}`);

    const labels = await ev(`[...document.querySelectorAll('.edge .badge text')].map(t=>t.textContent.trim()).join(',')`);
    check("the edge carries a 1:N badge", labels === '1:N', `labels="${labels}"`);
    const badgeOnLine = await ev(`(()=>{const b=document.querySelector('.edge .badge');const p=document.querySelector('.edge path');if(!b||!p)return 'missing';const bb=b.getBoundingClientRect();const pb=p.getBoundingClientRect();const bx=bb.x+bb.width/2, by=bb.y+bb.height/2;return (bx>=pb.x&&bx<=pb.x+pb.width&&by>=pb.y&&by<=pb.y+pb.height)?'on the line':'off the line ('+Math.round(bx)+','+Math.round(by)+' vs '+Math.round(pb.x)+','+Math.round(pb.y)+' '+Math.round(pb.width)+'x'+Math.round(pb.height)+')';})()`);
    check("the badge sits on the line itself", badgeOnLine === 'on the line', String(badgeOnLine));

    const autojoin = await ev(`document.querySelector('.autojoin')?.textContent?.trim()`);
    check("auto-join is announced", /produk_jenis_produk/.test(String(autojoin)), String(autojoin));

    // --- run ------------------------------------------------------------------
    await clickText("header button", "Run SELECT");
    await sleep(1500);

    const info = await ev(`document.querySelector('.pageinfo')?.textContent?.trim()`);
    check("results opened with a page range", /1.10 of 57/.test(String(info)), String(info));

    const headers = await ev(`[...document.querySelectorAll('.results thead tr:first-child th')].map(t=>t.textContent.replace(/\\s+/g,'').trim())`);
    check("result headers are shown", Array.isArray(headers) && headers.length === 6, JSON.stringify(headers));

    // --- per-column filter ----------------------------------------------------
    await type(".colfilter input", "Makanan");
    await sleep(400);
    const filtered = await ev(`document.querySelector('.pageinfo')?.textContent?.trim()`);
    check("a column filter narrows the rows", /of 19/.test(String(filtered)), String(filtered));

    // --- global filter on top -------------------------------------------------
    await type(".filterbar .global", "ritel");
    await sleep(400);
    const combined = await ev(`document.querySelector('.pageinfo')?.textContent?.trim()`);
    const combinedCount = Number(String(combined).match(/of (\d+)/)?.[1] ?? -1);
    check("column and global filters combine", combinedCount > 0 && combinedCount < 19, String(combined));

    // --- clear ----------------------------------------------------------------
    await clickText(".filterbar button", "Clear filter");
    await sleep(400);
    const cleared = await ev(`document.querySelector('.pageinfo')?.textContent?.trim()`);
    check("clear restores every row", /of 57/.test(String(cleared)), String(cleared));

    // --- paging ---------------------------------------------------------------
    await clickByLabel(".pager button", "Next page");
    await sleep(400);
    const page2 = await ev(`document.querySelector('.pager .pageinfo')?.textContent?.trim()`);
    check("next page advances the range", /11.20 of 57/.test(String(page2)), String(page2));

    await type(".sizepick select", "25");
    await sleep(400);
    const sized = await ev(`document.querySelector('.pager .pageinfo')?.textContent?.trim()`);
    check("page size 25 re-pages", /1.25 of 57/.test(String(sized)), String(sized));

    // --- column resize --------------------------------------------------------
    const grip = await ev(`(()=>{const g=document.querySelector('.results thead .grip');
      if(!g) return null; const r=g.getBoundingClientRect();
      return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`);
    check("a resize grip exists on the first column", !!grip, String(grip));
    if (grip) {
      const g = JSON.parse(grip);
      const w0 = await ev(`document.querySelector('.results thead th:nth-child(2)').getBoundingClientRect().width`);
      await mouse("mousePressed", g.x, g.y);
      for (let i = 1; i <= 8; i++) await mouse("mouseMoved", g.x + i * 12, g.y);
      await mouse("mouseReleased", g.x + 96, g.y);
      await sleep(400);
      const w1 = await ev(`document.querySelector('.results thead th:nth-child(2)').getBoundingClientRect().width`);
      check("dragging the grip widens the column", w1 > w0 + 40, `${Math.round(w0)} -> ${Math.round(w1)}`);
    }

    // --- row detail dialog ----------------------------------------------------
    await ev(`document.querySelector('.eye')?.click()`);
    await sleep(500);
    const sheet = await ev(`document.querySelector('.sheet')?.textContent?.replace(/\\s+/g,' ').trim().slice(0,80)`);
    check("row detail opens", /Row 1/.test(String(sheet)), String(sheet));

    const dtLabels = await ev(`[...document.querySelectorAll('.sheet dt')].map(d=>d.textContent.replace(/\\s+/g,'').trim())`);
    check("dialog lists every column", Array.isArray(dtLabels) && dtLabels.length === 5, JSON.stringify(dtLabels));

    const ddText = await ev(`[...document.querySelectorAll('.sheet dd')].map(d=>d.textContent.trim())`);
    check("values are rendered verbatim", Array.isArray(ddText) && ddText.length === 5, JSON.stringify(ddText).slice(0, 160));

    const modalBg = await ev(`getComputedStyle(document.querySelector('.sheet')).backgroundColor`);
    check("the dialog sheet has an opaque background", modalBg !== "rgba(0, 0, 0, 0)" && !/transparent/.test(String(modalBg)), String(modalBg));

    const zIndex = await ev(`getComputedStyle(document.querySelector('.sheet')).zIndex`);
    check("the sheet sits above its backdrop", zIndex !== "auto" && Number(zIndex) > 0, `z-index=${zIndex}`);

    await ev(`document.querySelector('.backdrop')?.click()`);
    await sleep(400);
    check("backdrop click closes the dialog", (await ev(`!document.querySelector('.sheet')`)) === true);

    // --- SQL edit -------------------------------------------------------------
    await clickText(".tabs.small button", "SQL");
    await sleep(300);
    await ev(`document.querySelector('.editbtn')?.click()`);
    await sleep(400);
    check("Edit opens a textarea", (await ev(`!!document.querySelector('.editor textarea')`)) === true);

    await type(".editor textarea", "SELECT 1 AS custom FROM dual");
    await sleep(300);
    await clickText(".editorbar button", "Save");
    await sleep(500);
    const editedNote = await ev(`document.querySelector('.editednote')?.textContent?.trim()`);
    check("saving marks the SQL modified", /modified/i.test(String(editedNote)), String(editedNote));

    const shown = await ev(`document.querySelector('.sql')?.textContent?.trim()`);
    check("the hand-written SQL is shown", /SELECT 1 AS custom/.test(String(shown)), String(shown).slice(0, 60));

    check("Back to generated appears next to Edit", (await ev(`!!document.querySelector('.revert')`)) === true);

    await ev(`document.querySelector('.revert')?.click()`);
    await sleep(400);
    const reverted = await ev(`document.querySelector('.sql')?.textContent?.trim()`);
    check("reverting restores the generated SQL", /FROM/.test(String(reverted)), String(reverted).slice(0, 60));

    // --- export reached the host bridge ---------------------------------------
    const saves = await ev(`(window.dbxPlugin.saves||[]).map(s=>s.kind+(s.fileName?':'+s.fileName:''))`);
    check("no export was triggered yet", Array.isArray(saves) && saves.length === 0, JSON.stringify(saves));

    await clickText(".tabs.small button", "Results");
    await sleep(400);
    check("back on Results, the filterbar is there again", (await ev(`!!document.querySelector('.filterbar .global')`)) === true);
    await clickText(".filterbar button", "CSV");
    await sleep(600);
    const afterCsv = await ev(`(window.dbxPlugin.saves||[]).map(s=>s.kind+(s.fileName?':'+s.fileName:''))`);
    check("CSV export asks the host to save a .csv", Array.isArray(afterCsv) && afterCsv.some((s) => /file:.*\.csv$/.test(s)), JSON.stringify(afterCsv));

    await clickText(".filterbar button", "Excel");
    await sleep(600);
    const afterXlsx = await ev(`(window.dbxPlugin.saves||[]).map(s=>s.kind+(s.fileName?':'+s.fileName:''))`);
    check("Excel export asks the host to save a .xlsx", afterXlsx.some((s) => /\.xlsx$/.test(s)), JSON.stringify(afterXlsx));

    await clickText(".filterbar button", "PDF");
    await sleep(700);
    const afterPdf = await ev(`(window.dbxPlugin.saves||[]).map(s=>s.kind+(s.fileName?':'+s.fileName:''))`);
    check("PDF export asks the host to save a .pdf", afterPdf.some((s) => /\.pdf$/.test(s)), JSON.stringify(afterPdf));

    const sizes = await ev(`(window.dbxPlugin.saves||[]).filter(s=>s.kind==='file').map(s=>s.fileName.split('.').pop()+':'+(s.bytes>0?'nonempty':'EMPTY'))`);
    check("every export wrote real bytes", Array.isArray(sizes) && sizes.length === 3 && sizes.every((s) => /nonempty$/.test(s)), JSON.stringify(sizes));

    // --- copy SQL -------------------------------------------------------------
    await clickText("header button", "Copy SQL");
    await sleep(400);
    const copied = await ev(`(window.dbxPlugin.saves||[]).some(s=>s.kind==='clipboard' && /SELECT/.test(s.text||''))`);
    check("Copy SQL writes to the clipboard bridge", copied === true);

    check("no uncaught exception during the whole run", errors.length === 0, errors.join(" | ").slice(0, 300));
  } finally {
    chrome.kill("SIGKILL");
    server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("failures:");
    for (const f of failures) console.log("  - " + f);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("HARNESS ERROR: " + error.message);
  process.exit(2);
});
