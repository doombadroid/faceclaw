package com.faceclaw.app

import java.io.File
import kotlin.io.encoding.Base64
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The shared conversation store against real SQLite: the sqlite3 CLI stands in for the iOS
 * FaceclawSqlite shim (text-bound args, text results, one connection).
 */
class ConversationStoreCoreTest {
    private class CliSqlPort(path: String) : SqlPort {
        val process: Process = ProcessBuilder("sqlite3", "-json", path).redirectErrorStream(true).start()
        private val input = process.outputStream.bufferedWriter()
        private val output = process.inputStream.bufferedReader()

        override fun query(sql: String, args: List<String?>): List<List<String?>>? {
            val iterator = args.iterator()
            val bound = Regex("\\?").replace(sql) { iterator.next()?.let { "'" + it.replace("'", "''") + "'" } ?: "NULL" }
            input.write("$bound;\nSELECT '__END__';\n")
            input.flush()
            val text = StringBuilder()
            while (true) {
                val line = output.readLine() ?: return null
                if (line.contains("\"__END__\"")) break
                text.append(line).append('\n')
            }
            if (text.startsWith("Error") || text.startsWith("Parse error")) return null
            if (text.isBlank()) return emptyList()
            val parsed = runCatching { Json.parseArray(text.toString()) }.getOrNull() ?: return null
            return parsed.map { row -> (row as Map<*, *>).values.map { (it as? JsonNumber)?.text ?: it?.toString() } }
        }
    }

    private val db = File.createTempFile("conversations", ".db").also { it.delete() }
    private val port = CliSqlPort(db.path)

    @AfterTest
    fun cleanUp() {
        port.process.destroy()
        db.delete()
    }

    @Suppress("UNCHECKED_CAST")
    private fun list(json: String) = Json.parseArray(json) as List<Map<String, Any?>>

    private fun embedding(vararg values: Float) = Base64.encode(SpeakerEmbeddings.floatsToBlob(values))

    @Test
    fun sessionsAndSegmentsRoundTripAsAndroidsJson() {
        val store = ConversationStoreCore(port)
        val session = store.startSession(1_000L, "Coffee")
        val speaker = store.createSpeaker("Ana", "", false, embedding(0.6f, 0.8f))
        assertTrue(session > 0 && speaker > 0)
        val segment = store.insertSegment("""{"sessionId":$session,"speakerId":$speaker,"startedAt":1100,"endedAt":1900,
            "audioOffsetMs":100,"text":"it's fine","sentiment":0.25,"emotion":"calm","searchMeta":"calm positive","angle":-30,
            "embeddingBase64":"${embedding(1f, 0f)}"}""")
        assertTrue(segment > 0)
        assertEquals(-1L, store.insertSegment("""{"sessionId":$session}"""), "a segment without text is refused")
        store.updateSegment(segment, """{"lang":"en","translation":"","translationLang":"de"}""")
        store.endSession(session, 2_000L, "/rec/a.wav", "wav", 0.25)

        val sessions = list(store.querySessions("""{"query":"positive"}"""))
        assertEquals(1, sessions.size)
        val row = sessions[0]
        assertEquals(listOf(session, 1000L, 2000L, "Coffee", "/rec/a.wav", "wav", 0.25, 1L),
            listOf("id", "startedAt", "endedAt", "title", "audioPath", "audioCodec", "avgSentiment", "segmentCount")
                .map { (row[it] as? JsonNumber)?.let { n -> if (it == "avgSentiment") n.toDouble() else n.toLong() } ?: row[it] })
        assertEquals("Ana", ((row["speakers"] as List<*>)[0] as Map<*, *>)["name"])
        assertEquals(0, list(store.querySessions("""{"sinceMs":1001}""")).size)

        val segments = list(store.querySegments(session))
        assertEquals("it's fine", segments[0]["text"])
        assertEquals("en", segments[0]["lang"])
        assertEquals("de", segments[0]["translationLang"])
        assertEquals(-30L, (segments[0]["angle"] as JsonNumber).toLong())
        assertEquals(1, list(store.searchSegments("""{"query":"fine","speakerId":$speaker}""")).size)
        assertEquals(embedding(1f, 0f), list(store.querySegmentEmbeddings(session))[0]["embeddingBase64"])
        assertEquals("/rec/a.wav", store.getSessionAudioPath(session))
    }

