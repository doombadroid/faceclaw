import { parseFirmwareExtension, reportedFirmwareVersion, type FirmwareExtension } from '../../g2/firmware-compat'
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
    case 'none': return { extension, version, line: `Even firmware ${version}` }
    case 'legacy-faceclaw': return { extension, version, line: `Older Faceclaw firmware · base ${version}` }
    case 'other': return { extension, version, line: `Custom firmware · base ${version}` }
  }
}
