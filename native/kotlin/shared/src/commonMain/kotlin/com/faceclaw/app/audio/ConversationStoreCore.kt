package com.faceclaw.app

import kotlin.io.encoding.Base64

/**
 * One SQLite connection, as narrow as a platform shim can implement (iOS: the ObjC
 * FaceclawSqlite over libsqlite3; K/N has no sqlite3 platform library). Every argument is
 * bound as text and column affinity stores it typed; every result column comes back as text,
 * null for SQL NULL. Returns null when the statement failed.
 */
interface SqlPort {
    fun query(sql: String, args: List<String?>): List<List<String?>>?
}

/**
 * The Microphones conversation store (sessions, transcript segments, speaker voice-prints)
 * over a [SqlPort]: the SQL and JSON of Android's FaceclawConversationStore, same schema,
 * same JSON shapes. Blobs cross as hex literals and hex(), so the port stays text-only.
 * Every public method catches its own failures: an exception escaping to NativeScript on
 * iOS would end the process.
 */
open class ConversationStoreCore(private val sql: SqlPort) {
    companion object {
        private const val TAG = "FaceclawConvStore"
        private const val DB_VERSION = 2
        private const val DEFAULT_COLOR = "#4FC3F7"
    }

    init {
        guard(Unit) { migrate() }
    }

    private fun rows(statement: String, vararg args: Any?): List<List<String?>> =
        sql.query(statement, args.map { it?.toString() }) ?: error("SQL failed: $statement")

    private fun exec(statement: String, vararg args: Any?) {
        rows(statement, *args)
    }

    private fun long(statement: String, vararg args: Any?): Long? = rows(statement, *args).firstOrNull()?.firstOrNull()?.toLong()

    private fun insert(statement: String, vararg args: Any?): Long =
        if (sql.query(statement, args.map { it?.toString() }) == null) -1 else long("SELECT last_insert_rowid()") ?: -1

    private fun <T> guard(fallback: T, block: () -> T): T =
        try {
            block()
        } catch (t: Throwable) {
            PlatformLog.e(TAG, "conversation store failed", t)
            fallback
        }

    private fun <T> transaction(block: () -> T): T {
        exec("BEGIN")
        try {
            return block().also { exec("COMMIT") }
        } catch (t: Throwable) {
            sql.query("ROLLBACK", emptyList())
            throw t
        }
    }

