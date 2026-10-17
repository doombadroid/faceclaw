@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.roundToInt
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.convert
import kotlinx.cinterop.readValue
import kotlinx.cinterop.useContents
import kotlinx.cinterop.usePinned
import platform.AVFAudio.AVAudioSession
import platform.AVFAudio.AVAudioSessionCategoryPlayAndRecord
import platform.AVFAudio.AVAudioSessionCategoryPlayback
import platform.AVFAudio.AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
import platform.AVFAudio.setActive
import platform.AVFoundation.AVAssetTrack
import platform.AVFoundation.AVMediaTypeAudio
import platform.AVFoundation.AVMediaTypeVideo
import platform.AVFoundation.AVPlayer
import platform.AVFoundation.AVPlayerItem
import platform.AVFoundation.AVPlayerItemDidPlayToEndTimeNotification
import platform.AVFoundation.AVPlayerItemStatusFailed
import platform.AVFoundation.AVPlayerItemVideoOutput
import platform.AVFoundation.AVURLAsset
import platform.AVFoundation.addOutput
import platform.AVFoundation.currentItem
import platform.AVFoundation.currentTime
import platform.AVFoundation.duration
import platform.AVFoundation.muted
import platform.AVFoundation.naturalSize
import platform.AVFoundation.pause
import platform.AVFoundation.play
import platform.AVFoundation.preferredTransform
import platform.AVFoundation.seekToTime
import platform.AVFoundation.tracksWithMediaType
import platform.CoreMedia.CMTimeGetSeconds
import platform.CoreMedia.CMTimeMakeWithSeconds
import platform.CoreMedia.kCMTimeZero
import platform.CoreVideo.CVPixelBufferGetBaseAddressOfPlane
import platform.CoreVideo.CVPixelBufferGetBytesPerRowOfPlane
import platform.CoreVideo.CVPixelBufferGetHeightOfPlane
import platform.CoreVideo.CVPixelBufferGetWidthOfPlane
import platform.CoreVideo.CVPixelBufferLockBaseAddress
import platform.CoreVideo.CVPixelBufferRelease
import platform.CoreVideo.CVPixelBufferUnlockBaseAddress
import platform.CoreVideo.kCVPixelBufferLock_ReadOnly
import platform.CoreVideo.kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
import platform.Foundation.NSData
import platform.Foundation.NSNotificationCenter
import platform.Foundation.NSNumber
import platform.Foundation.NSOperationQueue
import platform.Foundation.NSURL
import platform.QuartzCore.CACurrentMediaTime
import platform.darwin.DISPATCH_TIME_NOW
import platform.darwin.NSObjectProtocol
import platform.darwin.dispatch_after
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue
import platform.darwin.dispatch_queue_create
import platform.darwin.dispatch_time
import platform.posix.memcpy

/** Player callbacks, always on the main queue. */
interface IosVideoListener {
    fun onStateChanged(state: String, positionMs: Double)

    fun onError(message: String)

    /** A new frame is ready in [IosVideoPlayer.lastFrame]. */
    fun onFrame()
}

/**
 * The iOS twin of Android's FaceclawVideoPlayer: AVPlayer owns decode, A/V sync, seeking and
 * audio; a 30 ms tick on a private queue pulls the newest luma plane from an
 * AVPlayerItemVideoOutput and runs the shared [VideoFrameScaler]. Frames are not submitted
 * natively: [IosVideoListener.onFrame] asks the window to repaint, which reads [lastFrame].
 * Control calls are main-thread only.
 */
class IosVideoPlayer {
    private companion object {
        const val FRAME_INTERVAL_NS = 30_000_000L
        const val SEEK_END_MARGIN_MS = 500.0
        const val TIMESCALE = 600
    }

    /** One start(): what the tick queue reads, so a later start() never changes it under a tick. */
    private class Run(
        val id: Int,
        val output: AVPlayerItemVideoOutput,
        val item: AVPlayerItem,
        val rotation: Int,
        val width: Int,
        val height: Int,
        val lut: ByteArray,
    ) {
        val frame = ByteArray(width * height)
        var scaler: VideoFrameScaler? = null
        var failed = false
    }

