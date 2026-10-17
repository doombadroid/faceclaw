@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package com.faceclaw.app

import kotlinx.cinterop.addressOf
import kotlinx.cinterop.get
import kotlinx.cinterop.usePinned
import platform.AVFAudio.AVAudioPCMBuffer
import platform.AVFAudio.AVAudioFormat
import platform.AVFAudio.AVAudioPCMFormatFloat32
import platform.Foundation.NSData
import platform.Foundation.NSFileHandle
import platform.Foundation.NSFileManager
import platform.Foundation.NSOperationQueue
import platform.Foundation.fileHandleForUpdatingAtPath
import platform.Speech.SFSpeechAudioBufferRecognitionRequest
import platform.Speech.SFSpeechRecognizer
import platform.Speech.SFSpeechRecognizerAuthorizationStatus
import platform.darwin.DISPATCH_TIME_NOW
import platform.darwin.NSEC_PER_SEC
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue
import platform.darwin.dispatch_semaphore_create
import platform.darwin.dispatch_semaphore_signal
import platform.darwin.dispatch_semaphore_wait
import platform.darwin.dispatch_time
import platform.posix.memcpy

/** The shared conversation store over the ObjC FaceclawSqlite port, plus the file sweep Android does with java.io. */
class IosConversationStore(port: SqlPort) : ConversationStoreCore(port) {
    /** Delete recordings in dirPath no session names (matched by file name). Returns how many went. */
    fun deleteUnreferencedRecordings(dirPath: String?): Int {
        if (dirPath == null) return 0
        return try {
            val referenced = referencedRecordingNames()
            val names = NSFileManager.defaultManager.contentsOfDirectoryAtPath(dirPath, null) ?: return 0
            names.map { it as String }.count { it !in referenced && NSFileManager.defaultManager.removeItemAtPath("$dirPath/$it", null) }
        } catch (t: Throwable) {
            PlatformLog.e("FaceclawConvStore", "recording sweep failed", t)
            0
        }
    }
}

/** NSData face of the shared spectral suppressor (a Kotlin ByteArray crosses per byte). */
class IosNoiseSuppressor(sampleRate: Int) {
    private val suppressor = FaceclawNoiseSuppressor(sampleRate)

    fun process(pcm: NSData): NSData = suppressor.process(pcm.byteArray())?.data() ?: pcm

    fun reset() = suppressor.reset()
}

/** Android FaceclawWavRecorder over NSFileHandle: a header first, rewritten on finish. */
class IosWavRecorder(private val path: String, private val sampleRate: Int, private val channels: Int) {
    companion object {
        /** Rewrite an unfinished recording's header to the PCM on disk; the PCM bytes, or -1 when missing. */
        fun repairHeader(path: String, sampleRate: Int, channels: Int): Long {
            if (!fileExists(path)) return -1
            val header = BinaryEncoding.wavHeader(0, sampleRate, channels).size.toLong()
            val frame = channels * 2L
            val pcm = maxOf(0L, fileLength(path) - header) / frame * frame
            val handle = NSFileHandle.fileHandleForUpdatingAtPath(path) ?: return -1
            // The error-returning NSFileHandle calls: the legacy ones raise, which would end the process.
            val ok = handle.truncateAtOffset((header + pcm).toULong(), null) && handle.seekToOffset(0u, null) &&
                handle.writeData(BinaryEncoding.wavHeader(minOf(pcm, Int.MAX_VALUE.toLong()).toInt(), sampleRate, channels).data(), null)
            handle.closeAndReturnError(null)
            return if (ok) pcm else -1
        }
    }

    private var handle: NSFileHandle? = null
    private var dataBytes = 0L

    init {
        val directory = path.substringBeforeLast('/')
        NSFileManager.defaultManager.createDirectoryAtPath(directory, true, null, null)
        if (NSFileManager.defaultManager.createFileAtPath(path, BinaryEncoding.wavHeader(0, sampleRate, channels).data(), null))
            handle = NSFileHandle.fileHandleForUpdatingAtPath(path)?.takeIf { it.seekToEndReturningOffset(null, null) }
    }

    /** False when the file could not be created; append and finish are then no-ops. */
    fun isOpen(): Boolean = handle != null

