/**
 * Implements a FaceclawKit (Kotlin) listener protocol with plain JavaScript methods.
 * NativeScript maps the method names to the protocol's selectors by camel-casing the
 * selector parts (`onLog:` -> `onLogLine`, `onState:detail:` -> `onStateStateDetail`, ...).
 * Keep a reference to the returned object for as long as the Kotlin side may call it.
 *
 * Kotlin/Native appends "_" to the last selector part of one of two interface methods that
 * share a selector but not a signature (IosTranscriptListener.onTranscript(String, ...) vs
 * FaceclawVoiceControllerListener.onTranscript(String?, ...) -> `onTranscriptText:isFinal_:`),
 * and which twin gets it depends on compile order (build 37 crashed on a missed one). So every
 * method is also offered under its twin name; NativeScript registers only the name the protocol
 * declares and leaves the other a plain JS property.
 */
export function kotlinListener<T extends object>(protocol: unknown, methods: T): T {
  const NativeListener = (NSObject as any).extend(withSelectorTwins(methods), { protocols: [protocol] })
  return NativeListener.new() as T
}

/** methods plus, for each name, the same function under its K/N "_"-mangled (or unmangled) twin. */
export function withSelectorTwins<T extends object>(methods: T): T {
  const both: Record<string, unknown> = { ...(methods as Record<string, unknown>) }
  for (const [name, method] of Object.entries(methods)) {
    const twin = name.endsWith('_') ? name.slice(0, -1) : `${name}_`
    if (!(twin in both)) both[twin] = method
  }
  return both as T
}
