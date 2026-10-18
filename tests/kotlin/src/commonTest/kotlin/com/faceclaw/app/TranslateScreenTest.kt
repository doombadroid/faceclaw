package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private fun hex(value: String) = value.replace(" ", "").chunked(2).map { it.toInt(16).toByte() }.toByteArray()

private fun ByteArray.hex() = joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }

private fun utf8(text: String) = text.encodeToByteArray().hex()

/** Records the probe's report; steps as "step|ok". */
private class Recorder : FaceclawTranslateProbeListener {
    val steps = ArrayList<String>()
    var finished: Pair<Boolean, String?>? = null
    override fun onStep(step: String?, ok: Boolean, ms: Int, detail: String?) { steps.add("$step|$ok|$detail") }
    override fun onFinished(ok: Boolean, detail: String?) { finished = ok to detail }
}

/** COMM_RESP {7: {1 errorCode}} for magic. */
private fun commResp(magic: Int, error: Int) =
    TranslateProtocol.pack(TranslateProtocol.CMD_COMM_RESP, magic, if (error == 0) ByteArray(0) else BleProtocol.encodeVarintField(1, error))

class TranslateScreenTest {
    // Expected bytes are written out by hand from the .proto field numbers (translate_pb.ts and
    // Commute773's translate.proto agree; srcKey/dstKey 6/7 from translate.py), not from the encoder.

    @Test
    fun openCarriesThePairAndKeysInCtrl() {
        val inner = "08 01" + "12 05" + utf8("ES>EN") + "32 02" + utf8("ES") + "3a 02" + utf8("EN")
        assertEquals("0801" + "1078" + "1a11" + inner.replace(" ", ""), TranslateProtocol.open(120, " es", "en ").hex())
    }

    @Test
    fun closeAndHeartbeatAlwaysCarryTheirSubMessage() {
        assertEquals("0801" + "1065" + "1a02" + "0802", TranslateProtocol.close(101).hex())
        // commandId 255 is a two-byte varint; field 8 is written even empty (an empty package is error 7).
        assertEquals("08ff01" + "1064" + "4200", TranslateProtocol.heartbeat(100).hex())
    }

    @Test
    fun resultPartialAndCommit() {
        val partial = "0a04" + utf8("Hola") + "1205" + utf8("Hello") + "2a01" + utf8("A")
        assertEquals("0802" + "108001" + "22" + "10" + partial, TranslateProtocol.result(128, " Hola ", "Hello ", false, "A").hex())
        val commit = "0a04" + utf8("Hola") + "1205" + utf8("Hello") + "2001"
        assertEquals("0802" + "1064" + "22" + "0f" + commit, TranslateProtocol.result(100, "Hola", "Hello", true, "").hex())
        // A lone-space translation is kept, as the official app does.
        assertTrue(TranslateProtocol.result(100, "x", " ", false, "").hex().contains("1201" + "20"))
    }

    @Test
    fun utf8TextIsNotTerminated() {
        val pb = TranslateProtocol.result(100, "你好", "Hi", true, "")
        assertEquals("0a06" + utf8("你好") + "1202" + utf8("Hi") + "2001", BleProtocol.readFieldBytes(pb, 4)!!.hex())
    }

    @Test
    fun decodesRepliesFromTheGlasses() {
        val dup = TranslateProtocol.decode(hex("08 a2 01 10 70 3a 02 08 42"))
        assertEquals(listOf(162, 112, 0, 66), listOf(dup.cmd, dup.magic, dup.value, dup.error))
        val closed = TranslateProtocol.decode(hex("08 a1 01 10 05 2a 02 08 02"))
        assertEquals(listOf(161, 5, 2, 0), listOf(closed.cmd, closed.magic, closed.value, closed.error))
        val ok = TranslateProtocol.decode(hex("08 a2 01 10 71 3a 00"))
        assertEquals(0, ok.error)
        assertEquals(-1, TranslateProtocol.decode(ByteArray(0)).cmd)
    }

    @Test
    fun framesOnService5() {
        val frame = BleProtocol.framePb(TranslateProtocol.heartbeat(100), TranslateProtocol.SID, BleProtocol.FLAG_REQUEST, 9).single()
        assertEquals(listOf(0xaa, 0x21, 9, 0x05, 0x20), listOf(0, 1, 2, 6, 7).map { frame[it].toInt() and 255 })
        assertEquals(TranslateProtocol.heartbeat(100).hex(), BleProtocol.stripTrailingCrc(BleProtocol.parseFrame(frame).pb).hex())
    }

