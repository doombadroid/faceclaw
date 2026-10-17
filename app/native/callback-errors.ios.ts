declare const FaceclawLog: { log(message: string): void }

/** Release builds drop console output; FaceclawLog (os_log) is what idevicesyslog reads. */
export function logJsError(where: string, error: unknown): void {
  const line = `JS error in ${where}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
  console.error(line)
  if (typeof FaceclawLog !== 'undefined') FaceclawLog.log(line)
}

/**
 * Runs app code that native code called (a Kotlin/ObjC listener, a timer fan-out). A JS error
 * unwinding into native code ends the app on runtime 9.0, and Kotlin's catch(Throwable) cannot catch
 * the NSException it becomes, so it is logged here and the callback returns undefined.
 */
export function guardCallback<R>(where: string, run: () => R): R | undefined {
  try {
    return run()
  } catch (error) {
    logJsError(where, error)
    return undefined
  }
}
