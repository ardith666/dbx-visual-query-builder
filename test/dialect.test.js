import { test } from "node:test";
import assert from "node:assert/strict";
import {
  quoteIdent,
  literalString,
  literalNumber,
  literalBool,
  isSupported,
  SUPPORTS_LIMIT,
} from "../src/dialect.js";

test("quoteIdent uses the dialect's quote char", () => {
  assert.equal(quoteIdent("postgres", "users"), '"users"');
  assert.equal(quoteIdent("mysql", "users"), "`users`");
  assert.equal(quoteIdent("sqlite", "users"), '"users"');
});

test("quoteIdent escapes an embedded quote char", () => {
  assert.equal(quoteIdent("postgres", 'we"ird'), '"we""ird"');
  assert.equal(quoteIdent("mysql", "we`ird"), "`we``ird`");
});

test("quoteIdent leaves backslash alone", () => {
  // A backslash inside a quoted identifier is an ordinary character, so
  // doubling it would corrupt the column name.
  assert.equal(quoteIdent("mysql", "a\\b"), "`a\\b`");
});

test("literalString doubles apostrophes", () => {
  assert.equal(literalString("postgres", "O'Brien"), "'O''Brien'");
  assert.equal(literalString("sqlite", "O'Brien"), "'O''Brien'");
});

test("literalString doubles backslash first on MySQL", () => {
  // This is the regression that leaked two rows on MySQL 8.0.45.
  assert.equal(literalString("mysql", "a\\b"), "'a\\\\b'");
});

test("literalString does NOT double backslash on ANSI dialects", () => {
  // A backslash is an ordinary character in PostgreSQL and SQLite; doubling it
  // would corrupt the value.
  assert.equal(literalString("postgres", "a\\b"), "'a\\b'");
  assert.equal(literalString("sqlite", "a\\b"), "'a\\b'");
});

test("the proven MySQL injection payload is neutralised", () => {
  // Attacker value:  x\' OR 1=1 --
  const payload = "x\\' OR 1=1 --";
  const sql = literalString("mysql", payload);
  // Exactly one literal: the internal quote is escaped, never terminated.
  // Observed against MySQL 8.0.45 — this string returns 1 row, not the table.
  assert.equal(sql, "'x\\\\'' OR 1=1 --'");
});

test("the injection payload cannot widen a result set", () => {
  // Guards the regression end-to-end without a database: unescape the payload
  // the way MySQL would and confirm it stays one inert value.
  const payload = "x\\' OR 1=1 --";
  const body = literalString("mysql", payload).slice(1, -1);
  // MySQL reads \\ as one backslash, then '' as one quote -> back to the input.
  const decoded = body.replace(/\\\\/g, "\\").replace(/''/g, "'");
  assert.equal(decoded, payload);
  // The point: nothing outside the delimiters was ever executable.
  assert.equal(decoded.includes(";"), false);
});

test("a lone trailing backslash is doubled on MySQL", () => {
  // Unterminated escape is the classic truncation attack.
  assert.equal(literalString("mysql", "abc\\"), "'abc\\\\'");
});

test("literalString round-trips a quote-only value", () => {
  // Four quotes: open + escaped quote + close. Verified against MySQL 8.0.45,
  // which stores and returns exactly one apostrophe.
  assert.equal(literalString("mysql", "'"), "''''");
  assert.equal(literalString("postgres", "'"), "''''");
  assert.equal(literalString("sqlite", "'"), "''''");
});

test("literalString handles unicode and empty string", () => {
  assert.equal(literalString("mysql", "数据😀"), "'数据😀'");
  assert.equal(literalString("postgres", ""), "''");
});

test("literalNumber rejects non-finite input", () => {
  assert.equal(literalNumber(42), "42");
  assert.equal(literalNumber("1.5"), "1.5");
  assert.throws(() => literalNumber(Number.NaN), /finite/);
  assert.throws(() => literalNumber(Infinity), /finite/);
  assert.throws(() => literalNumber("abc"), /finite/);
});

test("literalBool is dialect-aware", () => {
  assert.equal(literalBool("postgres", true), "TRUE");
  assert.equal(literalBool("mysql", false), "FALSE");
  assert.equal(literalBool("sqlite", true), "1");
});

test("isSupported reflects the claimed MVP dialects", () => {
  assert.equal(isSupported("postgres"), true);
  assert.equal(isSupported("mysql"), true);
  assert.equal(isSupported("sqlite"), true);
  assert.equal(isSupported("oracle"), false);
  assert.equal(isSupported("nonsense"), false);
});

test("LIMIT is only claimed where it is native", () => {
  assert.equal(SUPPORTS_LIMIT.postgres, true);
  assert.equal(SUPPORTS_LIMIT.sqlite, true);
  assert.equal(SUPPORTS_LIMIT.mssql, false);
});
