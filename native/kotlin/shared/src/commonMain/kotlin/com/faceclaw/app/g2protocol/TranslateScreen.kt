package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.jvm.JvmField

/**
 * The stock firmware's Translate screen, service 0x05: every packet is a TranslateDataPackage
 * {1 commandId, 2 magicRandom, 3..8 one sub-message}. Field numbers agree between
 * g2-kit-unofficial ble/gen/translate_pb.ts and Commute773's proto/g2/translate.proto;
 * CTRL OPEN's srcKey/dstKey (6/7), the "SRC>DST" pair format and error 66 (a repeated
 * magicRandom) come from ithinkthisiscool's apps/translate.py, decoded from the official app.
 * None of it is verified live yet: the Translate Tests page (T8) is that check.
 */
internal object TranslateProtocol {
    const val SID = 0x05

    const val CMD_CTRL = 1
    const val CMD_RESULT = 2
    const val CMD_NOTIFY = 161
    const val CMD_COMM_RESP = 162
    const val CMD_MODE_SWITCH = 163
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

    private fun text(field: Int, value: String): ByteArray = BleProtocol.encodeBytesField(field, value.encodeToByteArray())

    /** A decoded package from the glasses. value: NOTIFY/CTRL cmd or MODE_SWITCH mode; error: its errorCode. */
    class Reply(@JvmField val cmd: Int, @JvmField val magic: Int, @JvmField val value: Int, @JvmField val error: Int) {
        override fun toString(): String = "cmd=$cmd magic=$magic value=$value error=$error"
    }

    /** pb without the envelope CRC. */
    fun decode(pb: ByteArray): Reply {
        val cmd = BleProtocol.readVarintFieldValue(pb, 1, -1)
        val field = subField(cmd)
        val sub = (if (field == 0) null else BleProtocol.readFieldBytes(pb, field)) ?: ByteArray(0)
        val value = if (cmd == CMD_NOTIFY || cmd == CMD_CTRL || cmd == CMD_MODE_SWITCH) BleProtocol.readVarintFieldValue(sub, 1, 0) else 0
        val error = when (cmd) {
            CMD_COMM_RESP -> BleProtocol.readVarintFieldValue(sub, 1, 0)
            CMD_NOTIFY -> BleProtocol.readVarintFieldValue(sub, 2, 0)
            CMD_RESULT -> BleProtocol.readVarintFieldValue(sub, 3, 0)
            CMD_CTRL -> BleProtocol.readVarintFieldValue(sub, 4, 0)
            else -> 0
        }
        return Reply(cmd, BleProtocol.readVarintFieldValue(pb, 2, -1), value, error)
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
 * Bounded by [Timings.deadlineMs]; stops at the first reply carrying a non-zero error code or a
 * NOTIFY CLOSE from the glasses, and always sends CLOSE. Writes nothing but service 0x05.
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
    }

    private val replies = BlockingQueue<ByteArray>(platform)
    private val startedAt = platform.elapsedRealtimeMs()
    private var magic = firstMagic
    private var lastHeartbeatAt = startedAt

    @Volatile
    private var cancelled = false

    fun onFrame(pb: ByteArray) {
        replies.put(pb.copyOf())
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
            ok = outcome == "completed"
        } catch (t: Throwable) {
            CaughtErrors.report("TranslateScreenProbe.run", t)
            ok = false
            outcome = "failed: ${t.message ?: t}"
        } finally {
            try {
                if (send("close") { TranslateProtocol.close(it) }) await("close", timings.closeWaitMs)
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
        if (!send("open") { TranslateProtocol.open(it, source, target) }) return "open write failed"
        await("open", timings.replyWaitMs)?.let { return it }
        for ((index, update) in UPDATES.withIndex()) {
            if (cancelled) return "cancelled"
            if (elapsed() + timings.replyWaitMs + timings.closeWaitMs > timings.deadlineMs) return "deadline"
            if (platform.elapsedRealtimeMs() - lastHeartbeatAt >= timings.heartbeatMs) {
                lastHeartbeatAt = platform.elapsedRealtimeMs()
                if (!send("heartbeat") { TranslateProtocol.heartbeat(it) }) return "heartbeat write failed"
            }
            val step = "result ${index + 1}/${UPDATES.size} endFlag=${if (update.commit) 1 else 0} speaker=${update.speaker}"
            if (!send(step) { TranslateProtocol.result(it, update.source, update.translated, update.commit, update.speaker) }) return "result write failed"
            await(step, timings.replyWaitMs)?.let { return it }
        }
        return "completed"
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
     */
    private fun await(step: String, windowMs: Long): String? {
        val until = platform.elapsedRealtimeMs() + windowMs
        var seen = 0
        while (!cancelled) {
            val left = until - platform.elapsedRealtimeMs()
            if (left <= 0) break
            val pb = replies.poll(left) ?: break
            if (pb.isEmpty()) continue
            seen++
            val reply = TranslateProtocol.decode(pb)
            val closed = reply.cmd == TranslateProtocol.CMD_NOTIFY && reply.value == TranslateProtocol.CTRL_CLOSE
            listener.onStep("reply after $step", reply.error == 0, elapsed(), reply.toString())
            if (reply.error != 0) return "error ${reply.error} after $step"
            if (closed) return "glasses closed the screen after $step"
        }
        if (seen == 0 && !cancelled) listener.onStep("no reply after $step", false, elapsed(), "${windowMs}ms")
        return null
    }

    // Fresh per package (a repeat is error 66), within the session's 100-255 magic range.
    private fun nextMagic(): Int {
        val current = magic
        magic = if (magic >= BleMagicPool.MAX_MAGIC) BleMagicPool.MIN_MAGIC else magic + 1
        return current
    }

    private fun elapsed(): Int = (platform.elapsedRealtimeMs() - startedAt).toInt()
}
