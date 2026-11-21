import { describe, expect, it } from "vitest";
import { autoSaveDisplayName, isQueryTabAutoSaveCandidate, queryAutoSaveWatchesDelay, queryAutoSaveWatchesFocusChange } from "@/lib/sql/queryTabAutoSave";
import type { QueryTab } from "@/types/database";

function tab(overrides: Partial<QueryTab>): QueryTab {
  return { id: "t1", title: "query_1", connectionId: "c1", database: "db", mode: "query", sql: "SELECT 1", isExecuting: false, ...overrides } as QueryTab;
}
const dirty = (t: QueryTab) => t.sql !== (t.originalSql ?? "");

describe("query auto save triggers", () => {
  it("maps modes to triggers", () => {
    expect(queryAutoSaveWatchesDelay({ queryAutoSaveMode: "afterDelayAndFocusChange" })).toBe(true);
    expect(queryAutoSaveWatchesDelay({ queryAutoSaveMode: "afterDelay" })).toBe(true);
    expect(queryAutoSaveWatchesDelay({ queryAutoSaveMode: "onFocusChange" })).toBe(false);
    expect(queryAutoSaveWatchesFocusChange({ queryAutoSaveMode: "onFocusChange" })).toBe(true);
    expect(queryAutoSaveWatchesFocusChange({ queryAutoSaveMode: "off" })).toBe(false);
  });

  it("only dirty unbound query tabs with content are candidates", () => {
    expect(isQueryTabAutoSaveCandidate(tab({}), dirty)).toBe(true);
    expect(isQueryTabAutoSaveCandidate(tab({ sql: "SELECT 1", originalSql: "SELECT 1" }), dirty)).toBe(false);
    expect(isQueryTabAutoSaveCandidate(tab({ sql: "  " }), dirty)).toBe(false);
    expect(isQueryTabAutoSaveCandidate(tab({ externalSqlPath: "/tmp/a.sql" }), dirty)).toBe(false);
    expect(isQueryTabAutoSaveCandidate(tab({ objectSource: { name: "v" } } as Partial<QueryTab>), dirty)).toBe(false);
    expect(isQueryTabAutoSaveCandidate(tab({ mode: "data" }), dirty)).toBe(false);
  });

  it("prefilled clean tabs are not candidates until edited", () => {
    const prefilled = tab({ sql: "SELECT 1;", originalSql: "SELECT 1;" });
    expect(isQueryTabAutoSaveCandidate(prefilled, dirty)).toBe(false);
    prefilled.sql = "SELECT 1; -- edited";
    expect(isQueryTabAutoSaveCandidate(prefilled, dirty)).toBe(true);
  });

  it("display name strips directory and sql suffix", () => {
    expect(autoSaveDisplayName("/docs/DBX/queries/20261121-query-001.sql")).toBe("20261121-query-001");
    expect(autoSaveDisplayName("C:\\docs\\20261121-query-002.sql")).toBe("20261121-query-002");
  });
});
