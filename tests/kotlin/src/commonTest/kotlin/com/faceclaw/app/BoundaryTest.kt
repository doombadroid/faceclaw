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
}
