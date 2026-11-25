package com.udownload.engine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the process alive while downloads run, so sharing a video and going
 * straight back to YouTube does not get the download killed.
 *
 * Reference-counted by running yt-dlp invocations rather than started per
 * job: one notification, and the service lives exactly as long as any work.
 */
class DownloadService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification(this, active)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_NOT_STICKY
    }

    /** Android 15's six-hour dataSync budget is spent; the system requires a prompt stop. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "dataSync budget exhausted; downloads continue only while the app is visible")
        stopSelf()
    }

    companion object {
        private const val TAG = "UdlDownloadService"
        private const val CHANNEL_ID = "downloads"
        private const val NOTIFICATION_ID = 4100
        /**
         * The queue starts the next job right after one finishes. Stopping at
         * once would make that next start a background foreground-service
         * start, which Android 12+ forbids.
         */
        private const val STOP_GRACE_MS = 3_000L

        private val handler = Handler(Looper.getMainLooper())
        @Volatile private var active = 0
        private val lock = Any()

        fun acquire(context: Context) {
            val count = synchronized(lock) { ++active }
            val app = context.applicationContext
            // Also drops a pending stop from the previous job's release.
            handler.removeCallbacksAndMessages(null)
            handler.post { start(app, count) }
        }

        fun release(context: Context) {
            val count = synchronized(lock) {
                active = (active - 1).coerceAtLeast(0)
                active
            }
            val app = context.applicationContext
            if (count > 0) {
                handler.post { notify(app, count) }
                return
            }
            handler.postDelayed({
                if (active == 0) app.stopService(Intent(app, DownloadService::class.java))
            }, STOP_GRACE_MS)
        }

        private fun start(context: Context, count: Int) {
            try {
                ContextCompat.startForegroundService(context, Intent(context, DownloadService::class.java))
            } catch (e: Exception) {
                // Started from the background (Android 12+): the download still
                // runs, it is just not protected from being killed.
                Log.w(TAG, "could not start foreground service", e)
            }
            notify(context, count)
        }

        private fun notify(context: Context, count: Int) {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            try {
                manager.notify(NOTIFICATION_ID, buildNotification(context, count))
            } catch (e: SecurityException) {
                Log.w(TAG, "notification permission denied", e)
            }
        }

        private fun buildNotification(context: Context, count: Int): Notification {
            val manager = context.getSystemService(NotificationManager::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager?.getNotificationChannel(CHANNEL_ID) == null) {
                manager?.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Downloads", NotificationManager.IMPORTANCE_LOW)
                )
            }
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val tap = launch?.let {
                PendingIntent.getActivity(
                    context, 0, it,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
            }
            val title = if (count == 1) "Downloading 1 item" else "Downloading $count items"
            return NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(title)
                .setContentText("U-Download")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(tap)
                .build()
        }
    }
}
