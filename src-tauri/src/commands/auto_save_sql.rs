use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use chrono::Local;
use serde::Serialize;

use crate::commands::external_sql::{external_sql_file_version, ExternalSqlFileVersion};

const DEFAULT_PREFIX: &str = "query";
const MAX_PREFIX_CHARS: usize = 64;
const MAX_ALLOCATION_ATTEMPTS: usize = 64;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveSqlFileCreated {
    pub path: String,
    pub version: ExternalSqlFileVersion,
}

/// 前缀只保留文件名安全字符，且不以 `.` 开头；空/全非法字符回退 `query`。
pub fn sanitize_auto_save_prefix(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|ch| ch.is_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        .take(MAX_PREFIX_CHARS)
        .collect();
    let cleaned = cleaned.trim_start_matches('.');
    if cleaned.is_empty() {
        DEFAULT_PREFIX.to_string()
    } else {
        cleaned.to_string()
    }
}

/// 空配置回退系统文档目录 `DBX/queries`；自定义目录必须是绝对路径。
pub fn resolve_auto_save_dir(configured: &str) -> Result<PathBuf, String> {
    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        let path = PathBuf::from(trimmed);
        if !path.is_absolute() {
            return Err(format!("auto save directory must be an absolute path: {trimmed}"));
        }
        return Ok(path);
    }
    let documents = dirs::document_dir().ok_or_else(|| "failed to resolve the documents directory".to_string())?;
    Ok(documents.join("DBX").join("queries"))
}

/// 解析 `<prefix>-<NNN>.sql` 或 `<yyyymmdd>-<prefix>-<NNN>.sql` 的编号；不匹配返回 None。
pub fn auto_save_file_number(file_name: &str, prefix: &str) -> Option<u32> {
    let lower = file_name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".sql")?;
    // 兼容 8 位日期前缀：8 位数字 + '-'。
    let stem = match stem.as_bytes() {
        [d @ .., _] if d.len() > 9 && d[..8].iter().all(|b| b.is_ascii_digit()) && d[8] == b'-' => &stem[9..],
        _ => stem,
    };
    let digits = stem.strip_prefix(&format!("{}-", prefix.to_ascii_lowercase()))?;
    if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn next_auto_save_number(dir: &Path, prefix: &str) -> u32 {
    let mut highest = 0u32;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else { continue };
            if let Some(number) = auto_save_file_number(name, prefix) {
                highest = highest.max(number);
            }
        }
    }
    highest + 1
}

fn local_date_compact() -> String {
    Local::now().format("%Y%m%d").to_string()
}

/// 原子占号创建并写入内容。编号 = 目录扫描 max+1；跨窗口并发撞号时
/// `create_new(true)` 返回 AlreadyExists，重扫重试。
pub async fn create_auto_save_sql_file_in(
    dir: PathBuf,
    prefix: &str,
    content: &str,
) -> Result<AutoSaveSqlFileCreated, String> {
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| format!("failed to create the auto save directory {}: {error}", dir.display()))?;
    let bytes = dbx_core::sql::encode_sql_file_text(content, "utf8")?;
    let prefix = sanitize_auto_save_prefix(prefix);
    let date = local_date_compact();
    for _ in 0..MAX_ALLOCATION_ATTEMPTS {
        let number = next_auto_save_number(&dir, &prefix);
        let path = dir.join(format!("{date}-{prefix}-{number:03}.sql"));
        match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&path).await {
            Ok(mut file) => {
                use tokio::io::AsyncWriteExt;
                file.write_all(&bytes).await.map_err(|error| format!("failed to write {}: {error}", path.display()))?;
                file.flush().await.map_err(|error| format!("failed to flush {}: {error}", path.display()))?;
                let metadata = tokio::fs::metadata(&path)
                    .await
                    .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
                return Ok(AutoSaveSqlFileCreated {
                    path: path.to_string_lossy().into_owned(),
                    version: external_sql_file_version(&metadata, &bytes),
                });
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("failed to create {}: {error}", path.display())),
        }
    }
    Err("failed to allocate a unique auto save file number".to_string())
}

