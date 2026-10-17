/** Bulk binary bridge; slices are normalized without per-byte native calls. */
export function toData(bytes: Uint8Array): NSData {
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer : bytes.slice().buffer
  return NSData.dataWithBytesLength(interop.handleof(buffer), bytes.byteLength)
}
export function fromData(data: NSData): Uint8Array {
  return new Uint8Array(interop.bufferFromData(data)).slice()
}
/** Per-byte; fine for small records, use NSData for audio. */
export function fromKotlinBytes(bytes: any): Uint8Array {
  const out = new Uint8Array(Number(bytes?.size ?? 0))
  for (let i = 0; i < out.length; i++) out[i] = bytes.getIndex(i)
  return out
}
export function nativeArray<T, R>(items: NSArray<T>, convert: (item: T) => R): R[] {
  return Array.from({ length: items.count }, (_, i) => convert(items.objectAtIndex(i)))
}
/** Kotlin compositor calls return their error instead of throwing it (a throw into ObjC ends the app). */
export function throwIfError(error: string | null): void {
  if (error) throw new Error(String(error))
}
