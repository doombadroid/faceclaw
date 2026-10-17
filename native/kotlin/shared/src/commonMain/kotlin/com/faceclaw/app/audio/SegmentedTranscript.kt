package com.faceclaw.app

import kotlin.jvm.JvmStatic
import kotlin.math.min

/**
 * The on-device push-to-talk transcript, shared by Android's [VoiceCaptureSession] and iOS
 * dictation. Push-to-talk utterance boundaries come from the button. The current audio segment
 * is re-decoded in full for each live partial and the complete utterance text is emitted
 * (REPLACE, never a delta). The sherpa Moonshine v2 decoder fails once a single input grows past
 * roughly 9.1 seconds, so longer utterances are committed in model-safe segments. One worker
 * thread drives an instance; a fresh instance starts a fresh utterance.
 */
class SegmentedTranscript(
    private val recognizer: OfflineTranscriber,
    private val kind: VoiceModelKind,
    private val clock: () -> Long,
    private val emit: (text: String, isFinal: Boolean) -> Unit,
    private val log: (String) -> Unit = {},
) {
    companion object {
        const val SAMPLE_RATE = 16000
        const val TRANSCRIPT_DECODE_INTERVAL_MS = 700
        const val TRANSCRIPT_MIN_SAMPLES = SAMPLE_RATE / 3
        const val TRANSCRIPT_SEGMENT_MAX_SAMPLES = SAMPLE_RATE * 8
        // When a segment fills, cut at the quietest window within the last
        // TRANSCRIPT_CUT_SEARCH_SAMPLES rather than mid-word at the 8s mark; the
        // audio after the cut carries over into the next segment.
        const val TRANSCRIPT_CUT_SEARCH_SAMPLES = SAMPLE_RATE * 2
        const val TRANSCRIPT_CUT_WINDOW_SAMPLES = SAMPLE_RATE * 30 / 1000
        // Glasses-mic PCM peaks around 0.1 full scale, and at that level the
        // quantized Moonshine model often returns empty or garbled text. Boost
        // each decode window toward this peak, with a gain cap so near-silent
        // buffers aren't amplified into pure noise.
        const val TRANSCRIPT_NORMALIZE_TARGET_PEAK = 0.9f
        const val TRANSCRIPT_NORMALIZE_MAX_GAIN = 30f
        const val TRANSCRIPT_LOG_PREVIEW_CHARS = 80
        // Below this peak amplitude (pre-normalization, of a full-scale +/-1.0f
        // buffer) a segment is treated as silence and never reaches the Whisper
        // recognizer at all, rather than risking a hallucinated non-answer. Picked
        // conservatively low (well under typical mic noise floor already seen in
        // this pipeline's normalization target) -- UNTESTED on real hardware, tune
        // against real glasses captures rather than trusting this number.
        const val WHISPER_SILENCE_PEAK_THRESHOLD = 0.01f

        /** Joins transcript pieces, attaching leading punctuation to the previous text. */
        @JvmStatic
        fun joinTranscript(prefix: String?, suffix: String?): String {
            if (prefix.isNullOrEmpty()) {
                return suffix ?: ""
            }
            if (suffix.isNullOrEmpty()) {
                return prefix
            }
            val first = suffix[0]
            val attachesToPrevious = ".,!?;:%)]}".indexOf(first) >= 0
            return prefix + (if (attachesToPrevious) "" else " ") + suffix
        }
    }

    private val transcriptSamples = FloatArray(TRANSCRIPT_SEGMENT_MAX_SAMPLES)
    private var transcriptSampleCount = 0
    private var committedTranscriptSampleCount: Long = 0
    private var committedTranscript = ""
    private var currentSegmentTranscript = ""
    private var lastTranscriptDecodeAtMs: Long = 0
    private var lastTranscript = ""

    /** Appends 16 kHz samples; a full segment commits, and Moonshine emits a live partial on its cadence. */
    fun accept(samples: FloatArray) {
        appendTranscriptSamples(samples)
        // Each Whisper call re-encodes the whole buffer plus ~10s of tail padding,
        // so it skips the live-partial redecode Moonshine does on this interval and
        // only decodes when a segment commits (8s buffer fill) or the utterance ends
        // (finish()). No live preview text in Whisper mode -- status stays
        // "Listening..." until release. Deliberate tradeoff.
        if (kind == VoiceModelKind.WHISPER) {
            return
        }
        val now = clock()
        if (transcriptSampleCount >= TRANSCRIPT_MIN_SAMPLES &&
            now - lastTranscriptDecodeAtMs >= TRANSCRIPT_DECODE_INTERVAL_MS
        ) {
            decodeTranscript(false)
            lastTranscriptDecodeAtMs = now
        }
    }

    /** Button released / stop requested: emit one final full-utterance transcript. */
    fun finish() = decodeTranscript(true)

    private fun appendTranscriptSamples(samples: FloatArray) {
        var sourceOffset = 0
        while (sourceOffset < samples.size) {
            val available = TRANSCRIPT_SEGMENT_MAX_SAMPLES - transcriptSampleCount
            val count = min(available, samples.size - sourceOffset)
            samples.copyInto(transcriptSamples, transcriptSampleCount, sourceOffset, sourceOffset + count)
            transcriptSampleCount += count
            sourceOffset += count
            if (transcriptSampleCount == TRANSCRIPT_SEGMENT_MAX_SAMPLES) {
                commitTranscriptSegment()
            }
        }
    }

    /**
     * Decode the current model-safe segment and emit the best transcript of the
     * complete utterance (REPLACE semantics — the caller displays it as-is).
     */
    private fun decodeTranscript(isFinal: Boolean) {
        if (transcriptSampleCount <= 0) {
            if (isFinal) {
                emit(lastTranscript, true)
            }
            return
        }
        val segmentSampleCount = transcriptSampleCount
        var segmentText = recognizeTranscriptSegment(segmentSampleCount)
        if (segmentText.isNotEmpty()) {
            currentSegmentTranscript = segmentText
        } else {
            segmentText = currentSegmentTranscript
        }
        val text = joinTranscript(committedTranscript, segmentText)
        lastTranscript = text
        logTranscriptDecode(isFinal, segmentSampleCount, text)
        emit(text, isFinal)
    }

    /**
     * Finalize a full segment before accepting more audio. This keeps every
     * Moonshine invocation below its failing sequence length while retaining
     * all earlier text in the replace-semantics preview.
     */
    private fun commitTranscriptSegment() {
        val cut = AudioSegmentation.quietestCutPoint(
            transcriptSamples, transcriptSampleCount, TRANSCRIPT_CUT_SEARCH_SAMPLES, TRANSCRIPT_CUT_WINDOW_SAMPLES,
        )
        var segmentText = recognizeTranscriptSegment(cut)
        if (segmentText.isEmpty()) {
            // Fallback text came from partial decodes of the full buffer, so it
            // may include words from the carried-over tail; rare now that decode
            // windows are peak-normalized.
            segmentText = currentSegmentTranscript
        }
        committedTranscript = joinTranscript(committedTranscript, segmentText)
        currentSegmentTranscript = ""
        committedTranscriptSampleCount += cut.toLong()
        val tail = transcriptSampleCount - cut
        transcriptSamples.copyInto(transcriptSamples, 0, cut, cut + tail)
        transcriptSampleCount = tail
        lastTranscript = committedTranscript
        lastTranscriptDecodeAtMs = clock()
        logTranscriptDecode(false, cut, committedTranscript)
        emit(committedTranscript, false)
    }

    private fun recognizeTranscriptSegment(sampleCount: Int): String {
        if (sampleCount <= 0) {
            return ""
        }
        val segment = transcriptSamples.copyOf(sampleCount)
        // Whisper hallucinates text on near-silent input; gate it on the
        // PRE-normalization peak, since normalizePeak() below would otherwise
        // amplify true silence right up to the target level. Moonshine does not
        // share this failure mode in practice, so it is left unchanged.
        if (kind == VoiceModelKind.WHISPER &&
            AudioSegmentation.peakAmplitude(segment) < WHISPER_SILENCE_PEAK_THRESHOLD
        ) {
            return ""
        }
        AudioSegmentation.normalizePeak(segment, TRANSCRIPT_NORMALIZE_TARGET_PEAK, TRANSCRIPT_NORMALIZE_MAX_GAIN)
        return recognizer.recognize(segment, segment.size).trim()
    }

    private fun logTranscriptDecode(isFinal: Boolean, segmentSampleCount: Int, text: String) {
        val totalAudioSec = (committedTranscriptSampleCount + transcriptSampleCount) / SAMPLE_RATE.toDouble()
        val preview = if (text.length <= TRANSCRIPT_LOG_PREVIEW_CHARS) text
        else text.substring(0, TRANSCRIPT_LOG_PREVIEW_CHARS) + "..."
        log(
            (if (kind == VoiceModelKind.WHISPER) "Whisper" else "Moonshine") + " decode final=" + isFinal +
                " audioSec=" + formatFixed(totalAudioSec, 2) +
                " segmentAudioSec=" + formatFixed(segmentSampleCount / SAMPLE_RATE.toDouble(), 2) +
                " textLen=" + text.length + " text=\"" + preview + "\"",
        )
    }
}