#[tauri::command]
pub async fn create_auto_save_sql_file(
    dir: String,
    prefix: String,
    content: String,
) -> Result<AutoSaveSqlFileCreated, String> {
    let resolved = resolve_auto_save_dir(&dir)?;
    create_auto_save_sql_file_in(resolved, &prefix, &content).await
}

/// 目录不存在则创建，返回生效目录（设置面板"打开目录"按钮使用）。
#[tauri::command]
pub async fn ensure_auto_save_dir(dir: String) -> Result<String, String> {
    let resolved = resolve_auto_save_dir(&dir)?;
    tokio::fs::create_dir_all(&resolved)
        .await
        .map_err(|error| format!("failed to create the auto save directory {}: {error}", resolved.display()))?;
    Ok(resolved.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(tag: &str) -> Self {
            let base = std::env::var("DBX_TEST_TMP_DIR").map(Into::into).unwrap_or_else(|_| std::env::temp_dir());
            let dir = base.join(format!("dbx-auto-save-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn prefix_keeps_safe_characters_only() {
        assert_eq!(sanitize_auto_save_prefix("  my queries "), "myqueries");
        assert_eq!(sanitize_auto_save_prefix("../etc"), "etc");
        assert_eq!(sanitize_auto_save_prefix(""), "query");
        assert_eq!(sanitize_auto_save_prefix("///"), "query");
        assert_eq!(sanitize_auto_save_prefix("a_b-c.d"), "a_b-c.d");
    }

    #[test]
    fn file_number_parses_dated_and_plain_names() {
        assert_eq!(auto_save_file_number("20261121-query-001.sql", "query"), Some(1));
        assert_eq!(auto_save_file_number("query-042.sql", "query"), Some(42));
        assert_eq!(auto_save_file_number("20261121-query-1234.sql", "query"), Some(1234));
        assert_eq!(auto_save_file_number("20261121-other-001.sql", "query"), None);
        assert_eq!(auto_save_file_number("20261121-query-001.txt", "query"), None);
        assert_eq!(auto_save_file_number("notes.sql", "query"), None);
        assert_eq!(auto_save_file_number("query-.sql", "query"), None);
    }

    #[test]
    fn number_scans_both_name_shapes() {
        let dir = TestDirectory::new("scan");
        std::fs::write(dir.0.join("query-001.sql"), b"").unwrap();
        std::fs::write(dir.0.join("20261121-query-007.sql"), b"").unwrap();
        std::fs::write(dir.0.join("unrelated.txt"), b"").unwrap();
        assert_eq!(next_auto_save_number(&dir.0, "query"), 8);
    }

    #[tokio::test]
    async fn create_allocates_and_writes_content() {
        let dir = TestDirectory::new("create");
        let created = create_auto_save_sql_file_in(dir.0.clone(), "query", "SELECT 1;").await.unwrap();
        let name = std::path::Path::new(&created.path).file_name().unwrap().to_str().unwrap().to_string();
        assert!(name.ends_with("-query-001.sql"), "unexpected name {name}");
        assert!(name.split('-').next().unwrap().len() == 8, "date prefix missing");
        assert_eq!(std::fs::read_to_string(&created.path).unwrap(), "SELECT 1;");
        assert!(created.version.size_bytes > 0);
        assert!(!created.version.content_hash.is_empty());
    }

    #[tokio::test]
    async fn create_never_overwrites_and_retries() {
        let dir = TestDirectory::new("retry");
        std::fs::write(dir.0.join("20260101-query-001.sql"), b"existing").unwrap();
        let created = create_auto_save_sql_file_in(dir.0.clone(), "query", "SELECT 2;").await.unwrap();
        assert_eq!(std::fs::read(dir.0.join("20260101-query-001.sql")).unwrap(), b"existing");
        assert_ne!(std::path::Path::new(&created.path).file_name().unwrap(), "20260101-query-001.sql");
        assert_eq!(std::fs::read_to_string(&created.path).unwrap(), "SELECT 2;");
    }

    #[tokio::test]
    async fn relative_custom_dir_is_rejected() {
        assert!(resolve_auto_save_dir("relative/dir").is_err());
    }
}
