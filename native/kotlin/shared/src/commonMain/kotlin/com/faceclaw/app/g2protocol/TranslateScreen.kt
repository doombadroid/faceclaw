package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.jvm.JvmField

/**
 * The stock firmware's Translate screen, service 0x05: every packet is a TranslateDataPackage
 * {1 commandId, 2 magicRandom, 3..8 one sub-message}. Field numbers agree between
 * g2-kit-unofficial ble/gen/translate_pb.ts and Commute773's proto/g2/translate.proto;
 * CTRL OPEN's srcKey/dstKey (6/7), the "SRC>DST" pair format and error 66 (a repeated
 * magicRandom, retried by the official app after 1 s with a new magic, up to 5 times) and
 * LANG_SWITCH 164/165 (fields 9/10) come from ithinkthisiscool's apps/translate.py, decoded
 * from the official app.
 * None of it is verified live yet: the Translate Tests page (T8) is that check.
 */
internal object TranslateProtocol {
    const val SID = 0x05

    const val CMD_CTRL = 1
    const val CMD_RESULT = 2
    const val CMD_NOTIFY = 161
    const val CMD_COMM_RESP = 162
    const val CMD_MODE_SWITCH = 163
    const val CMD_LANG_SWITCH_REQ = 164
    const val CMD_LANG_SWITCH_RSP = 165
    const val CMD_HEARTBEAT = 255

    const val CTRL_OPEN = 1
    const val CTRL_CLOSE = 2

    const val ERR_MAGIC_DUPLICATE = 66

    /** The package field that carries the sub-message for a command (0: none known). */
    fun subField(cmd: Int): Int = when (cmd) {
        CMD_CTRL -> 3
        CMD_RESULT -> 4
        CMD_NOTIFY -> 5
        CMD_MODE_SWITCH -> 6
        CMD_COMM_RESP -> 7
        CMD_HEARTBEAT -> 8
        CMD_LANG_SWITCH_REQ -> 9
        CMD_LANG_SWITCH_RSP -> 10
        else -> 0
    }

    /** The sub-message is always written, even empty: a package without one is rejected (error 7). */
    fun pack(cmd: Int, magic: Int, inner: ByteArray): ByteArray =
        BleProtocol.encodeVarintField(1, cmd) + BleProtocol.encodeVarintField(2, magic) + BleProtocol.encodeBytesField(subField(cmd), inner)

    /** CTRL OPEN {1 cmd, 2 "ES>EN", 6 srcKey, 7 dstKey}; useAudio (3) unset, so the glasses keep their mic off. */
    fun open(magic: Int, source: String, target: String): ByteArray {
        val src = source.trim().uppercase()
        val dst = target.trim().uppercase()
        return pack(CMD_CTRL, magic, BleProtocol.encodeVarintField(1, CTRL_OPEN) + text(2, "$src>$dst") + text(6, src) + text(7, dst))
    }

    fun close(magic: Int): ByteArray = pack(CMD_CTRL, magic, BleProtocol.encodeVarintField(1, CTRL_CLOSE))

    /** RESULT {1 srcText, 2 dstText, 4 endFlag, 5 speaker}: endFlag 0 a partial the next update replaces, 1 commits. */
    fun result(magic: Int, source: String, translated: String, commit: Boolean, speaker: String): ByteArray {
        var inner = text(1, source.trim()) + text(2, if (translated == " ") translated else translated.trim())
        if (commit) inner += BleProtocol.encodeVarintField(4, 1)
        if (speaker.isNotEmpty()) inner += text(5, speaker)
        return pack(CMD_RESULT, magic, inner)
    }

    fun heartbeat(magic: Int): ByteArray = pack(CMD_HEARTBEAT, magic, ByteArray(0))

    /** LANG_SWITCH_RSP {10: {}}: accepts a language the user picked on the glasses (errorCode 0 is left unset). */
    fun langSwitchResponse(magic: Int): ByteArray = pack(CMD_LANG_SWITCH_RSP, magic, ByteArray(0))

    private fun text(field: Int, value: String): ByteArray = BleProtocol.encodeBytesField(field, value.encodeToByteArray())

    /** A decoded package from the glasses. value: NOTIFY/CTRL cmd or MODE_SWITCH mode; error: its errorCode; key: LANG_SWITCH_REQ's langKey. */
    class Reply(@JvmField val cmd: Int, @JvmField val magic: Int, @JvmField val value: Int, @JvmField val error: Int, @JvmField val key: String = "") {
        override fun toString(): String = "cmd=$cmd magic=$magic value=$value error=$error" + if (key.isEmpty()) "" else " key=$key"
    }

