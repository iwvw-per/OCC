package com.opencodeui.occ

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.JavascriptInterface
import androidx.core.content.FileProvider
import java.io.File

/**
 * 安装已下载的 APK（应用内一键更新的最后一步）。
 *
 * 为什么不能用 `@tauri-apps/plugin-opener` 的 openPath：
 * 该插件的 Android 实现（`OpenerPlugin.kt`）**只注册了 `open` 命令**，
 * 没有 `open_path`。JS 端 `openPath()` → `invoke('plugin:opener|open_path')`
 * 在 Android 上直接失败；即便能用，它也只做 `ACTION_VIEW` + `file://`，
 * Android 7+ 会抛 FileUriExposedException。结果就是「APK 下载完了，但点不动 /
 * 毫无反应」—— 用户看到的正是「安卓无法一键更新」。
 *
 * 正确做法：FileProvider 生成 `content://` URI → `ACTION_INSTALL_PACKAGE` /
 * `ACTION_VIEW`，并授予临时读权限。系统安装器负责签名校验与用户确认。
 */
class ApkInstallerBridge(private val activity: MainActivity) {

  /** APK 存放目录，与 Rust 侧 `cache_dir()` 保持一致（cacheDir/updates）。 */
  private fun updatesDir(): File = File(activity.cacheDir, "updates")

  private fun authority(): String = "${activity.packageName}.fileprovider"

  /** 调用方必须在 Android 8+ 打开「安装未知应用」权限，否则系统安装器会直接拒绝。 */
  @JavascriptInterface
  fun canRequestInstall(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
    return activity.packageManager.canRequestPackageInstalls()
  }

  /** 跳到本应用的「安装未知应用」授权页。返回后由前端重新调用 install 即可。 */
  @JavascriptInterface
  fun openInstallPermissionSettings(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
    return try {
      val intent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${activity.packageName}")
      )
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      // 同样必须回主线程（JavaBridge 线程不能拉起 Activity）
      activity.runOnUiThread {
        try {
          activity.startActivity(intent)
        } catch (error: Exception) {
          android.util.Log.w("ApkInstaller", "open settings failed: ${error.message}")
        }
      }
      true
    } catch (_: Exception) {
      false
    }
  }

  /**
   * 打开系统安装界面。
   *
   * @param fileName 仅文件名（不接受路径），必须在 updates 目录内 —— 防止通过
   *   JS 桥把任意路径包装成 content:// 交给安装器。
   * @return null 表示已成功拉起安装界面；否则返回错误描述。
   */
  @JavascriptInterface
  fun install(fileName: String): String? {
    val safeName = fileName.substringAfterLast('/').substringAfterLast('\\')
    if (safeName.isEmpty() || safeName.contains("..")) return "invalid file name"

    val file = File(updatesDir(), safeName)
    if (!file.isFile || file.length() <= 0L) return "installer file missing"

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      !activity.packageManager.canRequestPackageInstalls()
    ) {
      return "install permission required"
    }

    return try {
      val uri = FileProvider.getUriForFile(activity, authority(), file)
      val viewIntent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      // 个别 ROM 不认 ACTION_VIEW，用 ACTION_INSTALL_PACKAGE 兜底
      val canView = activity.packageManager
        .queryIntentActivities(viewIntent, PackageManager.MATCH_DEFAULT_ONLY)
        .isNotEmpty()
      val target = if (canView) {
        viewIntent
      } else {
        Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
          data = uri
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
      }
      /**
       * ⚠️ 必须切到主线程再 startActivity。
       *
       * `@JavascriptInterface` 方法运行在 WebView 的 JavaBridge 线程，不是 UI 线程；
       * 从非 UI 线程拉起 Activity 在部分 ROM 上会抛
       * "Calling startActivity() from outside of an Activity context requires
       * the FLAG_ACTIVITY_NEW_TASK flag" 之外的时序异常，或静默失败。
       */
      activity.runOnUiThread {
        try {
          activity.startActivity(target)
        } catch (error: Exception) {
          android.util.Log.w("ApkInstaller", "startActivity failed: ${error.message}")
        }
      }
      null
    } catch (error: Exception) {
      error.message ?: error.javaClass.simpleName
    }
  }
}
