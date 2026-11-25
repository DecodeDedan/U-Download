package com.udownload.engine

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.util.Log
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.yausername.aria2c.Aria2c
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLException
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
import java.util.Collections
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

@InvokeArg
class SubscribeArgs {
    lateinit var channel: Channel
}

@InvokeArg
class ExecuteArgs {
    lateinit var jobId: String
    var args: Array<String> = arrayOf()
    var mergeStderr: Boolean = true
}

@InvokeArg
class JobArgs {
    lateinit var jobId: String
}

@InvokeArg
class PathArgs {
    lateinit var path: String
}

/**
 * Wraps youtubedl-android for the Rust job queue.
 *
 * Tauri runs these commands on the main thread, so everything that touches
 * the engine is handed to [executor]; the Rust caller is a worker thread that
 * blocks until the invoke resolves.
 */
@TauriPlugin
class EnginePlugin(private val activity: Activity) : Plugin(activity) {
    private val executor: ExecutorService = Executors.newCachedThreadPool()
    private val context get() = activity.applicationContext

    /** The one-time unpack of Python and yt-dlp; seconds on first launch. */
    private lateinit var ready: Future<Unit>

    @Volatile private var channel: Channel? = null
    @Volatile private var pendingShare: String? = null

    /**
     * Ids cancelled before their process existed. youtubedl-android can only
     * destroy a registered process, so a cancel landing between the Rust claim
     * and `execute` registering the process would otherwise be lost.
     */
    private val cancelled: MutableSet<String> = Collections.synchronizedSet(HashSet())

    /**
     * Running yt-dlp invocations hold the read side; an update holds the write
     * side, because it replaces the yt-dlp file those processes are reading.
     */
    private val ytdlpFile = ReentrantReadWriteLock()

    /** True once the frontend has pulled the cold-start share; later shares are pushed. */
    @Volatile private var webviewListening = false

    override fun load(webView: WebView) {
        ready = executor.submit(Callable {
            YoutubeDL.getInstance().init(context)
            FFmpeg.getInstance().init(context)
            Aria2c.getInstance().init(context)
        })
        requestLegacyStorageIfNeeded()
        // Cold start from the share sheet: the intent that launched us.
        handleShare(activity.intent)
    }

    override fun onNewIntent(intent: Intent) {
        handleShare(intent)
    }

