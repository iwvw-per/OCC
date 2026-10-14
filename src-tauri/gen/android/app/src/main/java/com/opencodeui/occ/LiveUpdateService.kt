package com.opencodeui.occ

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import org.json.JSONObject

/**
 * 会话进行中保持进程存活的前台服务。
 * 其前台通知即实况通知（同 id 9001），避免出现两条常驻通知。
 * WebView 被后台冻结时进程仍存活，保证 SSE 事件持续处理、通知持续更新。
 *
 * 状态持久化：把最后一次 payload 存入 SharedPreferences，服务被系统重启
 * （START_STICKY，intent 为 null）时据此恢复通知，不依赖前端 JS。
 */
class LiveUpdateService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    LiveUpdateNotification.ensureChannel(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val json = intent?.getStringExtra(EXTRA_JSON)
    // 有 payload 就持久化，供进程/服务重启后恢复
    if (json != null) savePayload(this, json)

    val payload = json ?: loadPayload(this)
    val built = if (payload != null && !isExpiredPayload(payload)) {
      try {
        LiveUpdateNotification.build(this, JSONObject(payload))
      } catch (_: Exception) {
        placeholder()
      }
    } else {
      placeholder()
    }
    try {
      ServiceCompat.startForeground(
        this,
        LiveUpdateNotification.ID,
        built,
        if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
      )
    } catch (_: Exception) {
      // 前台服务启动失败不应影响主流程
    }
    return START_STICKY
  }

  private fun placeholder() = LiveUpdateNotification.build(this, JSONObject().apply {
    put("title", getString(R.string.app_name))
    put("body", "正在后台保持连接")
  })

  override fun onDestroy() {
    super.onDestroy()
    // 服务被正常停止（end）时清掉持久化状态；被系统杀死时不会走到这里
    // （由 START_STICKY 重启并恢复）
  }

  companion object {
    private const val EXTRA_JSON = "live_update_json"
    private const val PREFS = "opencode_live_update"
    private const val KEY_PAYLOAD = "payload"
    /** 持久化状态的最长有效期：超过则视为会话早已结束，不再恢复 */
    private const val MAX_AGE_MS = 30 * 60 * 1000L

    private fun prefs(context: Context): SharedPreferences =
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun savePayload(context: Context, json: String) {
      try {
        prefs(context).edit().putString(KEY_PAYLOAD, json).apply()
      } catch (_: Exception) {
        // ignore
      }
    }

    private fun loadPayload(context: Context): String? {
      return try {
        prefs(context).getString(KEY_PAYLOAD, null)
      } catch (_: Exception) {
        null
      }
    }

    private fun clearPayload(context: Context) {
      try {
        prefs(context).edit().remove(KEY_PAYLOAD).apply()
      } catch (_: Exception) {
        // ignore
      }
    }

    /** 持久化状态是否已过期：会话大概率早已结束，避免重开时显示陈旧通知。 */
    private fun isExpiredPayload(json: String): Boolean {
      return try {
        val updatedAt = JSONObject(json).optLong("updatedAt", 0L)
        if (updatedAt <= 0L) return false
        System.currentTimeMillis() - updatedAt > MAX_AGE_MS
      } catch (_: Exception) {
        false
      }
    }

    fun start(context: Context, json: String) {
      val intent = Intent(context, LiveUpdateService::class.java).putExtra(EXTRA_JSON, json)
      try {
        context.startForegroundService(intent)
      } catch (_: Exception) {
        // ignore
      }
    }

    /** 用持久化的 payload 恢复前台服务（不带新 payload，避免覆盖）。 */
    fun restore(context: Context) {
      try {
        context.startForegroundService(Intent(context, LiveUpdateService::class.java))
      } catch (_: Exception) {
        // ignore
      }
    }

    /** 保存最新 payload（update 时也调用），供服务/进程重启后恢复。 */
    fun save(context: Context, json: String) {
      savePayload(context, json)
    }

    /** 是否存在未过期的持久化活跃状态。 */
    fun hasPersisted(context: Context): Boolean {
      val payload = loadPayload(context) ?: return false
      return !isExpiredPayload(payload)
    }

    fun stop(context: Context) {
      clearPayload(context)
      try {
        context.stopService(Intent(context, LiveUpdateService::class.java))
      } catch (_: Exception) {
        // ignore
      }
    }
  }
}
