@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package com.faceclaw.app

import kotlin.concurrent.Volatile

import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import platform.Foundation.NSData
import platform.Foundation.create

/**
 * sherpa-onnx on iOS. The models run in the app target's ObjC FaceclawSherpa shim over
 * sherpa's C API (Kotlin/Native has no cinterop for it here); these protocols are what the
 * shim implements, and the classes below put it behind the shared voice ports.
 */

/** An offline recognizer; [samples] are 16 kHz mono float32. One thread at a time. */
interface IosPcmRecognizer {
    fun recognize(samples: NSData): String

    /** Frees the model now (not at the next GC). */
    fun close()
}

/** Loads models (slow: call off the main queue); null when the files are missing or will not load. */
interface IosSherpaLoader {
    fun recognizer(modelDir: String, whisper: Boolean): IosPcmRecognizer?
}

internal fun FloatArray.floatData(count: Int = size): NSData =
    if (count <= 0) NSData()
    else usePinned { NSData.create(bytes = it.addressOf(0), length = (count * 4).toULong()) }

/** The shim's recognizer as the shared [OfflineTranscriber]. */
internal class SherpaTranscriber(private val recognizer: IosPcmRecognizer) : OfflineTranscriber {
    override fun recognize(samples: FloatArray, count: Int): String =
        if (count <= 0) "" else recognizer.recognize(samples.floatData(count)).trim()

    override fun release() = recognizer.close()
}

/** Dictation results, on the main queue. */
interface IosTranscriptListener {
    /** The model is loaded; PCM sent before this is still decoded. */
    fun onReady()

    /** The whole utterance so far (REPLACE semantics), or its final. */
    fun onTranscript(text: String, isFinal: Boolean)

    fun onError(message: String)
}

/**
 * On-device dictation (the On-device Moonshine / Whisper providers): Android's segmented
 * transcript ([SegmentedTranscript]) over a recognizer the [loader] builds on this object's
 * worker thread. PCM is 16 kHz mono S16LE from the capture; decodes run on the worker.
 */
class IosOnDeviceTranscriber(
    private val loader: IosSherpaLoader,
    private val modelDir: String,
    private val whisper: Boolean,
    private val listener: IosTranscriptListener,
) {
    private companion object {
        const val TAG = "FaceclawOnDeviceStt"
        val COMMIT = Any()
        val FINISH = Any()
    }

    private val commands = BlockingQueue<Any>()
    private var started = false

    @Volatile
    private var cancelled = false

    fun start() {
        if (started) return
        started = true
        startThread(TAG, true) { run() }
    }

    fun acceptPcm(pcm: NSData) {
        if (!cancelled) commands.put(pcm.byteArray())
    }

    /** Ends the current utterance with its final and starts the next (continuous capture). */
    fun commitSegment() {
        if (!cancelled) commands.put(COMMIT)
    }

    /** Emits the final for everything accepted, then stops. */
    fun finish() {
        if (!cancelled) commands.put(FINISH)
    }

    /** Stops without a final. */
    fun cancel() {
        cancelled = true
        commands.put(FINISH)
    }

    private fun run() {
        var recognizer: IosPcmRecognizer? = null
        try {
            recognizer = loader.recognizer(modelDir, whisper)
            if (recognizer == null) {
                dispatchToMain { listener.onError("The voice model could not be loaded. Delete and download it again in Settings > Voice.") }
                return
            }
            if (cancelled) return
            dispatchToMain { listener.onReady() }
            val transcriber = SherpaTranscriber(recognizer)
            val kind = if (whisper) VoiceModelKind.WHISPER else VoiceModelKind.MOONSHINE
            val emit = { text: String, isFinal: Boolean -> if (!cancelled) dispatchToMain { listener.onTranscript(text, isFinal) } }
            val log = { message: String -> PlatformLog.i(TAG, message) }
            var transcript = SegmentedTranscript(transcriber, kind, ::monotonicMs, emit, log)
            while (true) {
                val command = commands.poll(250) ?: if (cancelled) break else continue
                if (cancelled) break
                when {
                    command === FINISH -> {
                        transcript.finish()
                        break
                    }
                    command === COMMIT -> {
                        transcript.finish()
                        transcript = SegmentedTranscript(transcriber, kind, ::monotonicMs, emit, log)
                    }
                    command is ByteArray -> transcript.accept(AudioSegmentation.pcm16leToFloat(command))
                }
            }
        } catch (t: Throwable) {
            PlatformLog.e(TAG, "on-device transcription failed", t)
            if (!cancelled) dispatchToMain { listener.onError("On-device transcription failed: ${t.message ?: t}") }
        } finally {
            recognizer?.close()
        }
    }
}

private fun monotonicMs(): Long = IosProtocolPlatform.elapsedRealtimeMs()
