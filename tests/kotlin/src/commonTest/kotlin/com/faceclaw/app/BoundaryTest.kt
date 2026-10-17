package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BoundaryTest {
    @Test fun boundaryReturnsTheResultOrTheFallback() {
        assertEquals(3, boundary("Test.value", -1) { 3 })
        assertEquals(-1, boundary("Test.value", -1) { throw IllegalStateException("boom") })
        assertEquals(-1, boundary<Int>("Test.value", -1) { error("boom") })
    }

    @Test fun boundaryErrorGivesTheCallerTheFailure() {
        assertNull(boundaryError("Test.call") {})
        assertEquals("Test.call: unknown surface x", boundaryError("Test.call") { throw IllegalArgumentException("unknown surface x") })
        // No message: the exception's name is still something the caller can show.
        assertTrue(boundaryError("Test.call") { throw IllegalStateException() }!!.contains("IllegalStateException"))
    }

    @Test fun everyCaughtFailureReachesTheSink() {
        val seen = mutableListOf<Pair<String, String?>>()
        val before = CaughtErrors.sink
        CaughtErrors.sink = { source, error -> seen += source to error.message }
        try {
            boundary("Test.value", -1) { throw IllegalStateException("boom") }
            boundaryError("Test.call") { throw IllegalArgumentException("bad") }
            boundary("Test.value", -1) { 3 }
            assertNull(boundaryError("Test.call") {})
            assertEquals<List<Pair<String, String?>>>(listOf("Test.value" to "boom", "Test.call" to "bad"), seen)
            // A sink that throws must not escape the catch it is called from.
            CaughtErrors.sink = { _, _ -> error("sink down") }
            assertEquals(-1, boundary<Int>("Test.value", -1) { throw IllegalStateException("boom") })
            assertEquals("Test.call: bad", boundaryError("Test.call") { throw IllegalArgumentException("bad") })
        } finally {
            CaughtErrors.sink = before
        }
    }

    /** IosErrorReports.record's storm filter: a per-frame failure must cost a counter bump, not a stack trace. */
    @Test fun repeatsAreForwardedAtCountsTwoFourEightCarryingWhatTheySkipped() {
        val repeats = ErrorRepeats(maxKeys = 64)
        var stacks = 0
        val forwarded = (1..20).map { repeats.next("frame\nsurface gone") { stacks++; "stack" } }
        assertEquals(1, stacks, "the stack is built for the first occurrence only")
        assertEquals(listOf(1 to "stack", 1 to "stack", 2 to "stack", 4 to "stack", 8 to "stack"), forwarded.filterNotNull())
        assertEquals(listOf(1, 2, 4, 8, 16), forwarded.indices.filter { forwarded[it] != null }.map { it + 1 })
        // The occurrences forwarded add up to the true count at each forward: JS counts 1, 2, 4, 8, 16.
        assertEquals(16, forwarded.filterNotNull().sumOf { it.first })
        assertEquals(1 to "other", repeats.next("other\nboom") { "other" })
    }

    @Test fun theRepeatTableIsBoundedAndForgetsTheLeastRecent() {
        val repeats = ErrorRepeats(maxKeys = 2)
        repeats.next("a") { "a" }
        repeats.next("b") { "b" }
        assertEquals(1 to "a", repeats.next("a") { "a2" }) // the 2nd occurrence; a is now the most recent
        repeats.next("c") { "c" } // evicts b
        assertEquals(1 to "b2", repeats.next("b") { "b2" }, "b was forgotten, so it is new again")
        assertEquals(1 to "b2", repeats.next("b") { "b3" }, "the 2nd occurrence carries the first stack")
        assertNull(repeats.next("b") { "b4" }, "the 3rd is only counted")
    }

    /** Clearing the reports (Settings) forgets the counts: the next occurrence is forwarded at once. */
    @Test fun clearedRepeatsAreNewAgain() {
        val repeats = ErrorRepeats(maxKeys = 64)
        repeat(5) { repeats.next("a") { "a" } }
        repeats.clear()
        assertEquals(1 to "a2", repeats.next("a") { "a2" })
        assertEquals(1 to "a2", repeats.next("a") { "a3" })
    }
}
