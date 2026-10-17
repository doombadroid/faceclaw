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

    private class FakeLoader(private val recognizer: IosPcmRecognizer?) : IosSherpaLoader {
        val loads = mutableListOf<Pair<String, Boolean>>()
        override fun recognizer(modelDir: String, whisper: Boolean): IosPcmRecognizer? { loads.add(modelDir to whisper); return recognizer }
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
}
