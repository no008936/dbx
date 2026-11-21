import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const backend = vi.hoisted(() => ({
  createAutoSaveSqlFile: vi.fn(),
  writeExternalSqlFile: vi.fn(),
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
  // closeTab 释放连接会话会调到这个导出；补齐避免 stderr 噪音。
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/backend/api", () => backend);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
// flushPendingPersist 会问窗口上下文；node 测试环境没有 window，钉成主窗口。
vi.mock("@/lib/app/windowContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app/windowContext")>()),
  isDetachedWindow: () => false,
}));
// flushPendingPersist → saveTabs 在 Tauri 下先写 workspace-window 快照（getCurrentWindow 需要 window）；
// 本套件只关心 saveOpenTabsState 通道，钉成 no-op。
vi.mock("@/lib/app/workspaceWindows", () => ({
  saveWorkspaceWindow: vi.fn().mockResolvedValue(undefined),
  loadWorkspaceWindow: vi.fn().mockResolvedValue(null),
  listWorkspaceWindows: vi.fn().mockResolvedValue([]),
}));

import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

describe("queryStore auto save", () => {
  let store: ReturnType<typeof useQueryStore>;
  let tabId: string;
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    settings.updateEditorSettings({ queryAutoSaveMode: "afterDelayAndFocusChange", queryAutoSaveDelayMs: 2000 });
    store = useQueryStore();
    tabId = store.createTab("c1", "db");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("allocates and links a file on the first flush, then goes clean", async () => {
    const t = store.tabs[0];
    store.updateSql(tabId, "SELECT 1;", "editor");
    backend.createAutoSaveSqlFile.mockResolvedValue({ path: "/docs/DBX/queries/20261121-query-001.sql", version: { sizeBytes: 8, modifiedNs: "0", contentHash: "hash1" } });
    await store.flushQueryTabAutoSave(store.tabs[0]);
    expect(backend.createAutoSaveSqlFile).toHaveBeenCalledWith("", "query", "SELECT 1;");
    expect(t.externalSqlPath).toBe("/docs/DBX/queries/20261121-query-001.sql");
    expect(t.autoSaveOrigin).toBe(true);
    expect(t.externalSqlFileVersion).toEqual({ sizeBytes: 8, modifiedNs: "0", contentHash: "hash1" });
    expect(store.isTabDirty(t)).toBe(false);
    expect(t.customTitle).toBe(true);
  });

  it("writes through the external channel on later flushes and stays clean", async () => {
    const t = store.tabs[0];
    store.updateSql(tabId, "SELECT 1;", "editor");
    backend.createAutoSaveSqlFile.mockResolvedValue({ path: "/docs/DBX/queries/20261121-query-001.sql", version: { sizeBytes: 8, modifiedNs: "0", contentHash: "hash1" } });
    await store.flushQueryTabAutoSave(t);
    store.updateSql(tabId, "SELECT 1; -- more", "editor");
    backend.writeExternalSqlFile.mockResolvedValue({ kind: "written", version: { sizeBytes: 18, modifiedNs: "1", contentHash: "hash2" } });
    await store.flushQueryTabAutoSave(t);
    expect(backend.writeExternalSqlFile).toHaveBeenCalledWith("/docs/DBX/queries/20261121-query-001.sql", "SELECT 1; -- more", { expectedContentHash: "hash1", expectedMissing: false, encoding: "utf8" });
    expect(store.isTabDirty(t)).toBe(false);
  });

  it("records autoSaveError without throwing when the backend fails", async () => {
    store.updateSql(tabId, "SELECT 1;", "editor");
    backend.createAutoSaveSqlFile.mockRejectedValue(new Error("disk full"));
    await expect(store.flushQueryTabAutoSave(store.tabs[0])).resolves.toBeUndefined();
    expect(store.tabs[0].autoSaveError).toBe("disk full");
    expect(store.tabs[0].externalSqlPath).toBeUndefined();
  });

  it("schedules flushes on the delay and closes a clean tab without a confirm", async () => {
    store.updateSql(tabId, "SELECT 1;", "editor");
    backend.createAutoSaveSqlFile.mockResolvedValue({ path: "/docs/DBX/queries/20261121-query-001.sql", version: { sizeBytes: 8, modifiedNs: "0", contentHash: "hash1" } });
    await vi.advanceTimersByTimeAsync(2100);
    expect(backend.createAutoSaveSqlFile).toHaveBeenCalledTimes(1);
    store.closeTab(tabId);
    expect(store.tabs).toHaveLength(0);
  });

  it("mode off schedules nothing", async () => {
    useSettingsStore().updateEditorSettings({ queryAutoSaveMode: "off" });
    store.updateSql(tabId, "SELECT 1;", "editor");
    await vi.advanceTimersByTimeAsync(30000);
    expect(backend.createAutoSaveSqlFile).not.toHaveBeenCalled();
  });

  // mode=off 必须真正关闭：自动路径（flushPendingPersist / closeTab flush）不建文件、不转文件 tab；
  // autoSaveOrigin 托管 tab 例外（脏即 flush）；显式手动 flush 绕过 off 门控。
  describe("mode off gating", () => {
    it("flushPendingPersist does not allocate files for dirty unbound tabs", async () => {
      useSettingsStore().updateEditorSettings({ queryAutoSaveMode: "off" });
      store.updateSql(tabId, "SELECT 1;", "editor");
      await store.flushPendingPersist();
      expect(backend.createAutoSaveSqlFile).not.toHaveBeenCalled();
      expect(backend.writeExternalSqlFile).not.toHaveBeenCalled();
    });

    it("closeTab neither allocates a file nor blocks on a dirty unbound tab", () => {
      useSettingsStore().updateEditorSettings({ queryAutoSaveMode: "off", confirmUnsavedSqlClose: false });
      store.updateSql(tabId, "SELECT 1;", "editor");
      store.closeTab(tabId);
      expect(backend.createAutoSaveSqlFile).not.toHaveBeenCalled();
      expect(store.tabs).toHaveLength(0);
    });

    it("flushPendingPersist still writes through an already hosted tab", async () => {
      const t = store.tabs[0];
      store.updateSql(tabId, "SELECT 1;", "editor");
      backend.createAutoSaveSqlFile.mockResolvedValue({ path: "/docs/DBX/queries/20261121-query-001.sql", version: { sizeBytes: 8, modifiedNs: "0", contentHash: "hash1" } });
      await store.flushQueryTabAutoSave(t);
      useSettingsStore().updateEditorSettings({ queryAutoSaveMode: "off" });
      store.updateSql(tabId, "SELECT 1; -- more", "editor");
      backend.writeExternalSqlFile.mockResolvedValue({ kind: "written", version: { sizeBytes: 18, modifiedNs: "1", contentHash: "hash2" } });
      await store.flushPendingPersist();
      expect(backend.writeExternalSqlFile).toHaveBeenCalledTimes(1);
      expect(store.isTabDirty(t)).toBe(false);
    });

    it("an explicit manual flush still allocates a file for unbound candidates", async () => {
      useSettingsStore().updateEditorSettings({ queryAutoSaveMode: "off" });
      store.updateSql(tabId, "SELECT 1;", "editor");
      backend.createAutoSaveSqlFile.mockResolvedValue({ path: "/docs/DBX/queries/20261121-query-001.sql", version: { sizeBytes: 8, modifiedNs: "0", contentHash: "hash1" } });
      await store.flushQueryTabAutoSave(store.tabs[0], { manual: true });
      expect(backend.createAutoSaveSqlFile).toHaveBeenCalledWith("", "query", "SELECT 1;");
      expect(store.tabs[0].autoSaveOrigin).toBe(true);
    });
  });

  // 冲突静默语义：external 写回返回 conflict 时不静默覆盖、不标错误、不标干净、不重试。
  describe("conflict semantics", () => {
    it("a conflict write stays silent: no error marker, tab stays dirty, no retry", async () => {
      const t = store.tabs[0];
      store.updateSql(tabId, "SELECT 1;", "editor");
      backend.createAutoSaveSqlFile.mockResolvedValue({ path: "/docs/DBX/queries/20261121-query-001.sql", version: { sizeBytes: 8, modifiedNs: "0", contentHash: "hash1" } });
      await store.flushQueryTabAutoSave(t);
      store.updateSql(tabId, "SELECT 1; -- more", "editor");
      backend.writeExternalSqlFile.mockResolvedValue({ kind: "conflict", currentVersion: { sizeBytes: 99, modifiedNs: "9", contentHash: "external" } });
      await expect(store.flushQueryTabAutoSave(t)).resolves.toBeUndefined();
      expect(t.autoSaveError).toBeUndefined();
      expect(store.isTabDirty(t)).toBe(true);
      expect(backend.writeExternalSqlFile).toHaveBeenCalledTimes(1);
    });
  });
});
