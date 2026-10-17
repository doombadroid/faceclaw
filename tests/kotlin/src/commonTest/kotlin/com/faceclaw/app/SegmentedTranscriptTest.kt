package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SegmentedTranscriptTest {
    private class Recorder(private val text: (FloatArray) -> String) : OfflineTranscriber {
        val calls = mutableListOf<FloatArray>()
        override fun recognize(samples: FloatArray, count: Int): String { calls.add(samples.copyOf(count)); return text(samples) }
        override fun release() {}
    }

    private fun tone(seconds: Double, amplitude: Float) = FloatArray((seconds * 16000).toInt()) { if (it % 2 == 0) amplitude else -amplitude }

    @Test
    fun moonshinePartialsFollowTheCadenceAndFullSegmentsCommitAtTheQuietestPoint() {
        var now = 10_000L
        val events = mutableListOf<Pair<String, Boolean>>()
        val recognizer = Recorder { "w${it.size / 16000}" }
        val transcript = SegmentedTranscript(recognizer, VoiceModelKind.MOONSHINE, { now }, { text, final -> events.add(text to final) })
        transcript.accept(tone(0.1, 0.1f))
        assertEquals(0, recognizer.calls.size, "under the minimum, no decode")
        transcript.accept(tone(0.3, 0.1f))
        assertEquals(listOf("w0" to false), events)
        now += 100
        transcript.accept(tone(0.5, 0.1f))
        assertEquals(1, events.size, "the next partial waits for the 700 ms cadence")
        now += 700
        // 6.5 s of tone, a quiet gap, then more: the 8 s segment cuts inside the gap.
        transcript.accept(tone(6.1, 0.1f) + FloatArray(1600) + tone(2.0, 0.1f))
        assertTrue(recognizer.calls.all { it.size <= SegmentedTranscript.TRANSCRIPT_SEGMENT_MAX_SAMPLES })
        val committed = recognizer.calls.map { it.size }.first { it > 16000 * 6 }
        assertTrue(committed in 16000 * 7..16000 * 8, "cut at $committed")
        // Every decode window was normalized toward 0.9 peak.
        assertTrue(recognizer.calls.last().maxOf { kotlin.math.abs(it) } > 0.8f)
        transcript.finish()
        assertEquals(true, events.last().second)
        assertEquals(SegmentedTranscript.joinTranscript("w7", "w${recognizer.calls.last().size / 16000}"), events.last().first)
    }

    @Test
    fun whisperHasNoPartialsAndNeverHearsSilence() {
        val events = mutableListOf<Pair<String, Boolean>>()
        val recognizer = Recorder { "hello" }
        val transcript = SegmentedTranscript(recognizer, VoiceModelKind.WHISPER, { 0L }, { text, final -> events.add(text to final) })
        transcript.accept(tone(2.0, 0.001f))
        transcript.finish()
        assertEquals(0, recognizer.calls.size, "near-silence never reaches Whisper")
        assertEquals(listOf("" to true), events)
        val spoken = SegmentedTranscript(recognizer, VoiceModelKind.WHISPER, { 0L }, { text, final -> events.add(text to final) })
        spoken.accept(tone(2.0, 0.1f))
        assertEquals(1, events.size, "no Whisper partials")
        spoken.finish()
        assertEquals("hello" to true, events.last())
    }
}
