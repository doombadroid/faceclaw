package com.faceclaw.app

import kotlin.test.*

class IosNativeApiTest {
    @Test
    fun binaryFacadeRoundTripsAndSlices() {
        val bytes = byteArrayOf(0, -1, 2, -128)
        assertContentEquals(bytes, bytes.data().byteArray())
        assertTrue(byteArrayOf().data().byteArray().isEmpty())
        val reader = IosByteReader(bytes.data())
        assertEquals(0, reader.get().toInt())
        val target = ByteArray(5)
        reader.get(target, 1, 3)
        assertContentEquals(byteArrayOf(0, -1, 2, -128, 0), target)
        assertEquals(0, reader.remaining())
        val protocol = IosProtocol()
        val auth = protocol.authentication(101)
        val frames = protocol.frame(auth, 128, 0, 64, 185)
        val result = IosMessageReceiver().receive("L", frames.single(), 0).single()
        assertEquals(101, result.magic)
        assertContentEquals(auth.byteArray(), result.payload.byteArray())
    }

    @Test
    fun compassFacadePreservesTheEndOfTheCrcFreePayload() {
        val protocol = IosProtocol()
        val payload = byteArrayOf(8, 15, 16, 0, 82, 3, 8, -25, 2).data()
        assertEquals(359, protocol.compassInput(payload, 8, 1)?.headingDegrees)
        assertNull(protocol.compassInput(payload, 8, 0))
    }

    @Test
    fun nativeCompositorClipsPartialUpdatesBeforeCoalescing() {
        val compositor = IosSurfaceCompositor(3, 2)
        compositor.configure("app", 0, 0, 3, 2, 0, false)
        compositor.submit("app", byteArrayOf(10, 20, 30, 40, 50, 60).data(), -1, 0, 3, 2)
        assertContentEquals(byteArrayOf(20, 30, 0, 50, 60, 0), compositor.composite().byteArray())
        compositor.submit("app", byteArrayOf(99).data(), 2, 1, 1, 1)
        assertContentEquals(byteArrayOf(20, 30, 0, 50, 60, 99), compositor.composite().byteArray())
        compositor.blank(true)
        assertContentEquals(ByteArray(6), compositor.composite().byteArray())
        compositor.blank(false)
        assertEquals(99, compositor.composite().byteArray().last().toInt())
    }

    @Test
    fun gifRecorderEncodesCompositeFramesWithTheirSize() {
        val recorder = IosGifRecorder()
        assertNull(recorder.encode(), "no frames, no file")
        val compositor = IosSurfaceCompositor(4, 2)
        compositor.configure("app", 0, 0, 4, 2, 0, false)
        compositor.submit("app", ByteArray(8) { -1 }.data(), 0, 0, 4, 2)
        val frame = compositor.compositeFrame()
        assertEquals(4 to 2, frame.width to frame.height)
        recorder.add(frame.pixels, frame.width, frame.height, 0)
        recorder.add(ByteArray(8).data(), 4, 2, 1_000)
        val gif = assertNotNull(recorder.encode()).byteArray()
        assertEquals("GIF89a", gif.copyOf(6).decodeToString())
        assertEquals(0x3b, gif.last().toInt())
    }

    @Test
    fun photoToneMatchesTheSharedCurveAndDither() {
        val protocol = IosProtocol()
        val packet = byteArrayOf(2, 0, 1, 0, -128, -1)
        val curve = GrayPacket.toneCurve(2.2f)
        assertContentEquals(byteArrayOf(2, 0, 1, 0, curve[128].toByte(), -1), protocol.tone(packet.data(), 2.2f, false).byteArray())
        val dithered = protocol.tone(byteArrayOf(2, 0, 2, 0, 0, 40, 90, -56).data(), 1f, true).byteArray()
        assertContentEquals(byteArrayOf(2, 0, 2, 0), dithered.copyOf(4))
        assertTrue(dithered.drop(4).all { it.toInt() != 0 && (it.toInt() and 255) % 16 <= 1 }, dithered.toList().toString())
        val short = byteArrayOf(9, 0, 9, 0, 1).data()
        assertContentEquals(short.byteArray(), protocol.tone(short, 2.2f, true).byteArray(), "a malformed packet passes through")
    }

    @Test
    fun videoPlayerReportsUnplayableFilesAndHasNoFrameBeforeStart() {
        val player = IosVideoPlayer()
        assertTrue(player.probe("/nonexistent.mp4").contains("\"error\""))
        assertNull(player.lastFrame(4, 2))
        player.start("/nonexistent.mp4", 0, 0, false, 2.2f, false, 0.0)
        assertFalse(player.isPlaying(), "a zero-size rect never starts")
        assertEquals(0.0, player.positionMs())
        player.stop()
    }
}
