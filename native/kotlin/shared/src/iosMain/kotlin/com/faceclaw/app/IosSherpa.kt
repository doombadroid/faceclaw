@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package com.faceclaw.app

import kotlin.concurrent.Volatile

import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import platform.Foundation.NSData
import platform.Foundation.create
import platform.posix.memcpy

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

/** A speaker-embedding extractor; [samples] are 16 kHz float32, the result the raw float32 voice-print. */
interface IosVoicePrinter {
    /** Null when the input is too short to embed. */
    fun embed(samples: NSData): NSData?

    fun close()
}

/** Loads models (slow: call off the main queue); null when the files are missing or will not load. */
interface IosSherpaLoader {
    fun recognizer(modelDir: String, whisper: Boolean): IosPcmRecognizer?

    fun voicePrinter(modelPath: String): IosVoicePrinter?
}

internal fun FloatArray.floatData(count: Int = size): NSData =
    if (count <= 0) NSData()
    else usePinned { NSData.create(bytes = it.addressOf(0), length = (count * 4).toULong()) }

internal fun NSData.floatArray(): FloatArray {
    val out = FloatArray((length / 4u).toInt())
    if (out.isNotEmpty()) out.usePinned { memcpy(it.addressOf(0), bytes, (out.size * 4).toULong()) }
    return out
}

/** The shim's extractor as the shared [SpeakerEmbedder]: L2-normalized like Android's FaceclawSpeakerId. */
internal class SherpaEmbedder(private val printer: IosVoicePrinter) : SpeakerEmbedder {
    override fun embed(pcm16le: ByteArray, sampleRate: Int): FloatArray? {
        if (!VoicePrint.isLongEnoughToEmbed(pcm16le.size, sampleRate)) return null
        val raw = printer.embed(AudioSegmentation.pcm16leToFloat(pcm16le).floatData()) ?: return null
        return VoicePrint.l2Normalize(raw.floatArray())
    }

    override fun release() = printer.close()
}

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

/** The verdict of [IosSpeakerVerifier], on the main queue. */
interface IosSpeakerVerifiedListener {
    fun onVerified(isWearer: Boolean, similarity: Float)
}

/**
 * "My voice only" for an iOS push-to-talk capture, with VoiceCaptureSession's rules: the
 * capture's first 10 s are buffered, then embedded on a worker and compared with the
 * enrolled [wearer] voice-print (float32, L2-normalized). It fails open (counts as the
 * wearer) when the capture is under a second, the model will not load, or the sizes differ.
 */
class IosSpeakerVerifier(
    private val loader: IosSherpaLoader,
    private val modelPath: String,
    wearer: NSData,
    threshold: Float,
    private val listener: IosSpeakerVerifiedListener,
) {
    private val wearerPrint = wearer.floatArray()
    private val threshold = if (threshold > 0) threshold else VoiceCaptureSession.DEFAULT_VERIFY_THRESHOLD
    private val pcm = ByteSink(VoiceCaptureSession.VERIFY_MAX_SAMPLES * 2)
    private var verifying = false

    /** 16 kHz mono S16LE capture audio, on the main queue. */
    fun acceptPcm(chunk: NSData) {
        val room = VoiceCaptureSession.VERIFY_MAX_SAMPLES * 2 - pcm.size()
        if (verifying || room <= 0) return
        val bytes = chunk.byteArray()
        pcm.write(bytes, 0, minOf(room, bytes.size) and 1.inv())
    }

    /** Once: the verdict follows on the main queue. */
    fun verify() {
        if (verifying) return
        verifying = true
        val captured = pcm.toByteArray()
        if (captured.size < VoiceCaptureSession.VERIFY_MIN_SAMPLES * 2) {
            dispatchToMain { listener.onVerified(true, 0f) }
            return
        }
        startThread("FaceclawSpeakerVerify", true) {
            var printer: IosVoicePrinter? = null
            var similarity: Double? = null
            try {
                printer = loader.voicePrinter(modelPath)
                val embedding = printer?.let { SherpaEmbedder(it).embed(captured, SegmentedTranscript.SAMPLE_RATE) }
                if (embedding != null && embedding.size == wearerPrint.size) similarity = VoicePrint.dot(embedding, wearerPrint)
            } catch (t: Throwable) {
                PlatformLog.w("FaceclawSpeakerVerify", "speaker verification failed (${t.message})")
            } finally {
                printer?.close()
            }
            val score = similarity
            PlatformLog.i("FaceclawSpeakerVerify", "speaker verification similarity=${score?.let { formatFixed(it, 3) }} threshold=$threshold")
            dispatchToMain { listener.onVerified(score == null || score >= threshold, (score ?: 0.0).toFloat()) }
        }
    }
}
