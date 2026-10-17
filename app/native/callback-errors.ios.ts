import { reportError } from './error-reports'

/**
 * A JS error native code would otherwise have swallowed: an error report (durable, with a notice
 * the owner sees), which also reaches FaceclawLog (os_log) for idevicesyslog.
 */
export function logJsError(where: string, error: unknown): void {
  reportError(where, error)
}

/**
 * Runs app code that native code called (a Kotlin/ObjC listener, a timer fan-out). A JS error
 * unwinding into native code ends the app on runtime 9.0, and Kotlin's catch(Throwable) cannot catch
 * the NSException it becomes, so it is reported here and the callback returns undefined.
 */
export function guardCallback<R>(where: string, run: () => R): R | undefined {
  try {
    return run()
  } catch (error) {
    logJsError(where, error)
    return undefined
  }
}
