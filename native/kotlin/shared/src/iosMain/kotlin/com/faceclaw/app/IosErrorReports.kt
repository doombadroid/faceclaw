package com.faceclaw.app

import platform.Foundation.NSLock
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue

/** Implemented in app/native/kotlin-error-reports.ios.ts, which hands each to the JS error reports. */
interface IosErrorReportListener {
    /** [occurrences]: how many times it happened since the last call for this source and message. */
    fun onCaughtError(source: String, message: String, stack: String, occurrences: Int)
}

/**
 * Errors the iOS facades caught instead of crashing, handed to JS so each leaves a report
 * the owner sees. Buffer and listener are touched on the main queue only, so no lock; the
 * repeat filter runs on the caller's thread, under [repeatsLock].
 */
object IosErrorReports {
    private const val MAX_PENDING = 50
    private const val MAX_KEYS = 64

    private class Report(val source: String, val message: String, val stack: String, val occurrences: Int)

    private val pending = ArrayDeque<Report>()
    private var overflowLogged = false
    private val repeats = ErrorRepeats(MAX_KEYS)
    private val repeatsLock = NSLock()

    /** Set from JS on the main thread; reports caught before then are delivered on registration. */
    var listener: IosErrorReportListener? = null
        set(value) {
            field = value
            while (value != null && pending.isNotEmpty()) deliver(value, pending.removeFirst())
        }

    /** Never throws: it is called from inside catch blocks. */
    fun record(source: String, error: Throwable) {
        try {
            val message = error.toString()
            // A repeat skipped here costs one lock and a map hit: no stack trace, no dispatch.
            repeatsLock.lock()
            val forward = try {
                repeats.next("$source\n$message") { error.stackTraceToString() }
            } finally {
                repeatsLock.unlock()
            }
            if (forward == null) return
            val report = Report(source, message, forward.second, forward.first)
            dispatch_async(dispatch_get_main_queue()) {
                val target = listener
                if (target != null) deliver(target, report)
                else {
                    // ponytail: drops the oldest past 50; only a listener that never registers fills it.
                    if (pending.size >= MAX_PENDING) {
                        pending.removeFirst()
                        // Once: the system log is then the only trace of these reports.
                        if (!overflowLogged) runCatching { PlatformLog.e(TAG, "no error report listener; dropping the oldest of $MAX_PENDING buffered reports", null) }
                        overflowLogged = true
                    }
                    pending.addLast(report)
                }
            }
        } catch (t: Throwable) {
            runCatching { PlatformLog.e(TAG, "could not record an error from $source", t) }
        }
    }

    /**
     * The owner cleared the reports (Settings): forget the repeat counts, so an error that keeps
     * happening is forwarded at its next occurrence instead of at its next power of two. Never throws.
     */
    fun forgetRepeats() {
        try {
            repeatsLock.lock()
            try { repeats.clear() } finally { repeatsLock.unlock() }
        } catch (t: Throwable) {
            runCatching { PlatformLog.e(TAG, "could not reset the repeat filter", t) }
        }
    }

    private fun deliver(target: IosErrorReportListener, report: Report) {
        try {
            target.onCaughtError(report.source, report.message, report.stack, report.occurrences)
        } catch (t: Throwable) {
            // Inside a main-queue block: an escaping throw would end the app.
            runCatching { PlatformLog.e(TAG, "error report listener failed", t) }
        }
    }

    private const val TAG = "FaceclawErrorReports"
}