    fun append(pcm: NSData) {
        val current = handle ?: return
        if (current.writeData(pcm, null)) dataBytes += pcm.length.toLong()
    }

    fun getDurationMs(): Long = dataBytes * 1000L / (sampleRate * channels * 2L)

    fun finish(): Long {
        val current = handle ?: return dataBytes
        handle = null
        if (current.seekToOffset(0u, null))
            current.writeData(BinaryEncoding.wavHeader(minOf(dataBytes, Int.MAX_VALUE.toLong()).toInt(), sampleRate, channels).data(), null)
        current.closeAndReturnError(null)
        return dataBytes
    }

    fun discard() {
        finish()
        deleteFile(path)
    }
}

/**
 * Apple's recognizer as a whole-utterance [OfflineTranscriber]: one buffer request per
 * segment, awaited on the caption worker (never the main queue: results arrive on the
 * recognizer's own operation queue). On-device when the locale supports it.
 */
private class AppleSpeechTranscriber(private val recognizer: SFSpeechRecognizer) : OfflineTranscriber {
    private val format = AVAudioFormat(commonFormat = AVAudioPCMFormatFloat32, sampleRate = 16000.0, channels = 1u, interleaved = false)

    override fun recognize(samples: FloatArray, count: Int): String {
        if (count <= 0) return ""
        val buffer = AVAudioPCMBuffer(pCMFormat = format, frameCapacity = count.toUInt())
        buffer.frameLength = count.toUInt()
        val channel = buffer.floatChannelData?.get(0) ?: return ""
        samples.usePinned { memcpy(channel, it.addressOf(0), (count * 4).toULong()) }
        val request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = false
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        request.appendAudioPCMBuffer(buffer)
        request.endAudio()
        val done = dispatch_semaphore_create(0)
        var text = ""
        val task = recognizer.recognitionTaskWithRequest(request) { result, error ->
            if (result != null && result.isFinal()) {
                text = result.bestTranscription.formattedString
                dispatch_semaphore_signal(done)
            } else if (error != null) {
                dispatch_semaphore_signal(done)
            }
        }
        // ponytail: fixed 5 s cap per segment; a slow first on-device model load drops that line.
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC.toLong())) != 0L) task.cancel()
        return text.trim()
    }

    override fun release() {}
}

/**
 * Android FaceclawCaptionEngine on iOS: the shared [CaptionSession] (segmentation, worker,
 * lifecycle) with the downloaded Moonshine model through [sherpa], or Apple's recognizer per
 * utterance when the ASR dir is [APPLE_SPEECH], and voice-prints from the speaker model
 * through [sherpa]. Callbacks arrive on the main queue.
 */
class IosCaptionEngine(private val sherpa: IosSherpaLoader?) {
    companion object {
        /** The ASR dir that selects Apple's recognizer (Apple ships its models). */
        const val APPLE_SPEECH = "apple-speech"
    }

    private val host = object : CaptionHost {
        override val dispatcher = CallbackDispatcher { action -> dispatch_async(dispatch_get_main_queue()) { action() } }

        override fun loadTranscriber(modelDir: String): OfflineTranscriber? {
            if (modelDir != APPLE_SPEECH) return sherpa?.recognizer(modelDir, false)?.let { SherpaTranscriber(it) }
            if (SFSpeechRecognizer.authorizationStatus() != SFSpeechRecognizerAuthorizationStatus.SFSpeechRecognizerAuthorizationStatusAuthorized) return null
            val recognizer = SFSpeechRecognizer()
            if (!recognizer.isAvailable()) return null
            recognizer.queue = NSOperationQueue()
            return AppleSpeechTranscriber(recognizer)
        }

        override fun loadEmbedder(modelPath: String): SpeakerEmbedder? = sherpa?.voicePrinter(modelPath)?.let { SherpaEmbedder(it) }
    }

    private val session = CaptionSession(host)

    fun setListener(listener: FaceclawCaptionEngineListener?) = session.setListener(listener)

    fun setAsrModelDir(dir: String?) = session.setAsrModelDir(dir)

    fun setSpeakerModelPath(path: String?) = session.setSpeakerModelPath(path)

    fun start() = session.start()

    fun stop() = session.stop()

    fun requestStop() = session.requestStop()

    fun acceptPcm(pcm: NSData) = session.acceptPcm(pcm.byteArray())
}