    private fun handleShare(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() } ?: return
        // Consumed so a configuration change cannot replay the same share.
        intent.removeExtra(Intent.EXTRA_TEXT)
        // Before the frontend has asked once, a pushed event would arrive
        // ahead of its listener and be lost; it pulls via takeSharedText.
        val sink = channel
        if (sink != null && webviewListening) {
            sink.send(JSObject().put("kind", "share").put("text", text))
        } else {
            pendingShare = text
        }
    }

    private fun requestLegacyStorageIfNeeded() {
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P) return
        val permission = Manifest.permission.WRITE_EXTERNAL_STORAGE
        if (ContextCompat.checkSelfPermission(context, permission) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(activity, arrayOf(permission), STORAGE_REQUEST)
        }
    }

    private fun outputDir(): File {
        @Suppress("DEPRECATION") // The public path is what yt-dlp needs; MediaStore has no File API.
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        return File(downloads, "U-Download").apply { mkdirs() }
    }

    /** Where youtubedl-android unpacks Python's CA bundle; aria2c needs it explicitly. */
    private fun caBundle(): File =
        File(context.noBackupFilesDir, "youtubedl-android/packages/python/usr/etc/tls/cert.pem")

    @Command
    fun subscribe(invoke: Invoke) {
        channel = invoke.parseArgs(SubscribeArgs::class.java).channel
        invoke.resolve()
    }

    @Command
    fun takeSharedText(invoke: Invoke) {
        val text = pendingShare
        pendingShare = null
        webviewListening = true
        invoke.resolve(JSObject().put("text", text))
    }

    @Command
    fun initialize(invoke: Invoke) {
        executor.execute {
            try {
                ready.get()
                invoke.resolve(
                    JSObject()
                        .put("caBundle", caBundle().absolutePath)
                        .put("defaultOutputDir", outputDir().absolutePath)
                        .put("tempDir", File(context.cacheDir, "downloads").apply { mkdirs() }.absolutePath)
                        .put("ytdlpVersion", YoutubeDL.getInstance().version(context) ?: "unknown")
                )
            } catch (e: Exception) {
                Log.e(TAG, "engine init failed", e)
                invoke.reject(e.cause?.message ?: e.message ?: "engine init failed")
            }
        }
    }

    @Command
    fun execute(invoke: Invoke) {
        val args = invoke.parseArgs(ExecuteArgs::class.java)
        executor.execute { ytdlpFile.read { run(invoke, args) } }
    }

    private fun run(invoke: Invoke, args: ExecuteArgs) {
        val jobId = args.jobId
        try {
            ready.get()
        } catch (e: Exception) {
            invoke.resolve(failed(e.cause?.message ?: e.message ?: "engine init failed"))
            return
        }
        if (cancelled.remove(jobId)) {
            invoke.resolve(JSObject().put("status", "cancelled"))
            return
        }

        val engine = YoutubeDL.getInstance()
        val request = YoutubeDLRequest(emptyList<String>()).addCommands(args.args.toList())
        DownloadService.acquire(context)
        try {
            val response = engine.execute(
                request,
                jobId,
                redirectErrorStream = args.mergeStderr
            ) { _, _, line ->
                if (cancelled.contains(jobId)) engine.destroyProcessById(jobId)
                channel?.send(JSObject().put("kind", "line").put("jobId", jobId).put("line", line))
            }
            invoke.resolve(JSObject().put("status", "completed").put("stdout", response.out))
        } catch (e: YoutubeDL.CanceledException) {
            invoke.resolve(JSObject().put("status", "cancelled"))
        } catch (e: YoutubeDLException) {
            // A process killed by `cancel` exits non-zero; report it as such.
            if (cancelled.contains(jobId)) {
                invoke.resolve(JSObject().put("status", "cancelled"))
            } else {
                invoke.resolve(failed(e.message ?: ""))
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            invoke.resolve(JSObject().put("status", "cancelled"))
        } catch (e: Exception) {
            Log.e(TAG, "job $jobId crashed", e)
            invoke.resolve(failed(e.message ?: e.javaClass.simpleName))
        } finally {
            cancelled.remove(jobId)
            DownloadService.release(context)
        }
    }

    private fun failed(message: String) = JSObject().put("status", "failed").put("message", message)

    @Command
    fun cancel(invoke: Invoke) {
        val jobId = invoke.parseArgs(JobArgs::class.java).jobId
        cancelled.add(jobId)
        YoutubeDL.getInstance().destroyProcessById(jobId)
        invoke.resolve()
    }

    @Command
    fun scanMedia(invoke: Invoke) {
        val path = invoke.parseArgs(PathArgs::class.java).path
        MediaScannerConnection.scanFile(context, arrayOf(path), null, null)
        invoke.resolve()
    }

    @Command
    fun updateYtdlp(invoke: Invoke) {
        executor.execute {
            try {
                ready.get()
                ytdlpFile.write {
                    YoutubeDL.getInstance().updateYoutubeDL(context, YoutubeDL.UpdateChannel.STABLE)
                }
                invoke.resolve(JSObject().put("version", YoutubeDL.getInstance().version(context) ?: "unknown"))
            } catch (e: Exception) {
                Log.e(TAG, "yt-dlp update failed", e)
                invoke.reject(e.message ?: "update failed")
            }
        }
    }

    companion object {
        private const val TAG = "UdlEngine"
        private const val STORAGE_REQUEST = 4101
    }
}
