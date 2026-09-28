import { test } from "node:test";
import assert from "node:assert/strict";
import { paging, clampLimit } from "../src/paging.js";

test("an empty result is one page saying so", () => {
  const p = paging(0, 100, 1);
  assert.deepEqual(
    { page: p.page, pageCount: p.pageCount, rows: p.rows, label: p.label },
    { page: 1, pageCount: 1, rows: 0, label: "no rows" },
  );
});

test("a partial last page reports the real end", () => {
  const p = paging(250, 100, 3);
  assert.equal(p.page, 3);
  assert.equal(p.start, 200);
  assert.equal(p.end, 250);
  assert.equal(p.label, "201\u2013250 of 250");
});

test("an exact multiple has no phantom last page", () => {
  const p = paging(200, 100, 2);
  assert.equal(p.pageCount, 2);
  assert.equal(p.label, "101\u2013200 of 200");
});

test("an out-of-range page is clamped, never blank", () => {
  assert.equal(paging(250, 100, 99).page, 3);
  assert.equal(paging(250, 100, 0).page, 1);
  assert.equal(paging(250, 100, -5).page, 1);
  assert.equal(paging(250, 100, 99).rows, 50);
});

test("every row is reachable across the pages", () => {
  const total = 523;
  const size = 50;
  const seen = new Set();
  for (let page = 1; page <= Math.ceil(total / size); page++) {
    const p = paging(total, size, page);
    for (let i = p.start; i < p.end; i++) seen.add(i);
  }
  assert.equal(seen.size, total, "no gaps and no duplicates across pages");
});

test("clampLimit drops junk instead of emitting bad SQL", () => {
  assert.equal(clampLimit("", 5000), undefined);
  assert.equal(clampLimit(null, 5000), undefined);
  assert.equal(clampLimit("abc", 5000), undefined);
  assert.equal(clampLimit(-3, 5000), 0);
  assert.equal(clampLimit(100, 5000), 100);
  assert.equal(clampLimit("250", 5000), 250);
  assert.equal(clampLimit(99999, 5000), 5000, "host max is 5000");
});
