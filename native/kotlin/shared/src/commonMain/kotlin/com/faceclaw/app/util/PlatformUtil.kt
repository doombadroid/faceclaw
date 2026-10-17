package com.faceclaw.app

/** Incremental SHA-256; [digest] finishes the hash. */
expect class Sha256Digest() {
    fun update(bytes: ByteArray, offset: Int, length: Int)

    fun digest(): ByteArray
}

fun Sha256Digest.update(bytes: ByteArray) = update(bytes, 0, bytes.size)

fun sha256(bytes: ByteArray): ByteArray = Sha256Digest().also { it.update(bytes) }.digest()

fun sha256Hex(bytes: ByteArray): String = BinaryEncoding.bytesToHex(sha256(bytes))

/** Wall-clock milliseconds since the Unix epoch (may jump; use ProtocolPlatform for intervals). */
expect fun currentTimeMillis(): Long

/** Formats [epochMs] in local time with a Unicode/SimpleDateFormat-style [pattern] (e.g. "yyyyMMdd-HHmmss-SSS"). */
expect fun formatLocalTime(epochMs: Long, pattern: String): String

expect object PlatformLog {
    fun i(tag: String, message: String)

    fun w(tag: String, message: String)

    fun e(tag: String, message: String, error: Throwable?)
}

fun PlatformLog.e(tag: String, message: String) = e(tag, message, null)

/**
 * Runs an iOS facade entry point that JavaScript or an ObjC shim calls ([name] is `Class.fun`).
 * Kotlin/Native ends the process when an exception without @Throws reaches Objective-C, before any
 * JS catch runs, and @Throws would rename the selectors JS calls; so it is logged and [fallback]
 * returned. tests/kotlin-boundary.test.cjs checks every facade fun goes through here.
 */
internal inline fun <T> boundary(name: String, fallback: T, block: () -> T): T =
    try {
        block()
    } catch (t: Throwable) {
        PlatformLog.e("FaceclawKit", "$name failed", t)
        fallback
    }

/** [boundary] for a call whose JS caller has a failure path: null, or the error for JS to throw. */
internal inline fun boundaryError(name: String, block: () -> Unit): String? =
    try {
        block()
        null
    } catch (t: Throwable) {
        PlatformLog.e("FaceclawKit", "$name failed", t)
        "$name: ${t.message ?: t}"
    }
