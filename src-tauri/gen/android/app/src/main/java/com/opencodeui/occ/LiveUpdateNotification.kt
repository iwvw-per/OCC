package com.opencodeui.occ

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import org.json.JSONObject

object LiveUpdateNotification {
  const val CHANNEL_ID = "opencode_live_update"
  const val ID = 9001

  private const val WORKING_COLOR = 0xFF3DDC84.toInt()
  private const val BLOCKED_COLOR = 0xFFFF9800.toInt()

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_ID) == null) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "AI 任务进度",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "显示 AI 生成等任务的实时进度"
        setShowBadge(false)
      }
      nm.createNotificationChannel(channel)
    }
  }

  fun build(context: Context, obj: JSONObject): Notification {
    val id = obj.optInt("id", ID)
    val title = obj.optString("title", "OpenCode")
    val body = obj.optString("body", "")
    val subText = obj.optString("subText", "")
    val shortText = obj.optString("shortText", "")
    val sessionId = obj.optString("sessionId", "")
    val hasProgress = obj.has("progress")
    val progress = obj.optInt("progress", 0).coerceIn(0, 100)
    val indeterminate = obj.optBoolean("indeterminate", false)
    val segmentsJson = obj.optJSONArray("segments")
    val segmentCount = segmentsJson?.length() ?: 0

    val intent = Intent(context, MainActivity::class.java).apply {
      action = Intent.ACTION_VIEW
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra("opencode_session_id", sessionId)
    }
    val pendingIntent = PendingIntent.getActivity(
      context,
      id,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    // 多会话分段进度条：NotificationCompat 无法承载 framework 的 ProgressStyle，
    // 需用 framework Notification.Builder（API 36+）。
    if (Build.VERSION.SDK_INT >= 36 && segmentCount >= 2) {
      return buildWithProgressStyle(context, title, body, subText, shortText, pendingIntent, segmentsJson!!)
    }

    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_opencode)
      .setContentTitle(title)
      .setContentText(body)
      .setContentIntent(pendingIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
    if (subText.isNotEmpty()) {
      builder.setSubText(subText)
    }
    if (indeterminate) {
      builder.setProgress(0, 0, true)
    } else if (hasProgress) {
      builder.setProgress(100, progress, false)
    } else {
      builder.setProgress(0, 0, true)
    }
    // 请求系统提升为实况通知（Android 16+）。
    // hasPromotableCharacteristics() 要求：ongoing、有 contentTitle、标准/Progress 样式、
    // 不能 colorized、不能是 groupSummary、channel 非 IMPORTANCE_MIN。
    // setRequestPromotedOngoing 与 EXTRA_REQUEST_PROMOTED_ONGOING 在 API 36.1 才加入，
    // 因此在 compileSdk 36 下用 extra 字符串键请求提升（对 36.1/37 均有效）。
    builder.getExtras().putBoolean("android.requestPromotedOngoing", true)
    if (Build.VERSION.SDK_INT >= 36 && shortText.isNotEmpty()) {
      builder.getExtras().putString("android.shortCriticalText", shortText)
    }
    return builder.build()
  }

  private fun buildWithProgressStyle(
    context: Context,
    title: String,
    body: String,
    subText: String,
    shortText: String,
    pendingIntent: PendingIntent,
    segmentsJson: org.json.JSONArray,
  ): Notification {
    val builder = Notification.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_opencode)
      .setContentTitle(title)
      .setContentText(body)
      .setContentIntent(pendingIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
    if (subText.isNotEmpty()) {
      builder.setSubText(subText)
    }

    val style = Notification.ProgressStyle()
    val segments = ArrayList<Notification.ProgressStyle.Segment>(segmentsJson.length())
    for (i in 0 until segmentsJson.length()) {
      val segObj = segmentsJson.optJSONObject(i)
      val blocked = segObj?.optBoolean("blocked", false) ?: false
      val segment = Notification.ProgressStyle.Segment(100)
      segment.setColor(if (blocked) BLOCKED_COLOR else WORKING_COLOR)
      segments.add(segment)
    }
    style.setProgressSegments(segments)
    style.setProgress(segmentsJson.length() * 100)
    // 覆盖系统默认的进度标记图标（ColorOS 会显示一个飞机），用透明图标隐藏。
    style.setProgressTrackerIcon(
      android.graphics.drawable.Icon.createWithResource(context, R.drawable.ic_progress_tracker_transparent)
    )
    builder.setStyle(style)

    // framework Builder 在 compileSdk 36 下没有 setRequestPromotedOngoing（API 36.1 才加入），
    // 用 extra 字符串键请求提升；shortCriticalText 用 API 36 的 setShortCriticalText。
    builder.addExtras(Bundle().apply {
      putBoolean("android.requestPromotedOngoing", true)
    })
    if (shortText.isNotEmpty()) {
      builder.setShortCriticalText(shortText)
    }
    return builder.build()
  }
}
