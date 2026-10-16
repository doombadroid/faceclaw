import { parseFirmwareExtension, reportedFirmwareVersion, REQUIRED_FACECLAW_FIRMWARE_VERSION, type FirmwareExtension } from '../../g2/firmware-compat'
import { CFW_PATCH_SET, type FirmwarePatchSet } from '../../g2/firmware/cfw-patches'
import type { SessionState } from '../../g2/ios-preview-controller'

export type FirmwareSummary = {
  /** null until the glasses have reported their versions in this session. */
  extension: FirmwareExtension | null
  /** Highest dotted stock version either arm reported, or ''. */
  version: string
  /** One line for a device card or cell. */
  line: string
}

/**
 * What the glasses said they are running. Versions and the extension slot are
 * only known while a session has reported them, so a disconnected or fresh
 * session says so instead of guessing.
 */
export function firmwareSummary(state: SessionState | null): FirmwareSummary {
  const version = state ? reportedFirmwareVersion({ leftVersion: state.leftVersion, rightVersion: state.rightVersion, extension: state.capabilities }) : ''
  if (!state || !version) return { extension: null, version: '', line: 'Firmware not reported yet' }
  const extension = parseFirmwareExtension(state.capabilities)
  switch (extension.kind) {
    case 'faceclaw': return { extension, version, line: `Faceclaw firmware r${extension.version} · base ${version}` }
    case 'none': return { extension, version, line: `Stock firmware ${version}` }
    case 'legacy-faceclaw': return { extension, version, line: `Older Faceclaw firmware · base ${version}` }
    case 'other': return { extension, version, line: `Third-party firmware · base ${version}` }
  }
}

/**
 * The session's report while it still describes the glasses: a live session, or
 * one the firmware check halted (its versions are why it halted, and the warning
 * pages point here). disconnect() keeps the last versions and battery, which go
 * stale once the user disconnects, a flash runs or another phone connects; every
 * page reads firmware and warnings through this, phase and status raw. Battery
 * is read only while connected: a halted session's link is closed, so it froze.
 */
export function reportedState(state: SessionState | null): SessionState | null {
  return state?.phase === 'connected' || (state?.phase === 'error' && !!state.firmwareWarning) ? state : null
}

/** 'unknown' until reported; 'newer' means installing the bundled revision would downgrade. */
export function updateStatus(extension: FirmwareExtension | null): 'unknown' | 'current' | 'newer' | 'available' {
  if (!extension) return 'unknown'
  if (extension.kind !== 'faceclaw' || extension.version < REQUIRED_FACECLAW_FIRMWARE_VERSION) return 'available'
  return extension.version === REQUIRED_FACECLAW_FIRMWARE_VERSION ? 'current' : 'newer'
}

/** Short enough for a value cell, which is measured unwrapped. */
export function firmwareKindLabel(extension: FirmwareExtension): string {
  switch (extension.kind) {
    case 'faceclaw': return `Faceclaw r${extension.version}`
    case 'none': return 'Stock firmware'
    case 'legacy-faceclaw': return 'Older Faceclaw'
    case 'other': return 'Third-party'
  }
}

/** Which firmware family the glasses run; null when unreported or from elsewhere. */
export function firmwareChannel(extension: FirmwareExtension | null): 'faceclaw' | 'even' | null {
  switch (extension?.kind) {
    case 'faceclaw': case 'legacy-faceclaw': return 'faceclaw'
    case 'none': return 'even'
    default: return null
  }
}

export function firmwareAlertTitle(extension: FirmwareExtension | null): string {
  switch (extension?.kind) {
    case 'none': return 'Stock Firmware Detected'
    case 'other': return 'Unrecognized Firmware'
    default: return 'Firmware Update Needed'
  }
}

/** Size of the patched image: the stock base ends where the append op starts. */
export function firmwareImageBytes(patchSet: FirmwarePatchSet = CFW_PATCH_SET): number {
  const append = patchSet.patches.find(op => op.old === '')
  if (!append) throw new Error('patch set has no append op')
  return append.offset + append.new.length / 2
}

/** Decimal megabytes, as iOS shows file sizes. */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`
}