    @Test
    fun speakersMergeKeepTheTargetsInsightsAndBlendVoicePrints() {
        val store = ConversationStoreCore(port)
        val session = store.startSession(1L, null)
        val from = store.createSpeaker("Speaker 2", "#FFB74D", true, embedding(1f, 0f))
        val into = store.createSpeaker("Bo", "#81C784", false, embedding(0f, 1f))
        store.insertSegment("""{"sessionId":$session,"speakerId":$from,"startedAt":1,"endedAt":2,"text":"hi"}""")
        store.setSpeakerInsights(from, "recap", "[\"call\"]", "[]", session)
        store.mergeSpeakers(from, into)

        val speakers = list(store.querySpeakers())
        assertEquals(1, speakers.size)
        val bo = speakers[0]
        assertEquals("Bo", bo["name"])
        assertEquals(true, bo["isWearer"])
        assertEquals("recap", bo["lastRecap"], "a target without insights adopts the source's")
        assertEquals(2L, (bo["embeddingCount"] as JsonNumber).toLong())
        assertEquals(1L, (bo["segmentCount"] as JsonNumber).toLong())
        val blended = SpeakerEmbeddings.blobToFloats(Base64.decode(bo["embeddingBase64"] as String))!!
        assertEquals(0.7071f, blended[0], 0.001f)

        store.updateSpeakerEmbedding(into, embedding(1f, 0f), 24)
        assertEquals(3L, (list(store.querySpeakers())[0]["embeddingCount"] as JsonNumber).toLong())
        store.setSpeakerWearer(into, false)
        store.renameSpeaker(into, "Bob")
        assertEquals("Bob", list(store.querySpeakers())[0]["name"])
        assertEquals(false, list(store.querySpeakers())[0]["isWearer"])
        store.deleteSpeaker(into)
        assertEquals(null, list(store.querySegments(session))[0]["speakerId"])
    }

    @Test
    fun recoveryAndRetentionCloseAndExpireSessions() {
        val audio = File.createTempFile("old", ".wav")
        val store = ConversationStoreCore(port)
        val old = store.startSession(100L, "old")
        val live = store.startSession(5_000L, "live")
        store.setSessionAudio(old, audio.path, "wav")
        store.insertSegment("""{"sessionId":$old,"startedAt":150,"endedAt":400,"text":"x","sentiment":0.5}""")

        val closed = list(store.closeInterruptedSessions("[$live]"))
        assertEquals(listOf(old), closed.map { (it["id"] as JsonNumber).toLong() })
        assertEquals(audio.path, closed[0]["audioPath"])
        val row = list(store.querySessions("{}")).first { (it["id"] as JsonNumber).toLong() == old }
        assertEquals(400L, (row["endedAt"] as JsonNumber).toLong())
        assertEquals(0.5, (row["avgSentiment"] as JsonNumber).toDouble())

        val summary = Json.parseObject(store.applyRetention(1_000L, 0L))
        assertEquals(1L, (summary["sessionsDeleted"] as JsonNumber).toLong())
        assertEquals(1L, (summary["recordingsDeleted"] as JsonNumber).toLong())
        assertTrue(!audio.exists())
        assertEquals(listOf("live"), list(store.querySessions("{}")).map { it["title"] })

        // A second open of the same file sees the migrated schema, not a fresh one.
        assertEquals(1, list(ConversationStoreCore(port).querySessions("{}")).size)
    }
}
