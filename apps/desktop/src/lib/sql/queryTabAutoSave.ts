import type { EditorSettings } from "@/stores/settingsStore";
import type { QueryTab } from "@/types/database";

export function queryAutoSaveWatchesDelay(settings: Pick<EditorSettings, "queryAutoSaveMode">): boolean {
  return settings.queryAutoSaveMode === "afterDelay" || settings.queryAutoSaveMode === "afterDelayAndFocusChange";
}

export function queryAutoSaveWatchesFocusChange(settings: Pick<EditorSettings, "queryAutoSaveMode">): boolean {
  return settings.queryAutoSaveMode === "onFocusChange" || settings.queryAutoSaveMode === "afterDelayAndFocusChange";
}

/**
 * 未绑定文件、非对象源码、有内容且已编辑的查询 tab 才会占号落盘。
 * `isTabDirty` 由调用方注入（queryStore.isTabDirty），保持本模块无 store 依赖。
 */
export function isQueryTabAutoSaveCandidate(tab: QueryTab, isTabDirty: (tab: QueryTab) => boolean): boolean {
  return tab.mode === "query" && !tab.externalSqlPath && !tab.objectSource && !tab.sourceLoad && tab.sql.trim().length > 0 && isTabDirty(tab);
}

export function autoSaveDisplayName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.sql$/i, "");
}