    private var listener: IosVideoListener? = null
    private var player: AVPlayer? = null
    private var endObserver: NSObjectProtocol? = null
    private var ownsAudioSession = false
    private var durationMs = 0.0
    private var playing = false
    @Volatile private var generation = 0
    private val queue = dispatch_queue_create("com.faceclaw.video", null)
    /** Tick-queue scratch for the copied luma plane. */
    private var luma = ByteArray(0)
    private val lock = IosProtocolPlatform.createLock()
    // Guarded by lock.
    private var latest: ByteArray? = null
    private var latestWidth = 0

    fun setListener(listener: IosVideoListener?) {
        this.listener = listener
    }

    /** JSON {width, height (rotated), rotation, durationMs, hasAudio} or {error}, as Android's probe(). */
    fun probe(path: String): String = boundary("IosVideoPlayer.probe", """{"error":"Could not read the video"}""") {
        val asset = AVURLAsset(uRL = NSURL.fileURLWithPath(path), options = null)
        val track = asset.tracksWithMediaType(AVMediaTypeVideo).firstOrNull() as? AVAssetTrack
            ?: return@boundary """{"error":"No playable video track"}"""
        val rotation = trackRotation(track)
        val (w, h) = track.naturalSize().useContents { width.roundToInt() to height.roundToInt() }
        val swap = rotation == 90 || rotation == 270
        val hasAudio = asset.tracksWithMediaType(AVMediaTypeAudio).isNotEmpty()
        """{"width":${if (swap) h else w},"height":${if (swap) w else h},"rotation":$rotation,""" +
            """"durationMs":${assetDurationMs(asset).toLong()},"hasAudio":$hasAudio}"""
    }

    /** Play [path] scaled to width x height (display orientation) from [startMs]. */
    fun start(path: String, width: Int, height: Int, monochrome: Boolean, gamma: Float, audio: Boolean, startMs: Double): Unit = boundary("IosVideoPlayer.start", Unit) {
        stop()
        if (width <= 0 || height <= 0) return@boundary
        val asset = AVURLAsset(uRL = NSURL.fileURLWithPath(path), options = null)
        val track = asset.tracksWithMediaType(AVMediaTypeVideo).firstOrNull() as? AVAssetTrack
        val item = AVPlayerItem(asset = asset)
        // The key is kCVPixelBufferPixelFormatTypeKey; plane 0 of 420f is full-range luma. A real
        // NSNumber, not a boxed Kotlin UInt, since CoreVideo reads it as a CFNumber.
        val output = AVPlayerItemVideoOutput(pixelBufferAttributes = mapOf<Any?, Any>(
            "PixelFormatType" to NSNumber(unsignedInt = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)))
        item.addOutput(output)
        val avPlayer = AVPlayer(playerItem = item)
        avPlayer.muted = !audio
        if (audio) {
            val session = AVAudioSession.sharedInstance()
            // Voice capture owns a play-and-record session; play through it rather than interrupt it.
            if (session.category != AVAudioSessionCategoryPlayAndRecord) {
                ownsAudioSession = session.setCategory(AVAudioSessionCategoryPlayback, null) && session.setActive(true, null)
            }
        }
        val run = Run(++generation, output, item, track?.let { trackRotation(it) } ?: 0, width, height,
            VideoFrameScaler.toneLut(false, gamma, monochrome))
        durationMs = assetDurationMs(asset)
        lock.withLock { latest = null }
        player = avPlayer
        endObserver = NSNotificationCenter.defaultCenter.addObserverForName(
            AVPlayerItemDidPlayToEndTimeNotification, item, NSOperationQueue.mainQueue,
        ) { _ ->
            if (run.id == generation) {
                playing = false
                listener?.onStateChanged("ended", durationMs)
            }
        }
        playing = true
        if (startMs > 0) {
            avPlayer.seekToTime(time(startMs), kCMTimeZero.readValue(), kCMTimeZero.readValue()) { _ ->
                dispatch_async(dispatch_get_main_queue()) { if (run.id == generation && playing) avPlayer.play() }
            }
        } else {
            avPlayer.play()
        }
        scheduleTick(run)
    }

    fun pause(): Unit = boundary("IosVideoPlayer.pause", Unit) {
        playing = false
        player?.pause()
    }

    fun resume(): Unit = boundary("IosVideoPlayer.resume", Unit) {
        val avPlayer = player ?: return@boundary
        playing = true
        avPlayer.play()
    }