    private fun migrate() {
        val version = long("PRAGMA user_version") ?: 0
        if (version == 0L) {
            transaction {
                exec("CREATE TABLE speakers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL," +
                    " color TEXT NOT NULL DEFAULT '#4FC3F7', is_wearer INTEGER NOT NULL DEFAULT 0, embedding BLOB," +
                    " embedding_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_heard_at INTEGER," +
                    " tag TEXT, last_recap TEXT, action_items TEXT, facts TEXT, insights_updated_at INTEGER," +
                    " insights_session_id INTEGER)")
                exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL," +
                    " ended_at INTEGER, title TEXT, audio_path TEXT, audio_codec TEXT, avg_sentiment REAL," +
                    " segment_count INTEGER NOT NULL DEFAULT 0)")
                exec("CREATE TABLE segments (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL," +
                    " speaker_id INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, audio_offset_ms INTEGER," +
                    " text TEXT NOT NULL, lang TEXT, translation TEXT, translation_lang TEXT, sentiment REAL, emotion TEXT," +
                    " search_meta TEXT, angle INTEGER, embedding BLOB)")
                exec("CREATE INDEX idx_segments_session ON segments(session_id)")
                exec("CREATE INDEX idx_segments_speaker ON segments(speaker_id)")
                exec("CREATE INDEX idx_segments_time ON segments(started_at)")
                exec("CREATE INDEX idx_sessions_time ON sessions(started_at)")
                exec("PRAGMA user_version = $DB_VERSION")
            }
        } else if (version < 2) {
            transaction {
                for (column in listOf("last_recap TEXT", "action_items TEXT", "facts TEXT", "insights_updated_at INTEGER", "insights_session_id INTEGER"))
                    exec("ALTER TABLE speakers ADD COLUMN $column")
                exec("PRAGMA user_version = $DB_VERSION")
            }
        }
    }

    // ---- sessions ----

    fun startSession(startedAtMs: Long, title: String?): Long = guard(-1L) {
        insert("INSERT INTO sessions (started_at, title) VALUES (?, ?)", startedAtMs, title?.ifEmpty { null })
    }

    fun endSession(sessionId: Long, endedAtMs: Long, audioPath: String?, audioCodec: String?, avgSentiment: Double) = guard(Unit) {
        if (audioPath.isNullOrEmpty()) exec("UPDATE sessions SET ended_at=?, avg_sentiment=? WHERE id=?", endedAtMs, avgSentiment, sessionId)
        else exec("UPDATE sessions SET ended_at=?, audio_path=?, audio_codec=?, avg_sentiment=? WHERE id=?",
            endedAtMs, audioPath, audioCodec, avgSentiment, sessionId)
    }

    fun setSessionAudio(sessionId: Long, audioPath: String?, audioCodec: String?) = guard(Unit) {
        exec("UPDATE sessions SET audio_path=?, audio_codec=? WHERE id=?", audioPath, audioCodec, sessionId)
    }

    fun getSessionAudioPath(sessionId: Long): String = guard("") {
        rows("SELECT audio_path FROM sessions WHERE id=?", sessionId).firstOrNull()?.firstOrNull() ?: ""
    }

    /** Sessions, newest first. filterJson: sinceMs, untilMs, speakerId, emotion, query, limit. */
    fun querySessions(filterJson: String?): String = guard("[]") {
        val filter = parseFilter(filterJson)
        val where = ArrayList<String>()
        val args = ArrayList<Any?>()
        filter.long("sinceMs")?.let { where.add("s.started_at >= ?"); args.add(it) }
        filter.long("untilMs")?.let { where.add("s.started_at <= ?"); args.add(it) }
        filter.long("speakerId")?.let { where.add("g.speaker_id = ?"); args.add(it) }
        filter.string("emotion")?.let { where.add("g.emotion = ?"); args.add(it) }
        filter.string("query")?.let {
            where.add("(s.title LIKE ? OR g.text LIKE ? OR g.search_meta LIKE ?)")
            repeat(3) { _ -> args.add("%$it%") }
        }
        val join = if (filter.containsKey("speakerId") || filter.containsKey("emotion") || filter.containsKey("query"))
            " LEFT JOIN segments g ON g.session_id = s.id" else ""
        val statement = "SELECT DISTINCT s.id, s.started_at, s.ended_at, s.title, s.audio_path, s.audio_codec," +
            " s.avg_sentiment, s.segment_count FROM sessions s$join" + whereClause(where) +
            " ORDER BY s.started_at DESC LIMIT " + limit(filter, 200)
        Json.write(rows(statement, *args.toTypedArray()).map { c ->
            val id = c[0]!!.toLong()
            linkedMapOf(
                "id" to id, "startedAt" to c[1]!!.toLong(), "endedAt" to c[2]?.toLong(), "title" to (c[3] ?: ""),
                "audioPath" to (c[4] ?: ""), "audioCodec" to (c[5] ?: ""), "avgSentiment" to (c[6]?.toDouble() ?: 0.0),
                "segmentCount" to c[7]!!.toLong(),
                "speakers" to rows("SELECT DISTINCT p.id, p.name, p.color FROM segments g JOIN speakers p ON p.id = g.speaker_id WHERE g.session_id=?", id)
                    .map { linkedMapOf("id" to it[0]!!.toLong(), "name" to it[1], "color" to it[2]) },
            )
        })
    }

    // ---- segments ----

    /** Insert one transcript segment (Android's JSON keys). Returns the new row id, or -1. */
    fun insertSegment(json: String?): Long = guard(-1L) {
        val s = Json.parseObject(json ?: "")
        val sessionId = s.long("sessionId") ?: error("sessionId missing")
        val columns = linkedMapOf<String, Any?>(
            "session_id" to sessionId, "speaker_id" to s.long("speakerId"), "started_at" to s.long("startedAt"),
            "ended_at" to s.long("endedAt"), "audio_offset_ms" to s.long("audioOffsetMs"), "text" to s.string("text"),
            "lang" to s.string("lang"), "translation" to s.string("translation"), "translation_lang" to s.string("translationLang"),
            "sentiment" to s.double("sentiment"), "emotion" to s.string("emotion"), "search_meta" to s.string("searchMeta"),
            "angle" to s.long("angle"),
        )
        val blob = s.string("embeddingBase64")?.let { blobLiteral(Base64.decode(it)) }
        val names = columns.keys.joinToString(", ") + if (blob != null) ", embedding" else ""
        val values = columns.keys.joinToString(", ") { "?" } + if (blob != null) ", $blob" else ""
        transaction {
            insert("INSERT INTO segments ($names) VALUES ($values)", *columns.values.toTypedArray()).also {
                check(it >= 0) { "segment insert failed" }
                exec("UPDATE sessions SET segment_count = segment_count + 1 WHERE id=?", sessionId)
            }
        }
    }

    /** Update mutable fields of a segment (same keys as insertSegment; a null speakerId clears it). */
    fun updateSegment(segmentId: Long, json: String?) = guard(Unit) {
        val s = Json.parseObject(json ?: "")
        val values = linkedMapOf<String, Any?>()
        if (s.containsKey("speakerId")) values["speaker_id"] = s.long("speakerId")
        for ((key, column) in listOf("text" to "text", "lang" to "lang", "translation" to "translation",
            "translationLang" to "translation_lang", "emotion" to "emotion", "searchMeta" to "search_meta"))
            s.string(key)?.let { values[column] = it }
        s.double("sentiment")?.let { values["sentiment"] = it }
        if (values.isNotEmpty())
            exec("UPDATE segments SET " + values.keys.joinToString(", ") { "$it=?" } + " WHERE id=?", *values.values.toTypedArray(), segmentId)
    }

    private val segmentColumns = "id, speaker_id, started_at, ended_at, audio_offset_ms, text, lang, translation, translation_lang, sentiment, emotion, angle"

    private fun segmentRow(c: List<String?>) = linkedMapOf<String, Any?>(
        "id" to c[0]!!.toLong(), "speakerId" to c[1]?.toLong(), "startedAt" to c[2]!!.toLong(), "endedAt" to c[3]!!.toLong(),
        "audioOffsetMs" to c[4]?.toLong(), "text" to c[5], "lang" to (c[6] ?: ""), "translation" to (c[7] ?: ""),
        "translationLang" to (c[8] ?: ""), "sentiment" to (c[9]?.toDouble() ?: 0.0), "emotion" to (c[10] ?: ""), "angle" to c[11]?.toLong(),
    )

    fun querySegments(sessionId: Long): String = guard("[]") {
        Json.write(rows("SELECT $segmentColumns FROM segments WHERE session_id=? ORDER BY started_at ASC", sessionId).map(::segmentRow))
    }

    /** Search segments across sessions. filterJson: query, emotion, speakerId, sinceMs, untilMs, limit. */
    fun searchSegments(filterJson: String?): String = guard("[]") {
        val filter = parseFilter(filterJson)
        val where = ArrayList<String>()
        val args = ArrayList<Any?>()
        filter.string("query")?.takeIf { it.isNotEmpty() }?.let {
            where.add("(text LIKE ? OR translation LIKE ? OR search_meta LIKE ?)")
            repeat(3) { _ -> args.add("%$it%") }
        }
        filter.string("emotion")?.let { where.add("emotion = ?"); args.add(it) }
        filter.long("speakerId")?.let { where.add("speaker_id = ?"); args.add(it) }
        filter.long("sinceMs")?.let { where.add("started_at >= ?"); args.add(it) }
        filter.long("untilMs")?.let { where.add("started_at <= ?"); args.add(it) }
        val statement = "SELECT $segmentColumns, session_id FROM segments" + whereClause(where) +
            " ORDER BY started_at DESC LIMIT " + limit(filter, 300)
        Json.write(rows(statement, *args.toTypedArray()).map { segmentRow(it).apply { put("sessionId", it[12]!!.toLong()) } })
    }

    /** Per-segment voice-print embeddings of a session (for re-diarization). */
    fun querySegmentEmbeddings(sessionId: Long): String = guard("[]") {
        Json.write(rows("SELECT id, hex(embedding) FROM segments WHERE session_id=? AND embedding IS NOT NULL", sessionId)
            .map { linkedMapOf("id" to it[0]!!.toLong(), "embeddingBase64" to Base64.encode(hexBytes(it[1]))) })
    }

    // ---- speakers ----

    fun createSpeaker(name: String?, color: String?, isWearer: Boolean, embeddingBase64: String?): Long = guard(-1L) {
        val now = currentTimeMillis()
        val embedding = embeddingBase64?.takeIf { it.isNotEmpty() }?.let { blobLiteral(Base64.decode(it)) }
        insert("INSERT INTO speakers (name, color, is_wearer, created_at, last_heard_at, embedding, embedding_count)" +
            " VALUES (?, ?, ?, ?, ?, ${embedding ?: "NULL"}, ${if (embedding != null) 1 else 0})",
            name, color?.ifEmpty { null } ?: DEFAULT_COLOR, if (isWearer) 1 else 0, now, now)
    }

    fun querySpeakers(): String = guard("[]") {
        Json.write(rows("SELECT p.id, p.name, p.color, p.is_wearer, hex(p.embedding), p.embedding_count, p.last_heard_at, p.tag," +
            " p.last_recap, p.action_items, p.facts, p.insights_updated_at, p.insights_session_id," +
            " (SELECT COUNT(*) FROM segments g WHERE g.speaker_id = p.id) FROM speakers p ORDER BY p.last_heard_at DESC").map { c ->
            linkedMapOf(
                "id" to c[0]!!.toLong(), "name" to c[1], "color" to c[2], "isWearer" to (c[3] != "0"),
                "embeddingBase64" to (c[4]?.takeIf { it.isNotEmpty() }?.let { Base64.encode(hexBytes(it)) } ?: ""),
                "embeddingCount" to c[5]!!.toLong(), "lastHeardAt" to (c[6]?.toLong() ?: 0L), "tag" to (c[7] ?: ""),
                "lastRecap" to (c[8] ?: ""), "actionItemsJson" to (c[9] ?: ""), "factsJson" to (c[10] ?: ""),
                "insightsUpdatedAt" to (c[11]?.toLong() ?: 0L), "insightsSessionId" to (c[12]?.toLong() ?: 0L),
                "segmentCount" to c[13]!!.toLong(),
            )
        })
    }

    fun renameSpeaker(speakerId: Long, name: String?) = guard(Unit) { exec("UPDATE speakers SET name=? WHERE id=?", name, speakerId) }

    fun setSpeakerColor(speakerId: Long, color: String?) = guard(Unit) { exec("UPDATE speakers SET color=? WHERE id=?", color, speakerId) }

    fun setSpeakerTag(speakerId: Long, tag: String?) = guard(Unit) { exec("UPDATE speakers SET tag=? WHERE id=?", tag, speakerId) }

    /** LLM insights for a speaker: recap, action items and facts (JSON string arrays). */
    fun setSpeakerInsights(speakerId: Long, recap: String?, actionItemsJson: String?, factsJson: String?, sessionId: Long) = guard(Unit) {
        exec("UPDATE speakers SET last_recap=?, action_items=?, facts=?, insights_updated_at=?, insights_session_id=? WHERE id=?",
            recap ?: "", actionItemsJson ?: "", factsJson ?: "", currentTimeMillis(), sessionId, speakerId)
    }

    /** Exactly one wearer profile at a time. */
    fun setSpeakerWearer(speakerId: Long, isWearer: Boolean) = guard(Unit) {
        if (isWearer) exec("UPDATE speakers SET is_wearer = 0")
        exec("UPDATE speakers SET is_wearer=? WHERE id=?", if (isWearer) 1 else 0, speakerId)
    }

    /** Running-mean centroid update, capped so a long session cannot drown the enrolled voice. */
    fun updateSpeakerEmbedding(speakerId: Long, embeddingBase64: String?, maxCount: Int) = guard(Unit) {
        val update = SpeakerEmbeddings.blobToFloats(Base64.decode(embeddingBase64 ?: "")) ?: return@guard
        val row = rows("SELECT hex(embedding), embedding_count FROM speakers WHERE id=?", speakerId).firstOrNull()
        val current = row?.get(0)?.let { SpeakerEmbeddings.blobToFloats(hexBytes(it)) }
        val centroid = SpeakerEmbeddings.runningMean(current, row?.get(1)?.toInt() ?: 0, update, maxCount)
        exec("UPDATE speakers SET embedding=${blobLiteral(SpeakerEmbeddings.floatsToBlob(centroid.embedding))}, embedding_count=?," +
            " last_heard_at=? WHERE id=?", centroid.count, currentTimeMillis(), speakerId)
    }

    /** Move every segment from one speaker onto another and drop the source. */
    fun mergeSpeakers(fromId: Long, intoId: Long) = guard(Unit) {
        if (fromId == intoId) return@guard
        transaction {
            exec("UPDATE segments SET speaker_id=? WHERE speaker_id=?", intoId, fromId)
            val profiles = rows("SELECT id, hex(embedding), embedding_count, is_wearer, last_recap, action_items, facts," +
                " insights_updated_at, insights_session_id FROM speakers WHERE id IN (?,?)", fromId, intoId)
                .associateBy { it[0]!!.toLong() }
            val from = profiles[fromId]
            val into = profiles[intoId]
            val embedding = { c: List<String?>? -> c?.get(1)?.let { SpeakerEmbeddings.blobToFloats(hexBytes(it)) } }
            val count = { c: List<String?>? -> c?.get(2)?.toInt() ?: 0 }
            val sets = ArrayList<String>()
            val args = ArrayList<Any?>()
            SpeakerEmbeddings.blend(embedding(from), count(from), embedding(into), count(into))?.let {
                sets.add("embedding=${blobLiteral(SpeakerEmbeddings.floatsToBlob(it))}")
                sets.add("embedding_count=?"); args.add(count(from) + count(into))
            }
            if (from?.get(3) == "1") sets.add("is_wearer=1")
            sets.add("last_heard_at=?"); args.add(currentTimeMillis())
            // Keep the target's insights; adopt the source's only where the target has none.
            val hasInsights = { c: List<String?>? -> !c?.get(4).isNullOrEmpty() }
            if (from != null && SpeakerEmbeddings.shouldAdoptInsights(hasInsights(into), hasInsights(from))) {
                sets.add("last_recap=?, action_items=?, facts=?, insights_updated_at=?, insights_session_id=?")
                args.addAll(listOf(from[4], from[5] ?: "", from[6] ?: "", from[7]?.toLong() ?: 0L, from[8]?.toLong() ?: 0L))
            }
            exec("UPDATE speakers SET ${sets.joinToString(", ")} WHERE id=?", *args.toTypedArray(), intoId)
            exec("DELETE FROM speakers WHERE id=?", fromId)
        }
    }

    fun reassignSegmentSpeaker(segmentId: Long, speakerId: Long) = guard(Unit) {
        exec("UPDATE segments SET speaker_id=? WHERE id=?", speakerId, segmentId)
    }

    /** Reassign every segment of a speaker within one session (split support). */
    fun reassignSessionSpeaker(sessionId: Long, fromSpeakerId: Long, toSpeakerId: Long) = guard(Unit) {
        exec("UPDATE segments SET speaker_id=? WHERE session_id=? AND speaker_id=?", toSpeakerId, sessionId, fromSpeakerId)
    }

    fun deleteSpeaker(speakerId: Long) = guard(Unit) {
        exec("UPDATE segments SET speaker_id=NULL WHERE speaker_id=?", speakerId)
        exec("DELETE FROM speakers WHERE id=?", speakerId)
    }

    // ---- retention ----

    /**
     * Delete caption sessions older than the cutoff (0 disables), and strip recordings older
     * than their own cutoff while keeping the transcript. Returns a JSON summary.
     */
    fun applyRetention(captionCutoffMs: Long, recordingCutoffMs: Long): String = guard("{}") {
        var sessionsDeleted = 0L
        var recordingsDeleted = 0
        val deleteAudio = { cutoff: Long ->
            for (row in rows("SELECT audio_path FROM sessions WHERE audio_path IS NOT NULL AND started_at < ?", cutoff))
                if (deleteFile(row[0]!!)) recordingsDeleted++
        }
        if (recordingCutoffMs > 0) {
            deleteAudio(recordingCutoffMs)
            exec("UPDATE sessions SET audio_path=NULL, audio_codec=NULL WHERE started_at < ?", recordingCutoffMs)
        }
        if (captionCutoffMs > 0) {
            deleteAudio(captionCutoffMs)
            exec("DELETE FROM segments WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)", captionCutoffMs)
            exec("DELETE FROM sessions WHERE started_at < ?", captionCutoffMs)
            sessionsDeleted = long("SELECT changes()") ?: 0
        }
        Json.write(linkedMapOf("sessionsDeleted" to sessionsDeleted, "recordingsDeleted" to recordingsDeleted))
    }

    // ---- crash recovery ----

    /**
     * Close out sessions a dead process left open (ended_at NULL), except excludeIdsJson's.
     * Returns them as a JSON array of {id, audioPath, audioCodec}.
     */
    fun closeInterruptedSessions(excludeIdsJson: String?): String = guard("[]") {
        val exclude = if (excludeIdsJson.isNullOrEmpty()) emptySet() else Json.parseArray(excludeIdsJson).map { (it as JsonNumber).toLong() }.toSet()
        val closed = rows("SELECT id, audio_path, audio_codec FROM sessions WHERE ended_at IS NULL")
            .filter { it[0]!!.toLong() !in exclude }
            .map { linkedMapOf("id" to it[0]!!.toLong(), "audioPath" to it[1], "audioCodec" to it[2]) }
        for (row in closed) {
            val id = row["id"]
            exec("UPDATE sessions SET ended_at = COALESCE((SELECT MAX(ended_at) FROM segments WHERE session_id = ?), started_at)," +
                " avg_sentiment = COALESCE((SELECT AVG(sentiment) FROM segments WHERE session_id = ?), 0) WHERE id = ?", id, id, id)
        }
        Json.write(closed)
    }

    /** File names (not paths) of every recording a session row names. */
    protected fun referencedRecordingNames(): Set<String> =
        rows("SELECT audio_path FROM sessions WHERE audio_path IS NOT NULL").map { it[0]!!.substringAfterLast('/') }.toSet()

    fun deleteSession(sessionId: Long) = guard(Unit) {
        getSessionAudioPath(sessionId).takeIf { it.isNotEmpty() }?.let { deleteFile(it) }
        exec("DELETE FROM segments WHERE session_id=?", sessionId)
        exec("DELETE FROM sessions WHERE id=?", sessionId)
    }

    // ---- helpers ----

    private fun parseFilter(json: String?): Map<String, Any?> = if (json.isNullOrEmpty()) emptyMap() else Json.parseObject(json)

    private fun whereClause(where: List<String>) = if (where.isEmpty()) "" else " WHERE " + where.joinToString(" AND ")

    private fun limit(filter: Map<String, Any?>, default: Long) = (filter.long("limit") ?: default).coerceIn(1, 1000)

    private fun Map<String, Any?>.long(key: String): Long? = when (val v = this[key]) {
        is JsonNumber -> v.toLong()
        is String -> v.toLong()
        else -> null
    }

    private fun Map<String, Any?>.double(key: String): Double? = when (val v = this[key]) {
        is JsonNumber -> v.toDouble()
        is String -> v.toDouble()
        else -> null
    }

    private fun Map<String, Any?>.string(key: String): String? = when (val v = this[key]) {
        null -> null
        is JsonNumber -> v.text
        else -> v.toString()
    }

    private fun blobLiteral(bytes: ByteArray) = "X'" + BinaryEncoding.bytesToHex(bytes) + "'"

    private fun hexBytes(hex: String?): ByteArray {
        val text = hex ?: ""
        return ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
}
