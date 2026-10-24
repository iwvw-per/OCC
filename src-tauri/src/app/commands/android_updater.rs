// ============================================
// android_updater — Android 端一键更新的 Rust 侧能力
//
// tauri-plugin-updater 不支持 Android（capabilities/updater.json 按平台排除），
// 所以这里只提供两个小命令：
//   - device_target_arch：告诉前端该下 arm64 还是 armv7 的包
//   - android_download_apk：把 APK 下到缓存目录并回报进度
//
// 安装本身交给系统安装器（前端用 opener 打开文件），不在应用内静默安装：
// Android 不允许普通应用静默安装 APK，必须有用户确认。
// ============================================

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// 下载进度事件，形状与桌面端 `UpdaterDownloadEvent` 保持一致，
/// 前端可以用同一套处理逻辑。
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: u64 },
    Finished,
}

/// 下载选项（由前端传入，因此需要 Deserialize）。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOptions {
    /// 超时毫秒数（整次下载）
    pub timeout: Option<u64>,
}

#[derive(Serialize)]
pub struct DownloadResult {
    pub path: String,
}

/// 当前设备应使用的 APK 架构。
///
/// 前端据此在 arm64 / armv7 两个资产里选一个。用编译期目标架构判定，
/// 比前端猜 `navigator.userAgent` 可靠（分包安装、模拟器、x86 设备都有坑）。
#[tauri::command]
pub fn device_target_arch() -> &'static str {
    std::env::consts::ARCH
}

/// 下载 APK 到应用缓存目录，返回本地绝对路径。
#[tauri::command]
pub async fn android_download_apk(
    app: AppHandle,
    url: String,
    file_name: String,
    on_event: Channel<DownloadEvent>,
    options: Option<DownloadOptions>,
) -> Result<DownloadResult, String> {
    let dir = cache_dir(&app)?;

    // 文件名来自 release tag，做一次白名单过滤：只允许字母数字与 . - _ 和 v
    let safe_name: String = file_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    if safe_name.is_empty() {
        return Err("非法的文件名".into());
    }
    let target: PathBuf = dir.join(&safe_name);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(
            options.and_then(|o| o.timeout).unwrap_or(5 * 60 * 1000),
        ))
        .build()
        .map_err(|err| format!("创建下载客户端失败: {err}"))?;

    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|err| format!("下载 APK 失败: {err}"))?;

    if !response.status().is_success() {
        return Err(format!("下载 APK 失败: HTTP {}", response.status()));
    }

    let total = response.content_length();
    let _ = on_event.send(DownloadEvent::Started {
        content_length: total,
    });

    let mut file = tokio::fs::File::create(&target)
        .await
        .map_err(|err| format!("创建文件失败: {err}"))?;

    use tokio::io::AsyncWriteExt;
    let mut downloaded: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("读取下载内容失败: {err}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|err| format!("写入文件失败: {err}"))?;
        downloaded += chunk.len() as u64;
        let _ = on_event.send(DownloadEvent::Progress {
            chunk_length: chunk.len() as u64,
        });
    }
    file.flush().await.map_err(|err| format!("写入文件失败: {err}"))?;
    drop(file);

    // 体积兜底：服务端给过 Content-Length 就核对一次，防止半截文件被当成
    // 正常 APK 交给安装器（那会以「解析包错误」失败，用户看不懂原因）。
    if let Some(expected) = total {
        let actual = std::fs::metadata(&target)
            .map(|m| m.len())
            .map_err(|err| format!("读取文件信息失败: {err}"))?;
        if actual != expected {
            return Err(format!(
                "下载不完整：期望 {expected} 字节，实际 {actual} 字节"
            ));
        }
    }

    let _ = on_event.send(DownloadEvent::Finished);

    Ok(DownloadResult {
        path: target.to_string_lossy().to_string(),
    })
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("取缓存目录失败: {err}"))?
        .join("updates");
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建缓存目录失败: {err}"))?;
    Ok(dir)
}
