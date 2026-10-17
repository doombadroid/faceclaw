package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import platform.Foundation.NSData
import platform.Foundation.NSDate
import platform.Foundation.NSDefaultRunLoopMode
import platform.Foundation.NSRunLoop
import platform.Foundation.dateWithTimeIntervalSinceNow
import platform.Foundation.runMode

class IosSherpaTest {
    private fun pumpMainUntil(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = IosProtocolPlatform.elapsedRealtimeMs() + timeoutMs
        while (IosProtocolPlatform.elapsedRealtimeMs() < deadline) {
            if (condition()) return true
            NSRunLoop.mainRunLoop.runMode(NSDefaultRunLoopMode, NSDate.dateWithTimeIntervalSinceNow(0.02))
        }
        return condition()
    }

    private class FakeRecognizer : IosPcmRecognizer {
        @Volatile var closed = false
        override fun recognize(samples: NSData): String = "n${samples.length.toLong() / 4}"
        override fun close() { closed = true }
    }

    /** Embeds every input as [print] (raw, un-normalized). */
    private class FakePrinter(private val print: FloatArray) : IosVoicePrinter {
        @Volatile var closed = false
        override fun embed(samples: NSData): NSData? = print.floatData()
        override fun close() { closed = true }
    }

    private class FakeLoader(private val recognizer: IosPcmRecognizer?, private val printer: IosVoicePrinter? = null) : IosSherpaLoader {
        val loads = mutableListOf<Pair<String, Boolean>>()
        val printerLoads = mutableListOf<String>()
        override fun recognizer(modelDir: String, whisper: Boolean): IosPcmRecognizer? { loads.add(modelDir to whisper); return recognizer }
        override fun voicePrinter(modelPath: String): IosVoicePrinter? { printerLoads.add(modelPath); return printer }
    }

    private class Verdicts : IosSpeakerVerifiedListener {
        val log = mutableListOf<Pair<Boolean, Float>>()
        override fun onVerified(isWearer: Boolean, similarity: Float) { log.add(isWearer to similarity) }
    }

    private class Events : IosTranscriptListener {
        val log = mutableListOf<String>()
        override fun onReady() { log.add("ready") }
        override fun onTranscript(text: String, isFinal: Boolean) { log.add(if (isFinal) "final:$text" else "partial:$text") }
        override fun onError(message: String) { log.add("error") }
    }

    private fun pcm(samples: Int, amplitude: Int = 3000): NSData =
        ByteArray(samples * 2) { if (it % 2 == 0) (amplitude and 0xff).toByte() else (amplitude shr 8).toByte() }.data()

    @Test
    fun whisperDictationCommitsSegmentsAndFinishesOnTheWorker() {
        val recognizer = FakeRecognizer()
        val loader = FakeLoader(recognizer)
        val events = Events()
        val transcriber = IosOnDeviceTranscriber(loader, "/models/w", true, events)
        transcriber.start()
        transcriber.acceptPcm(pcm(16000))
        transcriber.commitSegment()
        transcriber.acceptPcm(pcm(8000))
        transcriber.finish()
        assertTrue(pumpMainUntil(5000) { events.log.size >= 3 && recognizer.closed }, events.log.toString())
        assertEquals(listOf("/models/w" to true), loader.loads)
        // Whisper: no partials, one final per committed utterance.
        assertEquals(listOf("ready", "final:n16000", "final:n8000"), events.log)
    }

    @Test
    fun aMissingModelIsAnErrorAndCancelSilencesTheRest() {
        val events = Events()
        IosOnDeviceTranscriber(FakeLoader(null), "/none", false, events).start()
        assertTrue(pumpMainUntil(5000) { events.log.isNotEmpty() })
        assertEquals(listOf("error"), events.log)
        val recognizer = FakeRecognizer()
        val cancelled = Events()
        val transcriber = IosOnDeviceTranscriber(FakeLoader(recognizer), "/m", false, cancelled)
        transcriber.start()
        transcriber.acceptPcm(pcm(16000))
        transcriber.cancel()
        transcriber.finish()
        assertTrue(pumpMainUntil(5000) { recognizer.closed })
        pumpMainUntil(200) { false }
        assertTrue(cancelled.log.none { it.startsWith("final") }, cancelled.log.toString())
    }

    @Test
    fun voicePrintsAreNormalizedAndMyVoiceOnlyComparesThemFailingOpen() {
        val embedder = SherpaEmbedder(FakePrinter(floatArrayOf(3f, 4f)))
        assertEquals(null, embedder.embed(ByteArray(100), 16000), "under ~0.5 s is not embedded")
        val print = embedder.embed(ByteArray(32000), 16000)!!
        assertEquals(0.6f, print[0], 1e-6f)
        assertEquals(0.8f, print[1], 1e-6f)

        val wearer = floatArrayOf(0.6f, 0.8f).floatData()
        val match = Verdicts()
        val printer = FakePrinter(floatArrayOf(3f, 4f))
        val loader = FakeLoader(null, printer)
        val verifier = IosSpeakerVerifier(loader, "/m/speaker.onnx", wearer, 0.8f, match)
        verifier.acceptPcm(pcm(16000 * 12))
        verifier.verify()
        assertTrue(pumpMainUntil(5000) { match.log.isNotEmpty() && printer.closed })
        assertEquals(true, match.log.single().first)
        assertEquals(1f, match.log.single().second, 1e-5f)
        assertEquals(listOf("/m/speaker.onnx"), loader.printerLoads)

        val other = Verdicts()
        IosSpeakerVerifier(FakeLoader(null, FakePrinter(floatArrayOf(4f, -3f))), "/m", wearer, 0.8f, other).apply {
            acceptPcm(pcm(16000 * 2)); verify()
        }
        assertTrue(pumpMainUntil(5000) { other.log.isNotEmpty() })
        assertEquals(false, other.log.single().first)

        // Too short, or no model: counts as the wearer.
        val short = Verdicts()
        val unloaded = FakeLoader(null, null)
        IosSpeakerVerifier(unloaded, "/m", wearer, 0.8f, short).apply { acceptPcm(pcm(8000)); verify() }
        val missing = Verdicts()
        IosSpeakerVerifier(unloaded, "/m", wearer, 0.8f, missing).apply { acceptPcm(pcm(32000)); verify() }
        assertTrue(pumpMainUntil(5000) { short.log.isNotEmpty() && missing.log.isNotEmpty() })
        assertEquals(listOf(true to 0f), short.log)
        assertEquals(listOf(true to 0f), missing.log)
        assertEquals(listOf("/m"), unloaded.printerLoads, "a too-short capture never loads the model")
    }
}