    private val fast = TranslateScreenProbe.Timings(replyWaitMs = 25, heartbeatMs = 60, closeWaitMs = 10, deadlineMs = 5_000)

    /** Runs a probe whose glasses answer each package with reply(sent so far, its magic) (null: silence). */
    private fun run(reply: (List<TranslateProtocol.Reply>, Int) -> ByteArray?): Pair<Recorder, List<TranslateProtocol.Reply>> {
        val recorder = Recorder()
        val sent = ArrayList<TranslateProtocol.Reply>()
        lateinit var probe: TranslateScreenProbe
        probe = TranslateScreenProbe({ pb ->
            val decoded = TranslateProtocol.decode(pb)
            sent.add(decoded)
            reply(sent, decoded.magic)?.let { probe.onFrame(it) }
            true
        }, recorder, "es", "en", fast, testPlatform(), firstMagic = 254)
        probe.run()
        return recorder to sent
    }

    @Test
    fun opensSendsEveryUpdateWithHeartbeatsAndCloses() {
        val (recorder, sent) = run { _, magic -> commResp(magic, 0) }
        assertEquals(true to "completed", recorder.finished)
        assertEquals(listOf(TranslateProtocol.CMD_CTRL, TranslateProtocol.CTRL_OPEN), listOf(sent.first().cmd, sent.first().value))
        assertEquals(listOf(TranslateProtocol.CMD_CTRL, TranslateProtocol.CTRL_CLOSE), listOf(sent.last().cmd, sent.last().value))
        assertEquals(TranslateScreenProbe.UPDATES.size, sent.count { it.cmd == TranslateProtocol.CMD_RESULT })
        assertTrue(sent.any { it.cmd == TranslateProtocol.CMD_HEARTBEAT }, "a heartbeat between results")
        // Fresh magicRandom per package, wrapping inside the session's 100-255 range.
        val magics = sent.map { it.magic }
        assertEquals(magics.size, magics.toSet().size)
        assertEquals(listOf(254, 255), magics.take(2))
        assertTrue(100 in magics && magics.all { it in 100..255 }, magics.toString())
        assertTrue(recorder.steps.none { it.contains("|false|") }, recorder.steps.joinToString("\n"))
    }

    @Test
    fun stopsAtTheFirstErrorCodeAndStillCloses() {
        val results = { sent: List<TranslateProtocol.Reply> -> sent.count { it.cmd == TranslateProtocol.CMD_RESULT } }
        val (recorder, sent) = run { so, magic -> commResp(magic, if (results(so) == 2) TranslateProtocol.ERR_MAGIC_DUPLICATE else 0) }
        assertEquals(false, recorder.finished!!.first)
        assertTrue(recorder.finished!!.second!!.startsWith("error 66 after result 2/6"), recorder.finished!!.second)
        assertEquals(2, results(sent))
        assertEquals(listOf(TranslateProtocol.CMD_CTRL, TranslateProtocol.CTRL_CLOSE), listOf(sent.last().cmd, sent.last().value))
    }

    @Test
    fun aGlassesCloseEndsTheRun() {
        val notifyClose = { magic: Int -> TranslateProtocol.pack(TranslateProtocol.CMD_NOTIFY, magic, BleProtocol.encodeVarintField(1, TranslateProtocol.CTRL_CLOSE)) }
        val (recorder, _) = run { so, magic -> if (so.last().cmd == TranslateProtocol.CMD_RESULT) notifyClose(magic) else commResp(magic, 0) }
        assertEquals(false to "glasses closed the screen after result 1/6 endFlag=0 speaker=A", recorder.finished)
    }

    @Test
    fun silenceIsReportedNotFatal() {
        val (recorder, sent) = run { _, _ -> null }
        assertEquals(true to "completed", recorder.finished)
        assertTrue(recorder.steps.any { it.startsWith("no reply after open|false") })
        assertEquals(listOf(TranslateProtocol.CMD_CTRL, TranslateProtocol.CTRL_CLOSE), listOf(sent.last().cmd, sent.last().value))
    }
}