    /** Exact seek, kept clear of the end so a seek never lands on 'ended'. */
    fun seekTo(positionMs: Double): Unit = boundary("IosVideoPlayer.seekTo", Unit) {
        val limit = if (durationMs > SEEK_END_MARGIN_MS) durationMs - SEEK_END_MARGIN_MS else 0.0
        player?.seekToTime(time(positionMs.coerceIn(0.0, limit)), kCMTimeZero.readValue(), kCMTimeZero.readValue())
    }

    fun positionMs(): Double = boundary("IosVideoPlayer.positionMs", 0.0) {
        val ms = CMTimeGetSeconds(player?.currentTime() ?: return@boundary 0.0) * 1000
        if (ms.isFinite()) ms else 0.0
    }

    fun isPlaying(): Boolean = playing

    /** The latest frame if it was scaled to width x height, else null. */
    fun lastFrame(width: Int, height: Int): NSData? = boundary("IosVideoPlayer.lastFrame", null) {
        lock.withLock { latest?.takeIf { width == latestWidth && it.size == width * height }?.data() }
    }

    /** End playback and release AVFoundation; the last frame stays readable. */
    fun stop(): Unit = boundary("IosVideoPlayer.stop", Unit) {
        generation++
        playing = false
        endObserver?.let { NSNotificationCenter.defaultCenter.removeObserver(it) }
        endObserver = null
        player?.pause()
        player = null
        if (ownsAudioSession) {
            AVAudioSession.sharedInstance().setActive(false, AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation, null)
            ownsAudioSession = false
        }
    }

    private fun time(ms: Double) = CMTimeMakeWithSeconds(ms / 1000, TIMESCALE)

    private fun assetDurationMs(asset: AVURLAsset): Double =
        (CMTimeGetSeconds(asset.duration()) * 1000).takeIf { it.isFinite() } ?: 0.0

    private fun trackRotation(track: AVAssetTrack): Int =
        VideoFrameScaler.normalizeRotation(track.preferredTransform().useContents { atan2(b, a) * 180 / PI }.roundToInt())

    private fun scheduleTick(run: Run) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, FRAME_INTERVAL_NS), queue) {
            if (run.id != generation) return@dispatch_after
            try {
                tick(run)
            } catch (t: Throwable) {
                PlatformLog.w("IosVideoPlayer", "frame tick failed: ${t.message}")
            }
            scheduleTick(run)
        }
    }

    /** On the serial tick queue: copy the newest luma plane, scale it, publish it if it changed. */
    private fun tick(run: Run) {
        if (run.item.status == AVPlayerItemStatusFailed) {
            if (!run.failed) {
                run.failed = true
                val message = run.item.error?.localizedDescription ?: "Playback failed"
                dispatch_async(dispatch_get_main_queue()) { if (run.id == generation) listener?.onError(message) }
            }
            return
        }
        val itemTime = run.output.itemTimeForHostTime(CACurrentMediaTime())
        if (!run.output.hasNewPixelBufferForItemTime(itemTime)) return
        val buffer = run.output.copyPixelBufferForItemTime(itemTime, null) ?: return
        val width: Int
        val height: Int
        val stride: Int
        CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly)
        try {
            width = CVPixelBufferGetWidthOfPlane(buffer, 0u).toInt()
            height = CVPixelBufferGetHeightOfPlane(buffer, 0u).toInt()
            stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0u).toInt()
            val base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0u) ?: return
            if (width <= 0 || height <= 0) return
            if (luma.size != stride * height) luma = ByteArray(stride * height)
            luma.usePinned { memcpy(it.addressOf(0), base, luma.size.convert()) }
        } finally {
            CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly)
            CVPixelBufferRelease(buffer)
        }
        val scaler = run.scaler?.takeIf { it.sourceWidth == width && it.sourceHeight == height }
            ?: VideoFrameScaler(width, height, run.rotation, run.width, run.height).also { run.scaler = it }
        scaler.scale(luma, 0, stride, 1, run.lut, run.frame)
        val changed = lock.withLock {
            if (run.id != generation || latest?.contentEquals(run.frame) == true) false
            else { latest = run.frame.copyOf(); latestWidth = run.width; true }
        }
        if (changed) dispatch_async(dispatch_get_main_queue()) { if (run.id == generation) listener?.onFrame() }
    }
}
