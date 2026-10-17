package com.faceclaw.app

import platform.Foundation.NSData

/** Binary adapters only: atlas identity, RLE, residency and planning stay in commonMain. */
class IosTextureAtlas {
    fun fontId(key: String): Int = boundary("IosTextureAtlas.fontId", 0) { GlyphAtlas.fontId(key) }

    fun registerGlyphs(data: NSData) = boundary("IosTextureAtlas.registerGlyphs", Unit) { GlyphAtlas.register(IosByteReader(data)) }

    fun registerAaGlyphs(data: NSData) = boundary("IosTextureAtlas.registerAaGlyphs", Unit) { GlyphAtlas.registerAa(IosByteReader(data)) }

    fun registerFirmwareGlyphs(data: NSData) =
        boundary("IosTextureAtlas.registerFirmwareGlyphs", Unit) { FwGlyphAtlas.register(IosByteReader(data)) }

    /** 0 (no atlas image: the frame's pixels still carry it) when the image is rejected. */
    fun imageId(key: String, width: Int, height: Int, data: NSData): Int =
        boundary("IosTextureAtlas.imageId", 0) { ImageAtlas.ensure(key, width, height, IosByteReader(data)) }
}

/** A snapshot keeps pixels and their screen-space draw identities together while JS coalesces. */
class IosTextureFrame internal constructor(internal val composite: SurfaceCompositor.Composite) {
    val pixels: NSData = composite.gray.data()
    val width: Int = composite.width
    val height: Int = composite.height
}

class IosTexturePlan internal constructor(result: ScenePlanner.Plan, val usedBytes: Int) {
    val payload: NSData = result.commands.last().data()
    val resourceCommands: List<NSData> = result.commands.dropLast(1).map { it.data() }
    val nextFid: Int = result.nextFid
}

/** One instance per BLE session, called on the session's serial JS thread. */
class IosTexturePlanner {
    private val cache = ResourceCacheState()
    private val planner = ScenePlanner(cache)

    fun reset() = cache.reset()

    fun plan(previous: NSData?, next: NSData, frame: IosTextureFrame, firstId: Int): IosTexturePlan? {
        val composite = frame.composite
        val result = planner.plan(BmpUtil.pack4bppFromGray8(composite.screenGray, composite.width, composite.height),
            composite.width, composite.height, composite.draws, composite.shellScene, firstId)
        return IosTexturePlan(result, cache.usedBytes())
    }
}