    /** pb without the envelope CRC. */
    fun decode(pb: ByteArray): Reply {
        val cmd = BleProtocol.readVarintFieldValue(pb, 1, -1)
        val field = subField(cmd)
        val sub = (if (field == 0) null else BleProtocol.readFieldBytes(pb, field)) ?: ByteArray(0)
        val value = if (cmd == CMD_NOTIFY || cmd == CMD_CTRL || cmd == CMD_MODE_SWITCH) BleProtocol.readVarintFieldValue(sub, 1, 0) else 0
        val error = when (cmd) {
            CMD_COMM_RESP, CMD_LANG_SWITCH_RSP -> BleProtocol.readVarintFieldValue(sub, 1, 0)
            CMD_NOTIFY -> BleProtocol.readVarintFieldValue(sub, 2, 0)
            CMD_RESULT -> BleProtocol.readVarintFieldValue(sub, 3, 0)
            CMD_CTRL -> BleProtocol.readVarintFieldValue(sub, 4, 0)
            else -> 0
        }
        val key = if (cmd == CMD_LANG_SWITCH_REQ) BleProtocol.readFieldBytes(sub, 1)?.decodeToString() ?: "" else ""
        return Reply(cmd, BleProtocol.readVarintFieldValue(pb, 2, -1), value, error, key)
    }
}

/** [TranslateScreenProbe]'s report; called on the probe's thread (the iOS facade moves it to main). */
interface FaceclawTranslateProbeListener {
    /** ms: since the probe started. */
    fun onStep(step: String?, ok: Boolean, ms: Int, detail: String?)

    fun onFinished(ok: Boolean, detail: String?)
}

/**
 * Opens the firmware Translate screen, sends [UPDATES] (partials, commits, a speaker change) with
 * a heartbeat every [Timings.heartbeatMs], then closes it, reporting every packet and reply.
 * Bounded by [Timings.deadlineMs]; stops at the first reply carrying a non-zero error code (66,
 * a magicRandom the glasses saw recently, is retried with a new one as the official app does) or
 * a NOTIFY CLOSE from the glasses, and always sends CLOSE. Writes nothing but service 0x05.
 * A run the glasses never answered ends ok=false, "completed (no replies)".
 * [write] frames and sends one package; [onFrame] takes each 0x05 package the glasses send.
 */
