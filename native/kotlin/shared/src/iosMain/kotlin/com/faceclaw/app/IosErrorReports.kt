package com.faceclaw.app

import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue

/** Implemented in app/native/kotlin-error-reports.ios.ts, which hands each to the JS error reports. */
interface IosErrorReportListener {
    fun onCaughtError(source: String, message: String, stack: String)
}

/**
 * Errors the iOS facades caught instead of crashing, handed to JS so each leaves a report
 * the owner sees. Buffer and listener are touched on the main queue only, so no lock.
 */
object IosErrorReports {
    private const val MAX_PENDING = 50
    private val pending = ArrayDeque<Triple<String, String, String>>()
    private var overflowLogged = false

    /** Set from JS on the main thread; reports caught before then are delivered on registration. */
    var listener: IosErrorReportListener? = null
        set(value) {
            field = value
            while (value != null && pending.isNotEmpty()) deliver(value, pending.removeFirst())
        }

    /** Never throws: it is called from inside catch blocks. */
    fun record(source: String, error: Throwable) {
        try {
            val report = Triple(source, error.toString(), error.stackTraceToString())
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

    private fun deliver(target: IosErrorReportListener, report: Triple<String, String, String>) {
        try {
            target.onCaughtError(report.first, report.second, report.third)
        } catch (t: Throwable) {
            // Inside a main-queue block: an escaping throw would end the app.
            runCatching { PlatformLog.e(TAG, "error report listener failed", t) }
        }
    }

    private const val TAG = "FaceclawErrorReports"
}
