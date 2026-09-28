// Pagination maths, pure so it is testable without a DOM.
// Kept in sync with App.svelte by test/coverage.test.js, which imports both.
// "Show all" sentinel for the page-size picker. The host already caps the row
// count, so paging over everything it returned is meaningful.
export const ALL_ROWS = 0;

export function paging(totalRows, pageSize, page) {
  const size = pageSize === ALL_ROWS ? Math.max(totalRows, 1) : pageSize;
  const count = Math.max(1, Math.ceil(totalRows / size));
  const current = Math.min(count, Math.max(1, page));
  const start = (current - 1) * size;
  const end = Math.min(start + size, totalRows);
  return {
    page: current,
    pageCount: count,
    start,
    end,
    rows: totalRows === 0 ? 0 : end - start,
    label: totalRows === 0 ? "no rows" : `${start + 1}\u2013${end} of ${totalRows}`,
  };
}

export function clampLimit(value, max) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0) return 0;
  return Math.min(Math.floor(n), max);
}
