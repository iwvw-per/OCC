// ============================================
// 凭据托管（桌面/移动端）
//
// 目标：密码不再只存在于渲染进程。前端把「服务器 id → Authorization 头」交给
// 宿主保存，渲染进程之后不再需要读密码；未来请求也可以由宿主补头。
//
// 存储位置：应用数据目录下的 `credentials.json`（权限 0600）。
// 说明：这是「不进渲染进程」的第一步；进一步可换成系统钥匙串（keyring），
// 但需要在所有桌面/移动平台上补齐依赖与降级路径，单独排期。
// ============================================

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const CREDENTIALS_FILE: &str = "credentials.json";

fn credentials_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir failed: {e}"))?;
    Ok(dir.join(CREDENTIALS_FILE))
}

fn read_all(app: &tauri::AppHandle) -> Result<BTreeMap<String, String>, String> {
    let path = credentials_path(app)?;
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read credentials failed: {e}"))?;
    // 损坏的凭据文件不能阻断应用启动：按空表处理（用户重新输入密码即可）
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn write_all(app: &tauri::AppHandle, data: &BTreeMap<String, String>) -> Result<(), String> {
    let path = credentials_path(app)?;
    let encoded = serde_json::to_string_pretty(data)
        .map_err(|e| format!("encode credentials failed: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, encoded).map_err(|e| format!("write credentials failed: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }

    fs::rename(&tmp, &path).map_err(|e| format!("commit credentials failed: {e}"))
}

/// 保存某台服务器的 Authorization 头。
#[cfg(desktop)]
#[tauri::command]
pub fn credential_set(
    app: tauri::AppHandle,
    server_id: String,
    authorization: String,
) -> Result<(), String> {
    let mut data = read_all(&app)?;
    if authorization.is_empty() {
        data.remove(&server_id);
    } else {
        data.insert(server_id, authorization);
    }
    write_all(&app, &data)
}

/// 是否存在某台服务器的凭据。
#[cfg(desktop)]
#[tauri::command]
pub fn credential_has(app: tauri::AppHandle, server_id: String) -> Result<bool, String> {
    Ok(read_all(&app)?.contains_key(&server_id))
}

/// 删除某台服务器的凭据。
#[cfg(desktop)]
#[tauri::command]
pub fn credential_delete(app: tauri::AppHandle, server_id: String) -> Result<(), String> {
    let mut data = read_all(&app)?;
    data.remove(&server_id);
    write_all(&app, &data)
}
