@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import platform.Foundation.NSData
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue
import platform.darwin.dispatch_queue_create

/** iPhone-notification relay hooks; both callbacks are delivered on the main queue. */
interface IosAncsListener {
    fun onAncsAuthorization(authorized: Boolean)

    /** A relay frame ('A','N',...) received on the right arm's data characteristic. */
    fun onRelayFrame(data: NSData)
}

/** Audio packets for the NativeScript side as NSData (a Kotlin ByteArray crosses per byte). Main queue. */
interface IosAudioPacketListener {
    fun onAudioPacket(data: NSData, arm: String, arrivalMs: Long)
}

/**
 * ObjC-facing facade over the shared [GlassesSessionCore] for the NativeScript app: the iOS
 * counterpart of Android's FaceclawBleCommunicator with the same method names. GATT goes
 * through [IosBleCentral], side effects through [IosSessionHost]; every listener the
 * TypeScript side installs is invoked on the main queue. Binary crossings use NSData.
 */
class IosGlassesSession internal constructor(
    link: SessionLink,
    private val central: IosBleCentral?,
    private val host: SessionHost,
    rightAddress: String,
    leftAddress: String,
    ringAddress: String,
    platform: ProtocolPlatform,
) {
    /** Production constructor: CoreBluetooth link + main-queue host. Addresses are peripheral identifiers. */
    constructor(rightAddress: String, leftAddress: String, ringAddress: String) : this(
        IosBleCentral(),
        rightAddress,
        leftAddress,
        ringAddress,
    )

    private constructor(central: IosBleCentral, rightAddress: String, leftAddress: String, ringAddress: String) : this(
        central,
        central,
        IosSessionHost(),
        rightAddress,
        leftAddress,
        ringAddress,
        IosProtocolPlatform,
    )

    companion object {
        const val TAG = GlassesSessionCore.TAG
    }

    private val frameTimings = IosFrameTimings.shared.core
    private val core = GlassesSessionCore(link, host, frameTimings, platform, rightAddress, leftAddress, ringAddress)
    private val rawQueue = dispatch_queue_create("com.faceclaw.session.raw", null)
    private val rightIdentifier = rightAddress.uppercase()

    init {
        central?.setSessionListener(core)
    }

    // ----- lifecycle ------------------------------------------------------------------
    // Every entry point below goes through boundary(): an exception reaching Objective-C ends the app.

    fun setListener(listener: FaceclawBleCommunicatorListener?) = boundary("IosGlassesSession.setListener", Unit) { core.setListener(listener) }

    fun setRequiredFirmwareRevision(revision: Int) =
        boundary("IosGlassesSession.setRequiredFirmwareRevision", Unit) { core.setRequiredFirmwareRevision(revision) }

    fun start(): Boolean = boundary("IosGlassesSession.start", false) { core.start() }

    fun disconnect() = boundary("IosGlassesSession.disconnect", Unit) { core.disconnect() }

    fun close() = boundary("IosGlassesSession.close", Unit) { core.close() }

    fun onPhoneLockSignal() = boundary("IosGlassesSession.onPhoneLockSignal", Unit) { core.onPhoneLockSignal() }

    fun isSessionReady(): Boolean = boundary("IosGlassesSession.isSessionReady", false) { core.isSessionReady() }

    // ----- iPhone notification relay (ANCS) -------------------------------------------------

    /** Ask CoreBluetooth for ANCS on the right arm's next connection (call before start()). */
    fun setRequiresAncs(required: Boolean): Unit = boundary("IosGlassesSession.setRequiresAncs", Unit) {
        central?.setRequiresAncs(rightIdentifier, required)
    }

    fun isAncsAuthorized(): Boolean = boundary("IosGlassesSession.isAncsAuthorized", false) {
        central?.isAncsAuthorized(rightIdentifier) ?: false
    }

    fun setAncsListener(listener: IosAncsListener?) = boundary("IosGlassesSession.setAncsListener", Unit) {
        if (listener == null) {
            core.setRawFrameTap(null)
            central?.setAncsAuthorizationListener(null)
            return@boundary
        }
        core.setRawFrameTap { bytes ->
            val data = bytes.data()
            dispatch_async(dispatch_get_main_queue()) { listener.onRelayFrame(data) }
        }
        central?.setAncsAuthorizationListener { _, authorized ->
            dispatch_async(dispatch_get_main_queue()) { listener.onAncsAuthorization(authorized) }
        }
    }

    /** Queue one relay packet for the right arm; never blocks the caller (writes run on a serial queue). */
    fun writeRawToRight(packet: NSData) = boundary("IosGlassesSession.writeRawToRight", Unit) {
        val bytes = packet.byteArray()
        dispatch_async(rawQueue) {
            if (!core.writeRawPacket("R", bytes)) PlatformLog.w(TAG, "relay packet dropped (${bytes.size} bytes)")
        }
    }

    // ----- controls -------------------------------------------------------------------

    fun setG2ScreenOn(screenOn: Boolean): String? = boundaryError("IosGlassesSession.setG2ScreenOn") { core.setG2ScreenOn(screenOn) }

    fun setFirmwareDebugFlags(enabled: Boolean) = boundary("IosGlassesSession.setFirmwareDebugFlags", Unit) { core.setFirmwareDebugFlags(enabled) }

    /** The packet listener is invoked on the main queue (the core delivers on the BLE callback queue). */
    fun startG2AudioCapture(listener: FaceclawAudioPacketListener?): Boolean = boundary("IosGlassesSession.startG2AudioCapture", false) {
        core.startG2AudioCapture(listener?.let { MainQueueAudioListener(it) })
    }

    fun stopG2AudioCapture() = boundary("IosGlassesSession.stopG2AudioCapture", Unit) { core.stopG2AudioCapture() }

    /** As [startG2AudioCapture], with packets delivered as NSData on the main queue. */
    fun startG2AudioCaptureNsData(listener: IosAudioPacketListener): Boolean = boundary("IosGlassesSession.startG2AudioCaptureNsData", false) {
        core.startG2AudioCapture(NsDataAudioListener(listener))
    }

    /** The right arm's usable write payload (ATT MTU minus the 3-byte header), or 20 when unknown. */
    fun rightWriteLimit(): Int = boundary("IosGlassesSession.rightWriteLimit", 20) {
        val mtu = central?.negotiatedMtu(rightIdentifier) ?: 0
        if (mtu > 3) mtu - 3 else 20
    }

    fun isAudioCaptureActive(): Boolean = boundary("IosGlassesSession.isAudioCaptureActive", false) { core.isAudioCaptureActive() }

    fun setFaceclawWakeLeaseEnabled(enabled: Boolean): Boolean = boundary("IosGlassesSession.setFaceclawWakeLeaseEnabled", false) {
        core.setFaceclawWakeLeaseEnabled(enabled)
    }

    fun awaitEvenHubSessionReady(timeoutMs: Int): Boolean = boundary("IosGlassesSession.awaitEvenHubSessionReady", false) {
        core.awaitEvenHubSessionReady(timeoutMs)
    }

    fun setImuReportEnabled(enable: Boolean, reportFrq: Int) = boundary("IosGlassesSession.setImuReportEnabled", Unit) {
        core.setImuReportEnabled(enable, reportFrq)
    }

    fun setCompassEnabled(enable: Boolean) = boundary("IosGlassesSession.setCompassEnabled", Unit) { core.setCompassEnabled(enable) }

    fun setCompassEnabledForOwner(owner: String?, enable: Boolean) = boundary("IosGlassesSession.setCompassEnabledForOwner", Unit) {
        core.setCompassEnabled(owner, enable)
    }

    fun setBrightness(autoAdjust: Boolean, brightnessLevel: Int) = boundary("IosGlassesSession.setBrightness", Unit) {
        core.setBrightness(autoAdjust, brightnessLevel)
    }

    /**
     * A curve Kotlin rejects leaves the previous settings in force; the error is filed as a report
     * and returned for JS to throw (pushBrightness logs it and retries on the next settings change).
     */
    // These three return the error like the compositor calls: their JS callers have failure paths (as on Android).
    fun configureBrightness(auto: Boolean, level: Int, minimum: Int, maximum: Int, curve: String, fadeMs: Int): String? =
        boundaryError("IosGlassesSession.configureBrightness") { core.configureBrightness(auto, level, minimum, maximum, curve, fadeMs) }

    fun enableWearDetectionAndRequestState(): String? =
        boundaryError("IosGlassesSession.enableWearDetectionAndRequestState") { core.enableWearDetectionAndRequestState() }

    fun startBandwidthBenchmark(messageSize: Int, windowSize: Int, durationMs: Int): Boolean =
        boundary("IosGlassesSession.startBandwidthBenchmark", false) { core.startBandwidthBenchmark(messageSize, windowSize, durationMs) }

    fun startBandwidthBenchmarkWithLinkMode(messageSize: Int, windowSize: Int, durationMs: Int, linkMode: Int): Boolean =
        boundary("IosGlassesSession.startBandwidthBenchmarkWithLinkMode", false) {
            core.startBandwidthBenchmarkWithLinkMode(messageSize, windowSize, durationMs, linkMode)
        }

    fun cancelBandwidthBenchmark() = boundary("IosGlassesSession.cancelBandwidthBenchmark", Unit) { core.cancelBandwidthBenchmark() }

    fun getBandwidthBenchmarkStatus(): String = boundary("IosGlassesSession.getBandwidthBenchmarkStatus", "") { core.getBandwidthBenchmarkStatus() }

    fun addImuListener(listener: FaceclawImuListener?) = boundary("IosGlassesSession.addImuListener", Unit) { core.addImuListener(listener) }

    fun removeImuListener(listener: FaceclawImuListener?) = boundary("IosGlassesSession.removeImuListener", Unit) { core.removeImuListener(listener) }

    fun addAmbientLightListener(listener: FaceclawAmbientLightListener?) =
        boundary("IosGlassesSession.addAmbientLightListener", Unit) { core.addAmbientLightListener(listener) }

    fun removeAmbientLightListener(listener: FaceclawAmbientLightListener?) =
        boundary("IosGlassesSession.removeAmbientLightListener", Unit) { core.removeAmbientLightListener(listener) }

    fun queryAmbientLight() = boundary("IosGlassesSession.queryAmbientLight", Unit) { core.queryAmbientLight() }

    fun setAmbientLightPolling(enable: Boolean, intervalMs: Int, minDelta: Int, heartbeatMs: Int, bindToLease: Boolean) =
        boundary("IosGlassesSession.setAmbientLightPolling", Unit) { core.setAmbientLightPolling(enable, intervalMs, minDelta, heartbeatMs, bindToLease) }

    fun addMicStatusListener(listener: FaceclawMicStatusListener?) =
        boundary("IosGlassesSession.addMicStatusListener", Unit) { core.addMicStatusListener(listener) }

    fun removeMicStatusListener(listener: FaceclawMicStatusListener?) =
        boundary("IosGlassesSession.removeMicStatusListener", Unit) { core.removeMicStatusListener(listener) }

    fun sendFaceclawMicControl(record: NSData?, label: String, rightTemple: Boolean, leftTemple: Boolean): Boolean =
        boundary("IosGlassesSession.sendFaceclawMicControl", false) {
            core.sendFaceclawMicControl(record?.byteArray(), label, rightTemple, leftTemple)
        }

    fun startG2AudioForwarding(listener: FaceclawAudioPacketListener?): Boolean = boundary("IosGlassesSession.startG2AudioForwarding", false) {
        core.startG2AudioForwarding(listener?.let { MainQueueAudioListener(it) })
    }

    fun stopG2AudioForwarding() = boundary("IosGlassesSession.stopG2AudioForwarding", Unit) { core.stopG2AudioForwarding() }

    /** As [startG2AudioForwarding], with packets delivered as NSData on the main queue. */
    fun startG2AudioForwardingNsData(listener: IosAudioPacketListener): Boolean =
        boundary("IosGlassesSession.startG2AudioForwardingNsData", false) { core.startG2AudioForwarding(NsDataAudioListener(listener)) }

    private val monitorWrappers = HashMap<IosAudioPacketListener, FaceclawAudioPacketListener>()

    /** Every audio-characteristic packet (passive), as NSData on the main queue. Call from main. */
    fun addAudioMonitorListenerNsData(listener: IosAudioPacketListener) = boundary("IosGlassesSession.addAudioMonitorListenerNsData", Unit) {
        if (listener !in monitorWrappers) core.addAudioMonitorListener(NsDataAudioListener(listener).also { monitorWrappers[listener] = it })
    }

    fun removeAudioMonitorListenerNsData(listener: IosAudioPacketListener) =
        boundary("IosGlassesSession.removeAudioMonitorListenerNsData", Unit) { core.removeAudioMonitorListener(monitorWrappers.remove(listener)) }

    /** Compass events are delivered on the queue of the thread that adds the listener (main for TypeScript). */
    fun addCompassListener(listener: FaceclawCompassListener?) = boundary("IosGlassesSession.addCompassListener", Unit) { core.addCompassListener(listener) }

    fun removeCompassListener(listener: FaceclawCompassListener?) =
        boundary("IosGlassesSession.removeCompassListener", Unit) { core.removeCompassListener(listener) }

    fun sendShutdown(exitMode: Int): Boolean = boundary("IosGlassesSession.sendShutdown", false) { core.sendShutdown(exitMode) }

    fun sendCfwCleanup(): Boolean = boundary("IosGlassesSession.sendCfwCleanup", false) { core.sendCfwCleanup() }

    fun suspendEvenHubSession(): Boolean = boundary("IosGlassesSession.suspendEvenHubSession", false) { core.suspendEvenHubSession() }

    fun resumeEvenHubSession(): Boolean = boundary("IosGlassesSession.resumeEvenHubSession", false) { core.resumeEvenHubSession() }

    fun playBuzzerSequence(payload: NSData?) = boundary("IosGlassesSession.playBuzzerSequence", Unit) { core.playBuzzerSequence(payload?.byteArray()) }

    // ----- surfaces -------------------------------------------------------------------
    // The compositor rejects unknown surfaces and bad geometry; these return that error (null on
    // success) for the TypeScript bridge to throw, so its callers' catch paths still run.

    /** Set the compositor's output frame size. Call before configuring surfaces. */
    fun configureCompositorScreen(width: Int, height: Int): String? =
        boundaryError("IosGlassesSession.configureCompositorScreen") { core.configureCompositorScreen(width, height) }

    fun setSurfaceVisible(id: String, visible: Boolean): String? =
        boundaryError("IosGlassesSession.setSurfaceVisible") { core.setSurfaceVisible(id, visible) }

    fun setSurfaceDepth(id: String, depth: Int): String? = boundaryError("IosGlassesSession.setSurfaceDepth") { core.setSurfaceDepth(id, depth) }

    fun setScreenBlanked(blanked: Boolean): String? = boundaryError("IosGlassesSession.setScreenBlanked") { core.setScreenBlanked(blanked) }

    fun configureSurface(id: String, x: Int, y: Int, width: Int, height: Int, zOrder: Int, transparency: Int): String? =
        boundaryError("IosGlassesSession.configureSurface") { core.configureSurface(id, x, y, width, height, zOrder, transparency) }

    fun removeSurface(id: String): String? = boundaryError("IosGlassesSession.removeSurface") { core.removeSurface(id) }

    fun submitShellScene(bytes: NSData, paintMs: Int, frameId: Int): String? =
        boundaryError("IosGlassesSession.submitShellScene") { core.submitShellScene(IosByteReader(bytes), paintMs, frameId) }

    fun setUnderlayDim(belowZOrder: Int, factor256: Int): String? =
        boundaryError("IosGlassesSession.setUnderlayDim") { core.setUnderlayDim(belowZOrder, factor256) }

    fun submitSurfaceFrame(
        pixels8bpp: NSData,
        surfaceId: String,
        rectX: Int,
        rectY: Int,
        rectWidth: Int,
        rectHeight: Int,
        contentFingerprint: String?,
        paintMs: Int,
        frameId: Int,
        glyphs: NSData?,
    ): String? = boundaryError("IosGlassesSession.submitSurfaceFrame") {
        core.submitSurfaceFrame(
            IosByteReader(pixels8bpp), surfaceId, rectX, rectY, rectWidth, rectHeight, contentFingerprint, paintMs, frameId,
            glyphs?.let { IosByteReader(it) },
        )
    }

    /** The current composited screen (gray, 8bpp) or null before any surface was configured. */
    fun previewComposite(): IosTextureFrame? = boundary("IosGlassesSession.previewComposite", null) {
        core.previewComposite()?.let { IosTextureFrame(it) }
    }

    /** Called on the main queue after each step of an animation the preview is replaying (see SurfaceCompositor). */
    fun setPreviewAnimationListener(listener: (() -> Unit)?) =
        boundary("IosGlassesSession.setPreviewAnimationListener", Unit) { core.setPreviewAnimationListener(listener) }

    fun compositeWidth(): Int = boundary("IosGlassesSession.compositeWidth", 0) { core.previewComposite()?.width ?: 0 }

    fun compositeHeight(): Int = boundary("IosGlassesSession.compositeHeight", 0) { core.previewComposite()?.height ?: 0 }

    /** The current composite as a 4-bit grayscale PNG, or null. */
    fun screenshotPng(): NSData? = boundary("IosGlassesSession.screenshotPng", null) {
        val composite = core.previewComposite() ?: return@boundary null
        SharedScreenshots.encode4BitGrayPng(composite.gray, composite.width, composite.height).data()
    }

    /** Frame-timings export text (see FrameTimingsCore), for the phone-side debug page. */
    fun frameTimingsExport(): String = boundary("IosGlassesSession.frameTimingsExport", "") { frameTimings.buildExport() }

    internal fun coreForTests(): GlassesSessionCore = core

    private class NsDataAudioListener(private val delegate: IosAudioPacketListener) : FaceclawAudioPacketListener {
        override fun onAudioPacket(data: ByteArray?, arm: String?, arrivalMs: Long) {
            val packet = (data ?: ByteArray(0)).data()
            val label = arm ?: ""
            dispatch_async(dispatch_get_main_queue()) { delegate.onAudioPacket(packet, label, arrivalMs) }
        }
    }

    private class MainQueueAudioListener(private val delegate: FaceclawAudioPacketListener) : FaceclawAudioPacketListener {
        override fun onAudioPacket(data: ByteArray?, arm: String?, arrivalMs: Long) {
            dispatch_async(dispatch_get_main_queue()) { delegate.onAudioPacket(data, arm, arrivalMs) }
        }
    }
}
