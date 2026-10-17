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
 * Runs an entry point that JavaScript or an ObjC shim calls ([name] is `Class.fun`): an iOS facade, or a
 * shared class they call directly. Kotlin/Native ends the process when an exception without @Throws
 * reaches Objective-C, before any JS catch runs, and @Throws would rename the selectors JS calls; so it
 * is logged, reported ([CaughtErrors]) and [fallback] returned. tests/kotlin-boundary.test.cjs checks
 * every such fun goes through here.
 */
internal inline fun <T> boundary(name: String, fallback: T, block: () -> T): T =
    try {
        block()
    } catch (t: Throwable) {
        PlatformLog.e("FaceclawKit", "$name failed", t)
        CaughtErrors.report(name, t)
        fallback
    }

/** [boundary] for a call whose JS caller has a failure path: null, or the error for JS to throw. */
internal inline fun boundaryError(name: String, block: () -> Unit): String? =
    try {
        block()
        null
    } catch (t: Throwable) {
        PlatformLog.e("FaceclawKit", "$name failed", t)
        CaughtErrors.report(name, t)
        "$name: ${t.message ?: t}"
    }

/**
 * Where a caught error goes so it is never a silent failure (a log line alone is invisible on iOS):
 * on iOS an error report the owner sees (IosErrorReports). commonMain cannot call iosMain, hence the sink.
 */
internal object CaughtErrors {
    var sink: ((source: String, error: Throwable) -> Unit)? = platformCaughtErrorSink

    /** Never throws: it is called from inside catch blocks. */
    fun report(source: String, error: Throwable) {
        try {
            sink?.invoke(source, error)
        } catch (t: Throwable) {
            // Not back into the sink: the reporter failing must not report itself in a loop.
            runCatching { PlatformLog.e("FaceclawKit", "could not report an error from $source", t) }
        }
    }
}

/**
 * IosErrorReports' storm filter, keyed by source and message: the first occurrence is forwarded
 * with its stack, later ones only at counts 2, 4, 8... (the JS reports' write cadence) carrying the
 * occurrences since the last forward, so a failure every frame costs a counter bump. Not
 * thread-safe; the caller locks.
 */
internal class ErrorRepeats(private val maxKeys: Int) {
    private class Seen(val stack: String, var count: Int)

    // Insertion order is recency: a hit is removed and put back last, the first key is the oldest.
    private val seen = LinkedHashMap<String, Seen>()

    /** Occurrences to forward now and the first occurrence's stack, or null to only count it. */
    fun next(key: String, stack: () -> String): Pair<Int, String>? {
        val entry = seen.remove(key)?.also { it.count++ } ?: Seen(stack(), 1)
        seen[key] = entry
        if (seen.size > maxKeys) seen.remove(seen.keys.first())
        val count = entry.count
        return when {
            count == 1 -> 1 to entry.stack
            count and (count - 1) == 0 -> count / 2 to entry.stack
            else -> null
        }
    }

    fun clear() = seen.clear()
}

/** iOS: IosErrorReports::record. Android: none yet (logcat is visible there). */
internal expect val platformCaughtErrorSink: ((source: String, error: Throwable) -> Unit)?
