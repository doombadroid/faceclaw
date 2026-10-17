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
}
