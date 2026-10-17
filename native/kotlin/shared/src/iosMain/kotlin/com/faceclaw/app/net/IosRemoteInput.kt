package com.faceclaw.app

import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue

/** Runs [action] on the main queue, where NativeScript's JavaScript lives. */
internal fun dispatchToMain(action: () -> Unit) {
    dispatch_async(dispatch_get_main_queue()) { action() }
}

/**
 * iOS facade over the shared [RemoteInputSession] for the TypeScript side
 * (app/native/remote-input.ios.ts): POSIX sockets, Security-framework randomness and
 * main-queue request notifications. Mirrors the Android FaceclawRemoteInput API.
 */
class IosRemoteInput internal constructor(
    dispatch: (() -> Unit) -> Unit,
    requestTimeoutMs: Long,
) {
    constructor() : this(::dispatchToMain, RemoteInputSession.REQUEST_TIMEOUT_MS)

    private val session = RemoteInputSession(
        port = IosLocalServerPort,
        random = IosSecureRandom,
        dispatch = dispatch,
        platform = IosProtocolPlatform,
        requestTimeoutMs = requestTimeoutMs,
    )

    /** Called (on the main queue) whenever a request is waiting in [nextRequest]. */
    fun setRequestListener(listener: (() -> Unit)?) = boundary("IosRemoteInput.setRequestListener", Unit) { session.setRequestListener(listener) }

    fun start(port: Int): String = startAddress(port, "127.0.0.1")

    /** Returns "" on success or a user-facing error. */
    fun startAddress(port: Int, address: String): String =
        boundary("IosRemoteInput.startAddress", "Remote input could not start.") { session.start(port, address) }

    fun stop() = boundary("IosRemoteInput.stop", Unit) { session.stop() }

    fun nextRequest(): String? = boundary("IosRemoteInput.nextRequest", null) { session.nextRequest() }

    fun complete(id: Long, value: String?) = boundary("IosRemoteInput.complete", Unit) { session.complete(id, value) }

    /** "" when no secure randomness: the token store rejects anything but 64 hex digits. */
    fun randomSecret(): String = boundary("IosRemoteInput.randomSecret", "") { session.randomSecret() }

    fun tokenDigest(value: String): String = boundary("IosRemoteInput.tokenDigest", "") { RemoteInputSession.tokenHash(value) }

    /** JSON array of {name, address, pointToPoint} for the reachable local interfaces. */
    fun interfaces(): String = boundary("IosRemoteInput.interfaces", "[]") { RemoteInputSession.interfacesJson(iosInterfaceAddresses()) }

    companion object {
        val shared: IosRemoteInput by lazy { IosRemoteInput() }
    }
}