internal class TranslateScreenProbe(
    private val write: (ByteArray) -> Boolean,
    private val listener: FaceclawTranslateProbeListener,
    private val source: String,
    private val target: String,
    private val timings: Timings = Timings(),
    private val platform: ProtocolPlatform = protocolPlatform(),
    firstMagic: Int = 100 + (platform.elapsedRealtimeMs() % 156).toInt(),
) {
    class Timings(
        @JvmField val replyWaitMs: Long = 2_500,
        @JvmField val heartbeatMs: Long = 4_000,
        @JvmField val closeWaitMs: Long = 2_000,
        @JvmField val deadlineMs: Long = 30_000,
        @JvmField val magicRetryMs: Long = 1_000,
    )

    /** source, translation, commit, speaker. */
    class Update(@JvmField val source: String, @JvmField val translated: String, @JvmField val commit: Boolean, @JvmField val speaker: String)

    companion object {
        val UPDATES = listOf(
            Update("¿Dónde está", "Where is", false, "A"),
            Update("¿Dónde está la estación?", "Where is the station?", false, "A"),
            Update("¿Dónde está la estación de tren?", "Where is the train station?", true, "A"),
            Update("Está a dos", "It's two", false, "B"),
            Update("Está a dos calles de aquí.", "It's two streets from here.", true, "B"),
            Update("Muchas gracias.", "Thank you very much.", true, "A"),
        )
        private const val WAKE_ONLY_SIZE = 0
        private const val MAGIC_TRIES = 5
        // Past the ~15 magics one run uses, so a retry leaves a previous run's range.
        private const val MAGIC_JUMP = 20
    }

    private val replies = BlockingQueue<ByteArray>(platform)
    private val startedAt = platform.elapsedRealtimeMs()
    private var magic = firstMagic
    private var lastHeartbeatAt = startedAt
    private var replyCount = 0
    private var lastError = 0

    @Volatile
    private var cancelled = false

    fun onFrame(pb: ByteArray) {
        replies.put(pb.copyOf())
    }

    /** Something the session saw while the probe runs (an EvenHub sys-event), so T8 can tell its effects apart. */
    fun noteSessionEvent(detail: String) {
        listener.onStep("session $detail", true, elapsed(), null)
    }

    fun cancel() {
        cancelled = true
        replies.put(ByteArray(WAKE_ONLY_SIZE))
    }

    fun run() {
        var outcome = "completed"
        var ok = true
        try {
            outcome = script()
            ok = outcome == "completed" && replyCount > 0
            if (outcome == "completed" && replyCount == 0) outcome = "completed (no replies)"
        } catch (t: Throwable) {
            CaughtErrors.report("TranslateScreenProbe.run", t)
            ok = false
            outcome = "failed: ${t.message ?: t}"
        } finally {
            try {
                exchange("close", timings.closeWaitMs) { TranslateProtocol.close(it) }
            } catch (t: Throwable) {
                CaughtErrors.report("TranslateScreenProbe.close", t)
                ok = false
                outcome += "; close failed: ${t.message ?: t}"
            }
            listener.onFinished(ok, outcome)
        }
    }

    /** "completed", or why it stopped early. */
    private fun script(): String {
        exchange("open", timings.replyWaitMs) { TranslateProtocol.open(it, source, target) }?.let { return it }
        for ((index, update) in UPDATES.withIndex()) {
            if (cancelled) return "cancelled"
            if (elapsed() + timings.replyWaitMs + timings.closeWaitMs > timings.deadlineMs) return "deadline"
            if (platform.elapsedRealtimeMs() - lastHeartbeatAt >= timings.heartbeatMs) {
                lastHeartbeatAt = platform.elapsedRealtimeMs()
                if (!send("heartbeat") { TranslateProtocol.heartbeat(it) }) return "heartbeat write failed"
            }
            val step = "result ${index + 1}/${UPDATES.size} endFlag=${if (update.commit) 1 else 0} speaker=${update.speaker}"
            exchange(step, timings.replyWaitMs) { TranslateProtocol.result(it, update.source, update.translated, update.commit, update.speaker) }?.let { return it }
        }
        return "completed"
    }

    /**
     * send + await; after error 66 waits [Timings.magicRetryMs] and resends with a new magic, up to
     * [MAGIC_TRIES] times while the deadline allows. Null, or the reason to stop.
     */
    private fun exchange(step: String, windowMs: Long, build: (Int) -> ByteArray): String? {
        var tries = 1
        while (true) {
            if (!send(step, build)) return "$step write failed"
            val stop = await(step, windowMs) ?: return null
            if (lastError != TranslateProtocol.ERR_MAGIC_DUPLICATE || tries >= MAGIC_TRIES || cancelled ||
                elapsed() + timings.magicRetryMs + windowMs > timings.deadlineMs) return stop
            tries++
            magic = wrapMagic(magic + MAGIC_JUMP)
            listener.onStep("retry $step", true, elapsed(), "error 66: new magic in ${timings.magicRetryMs}ms (try $tries/$MAGIC_TRIES)")
            await("retry wait", timings.magicRetryMs, reportSilence = false)?.let { if (lastError != TranslateProtocol.ERR_MAGIC_DUPLICATE) return it }
        }
    }

    /** build gets the package's fresh magicRandom. */
    private fun send(step: String, build: (Int) -> ByteArray): Boolean {
        val id = nextMagic()
        val pb = build(id)
        val written = write(pb)
        listener.onStep("send $step", written, elapsed(), "magic=$id bytes=${pb.size}" + if (written) "" else " write failed")
        return written
    }

    /**
     * Reports every package for windowMs; the reason to stop at the first non-zero error code or a
     * NOTIFY CLOSE, null otherwise. A window with no reply is reported but does not stop the run.
     * A LANG_SWITCH_REQ (the user picked a language on the glasses) is answered with a LANG_SWITCH_RSP.
     */
    private fun await(step: String, windowMs: Long, reportSilence: Boolean = true): String? {
        val until = platform.elapsedRealtimeMs() + windowMs
        var seen = 0
        lastError = 0
        while (!cancelled) {
            val left = until - platform.elapsedRealtimeMs()
            if (left <= 0) break
            val pb = replies.poll(left) ?: break
            if (pb.isEmpty()) continue
            seen++
            replyCount++
            val reply = TranslateProtocol.decode(pb)
            val closed = reply.cmd == TranslateProtocol.CMD_NOTIFY && reply.value == TranslateProtocol.CTRL_CLOSE
            listener.onStep("reply after $step", reply.error == 0, elapsed(), reply.toString())
            if (reply.error != 0) {
                lastError = reply.error
                return "error ${reply.error} after $step"
            }
            if (closed) return "glasses closed the screen after $step"
            if (reply.cmd == TranslateProtocol.CMD_LANG_SWITCH_REQ && !send("lang switch response") { TranslateProtocol.langSwitchResponse(it) })
                return "lang switch response write failed"
        }
        if (seen == 0 && !cancelled && reportSilence) listener.onStep("no reply after $step", false, elapsed(), "${windowMs}ms")
        return null
    }

    // Fresh per package (a repeat is error 66), within the session's 100-255 magic range.
    private fun nextMagic(): Int {
        val current = magic
        magic = wrapMagic(magic + 1)
        return current
    }

    private fun wrapMagic(value: Int): Int =
        if (value > BleMagicPool.MAX_MAGIC) BleMagicPool.MIN_MAGIC + (value - BleMagicPool.MAX_MAGIC - 1) else value

    private fun elapsed(): Int = (platform.elapsedRealtimeMs() - startedAt).toInt()
}
