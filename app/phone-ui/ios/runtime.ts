import { Application, Dialogs, type ImageSource } from '@nativescript/core'
import { IosPreviewController, type SessionState } from '../../g2/ios-preview-controller'
import type { KeyboardInputSession } from '../../ui/shell/keyboard-input'
import type { PhoneUiButton } from '../../apps/evenhub/manager'
import { isPreviewOnlyMode } from '../onboarding-state'
import { isAutoReconnectSuppressed, suppressAutoReconnect } from '../../g2/reconnect-policy'
import { loadDeviceAddresses, loadPairedGlassesIdentity } from '../../g2/device-addresses'
import { deviceAddressError } from '../../g2/ios-peripheral-identity'
import { APP_NAME } from '../../branding'
import { flashesStarted } from '../../native/firmware-flasher.ios'

export type RuntimeEvents = {
  frame: { image: ImageSource; focus: string }
  error: string
  connection: SessionState
  keyboardSession: KeyboardInputSession | null
  evenHubButton: PhoneUiButton | null
  // Pages under a detour stay loaded (UIKit counts them as presenting), and saved
  // devices or firmware can change inside one.
  detour: boolean
}
type Listener<K extends keyof RuntimeEvents> = (value: RuntimeEvents[K]) => void

/**
 * The process's one IosPreviewController, at app scope. TabView unloads hidden
 * tabs, so pages only subscribe; the controller follows app foreground state.
 */
export class IosRuntime {
  readonly controller: IosPreviewController
  // Latest values, so a page that mounts later renders at once.
  frame: RuntimeEvents['frame'] | null = null
  connection: SessionState | null = null
  keyboardSession: KeyboardInputSession | null = null
  evenHubButton: PhoneUiButton | null = null
  private readonly listeners = new Map<keyof RuntimeEvents, Set<Listener<any>>>()
  private started = false
  /** A device/firmware detour is presented over the shell. */
  inDetour = false
  /** glassesMark() when the open detour started. */
  private beforeDetour: string | null = null

  constructor() {
    this.controller = new IosPreviewController(
      (image, focus) => this.emit('frame', this.frame = { image, focus }),
      message => {
        this.emit('error', message)
        void Dialogs.alert({ title: APP_NAME, message, okButtonText: 'OK' })
      },
      state => this.emit('connection', this.connection = state),
      session => this.emit('keyboardSession', this.keyboardSession = session),
      button => this.emit('evenHubButton', this.evenHubButton = button))
  }

  on<K extends keyof RuntimeEvents>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, set = new Set())
    set.add(listener)
    return () => { set.delete(listener) }
  }

  private emit<K extends keyof RuntimeEvents>(event: K, value: RuntimeEvents[K]): void {
    for (const listener of [...this.listeners.get(event) ?? []]) listener(value)
  }

  /** Once, when the shell first loads. */
  start(): void {
    if (this.started) return
    this.started = true
    Application.on(Application.suspendEvent, () => this.controller.pause())
    Application.on(Application.resumeEvent, () => { if (!this.inDetour) this.controller.resume() })
    this.controller.resume()
    this.autoConnect()
  }

  autoConnect(): void {
    if (!isPreviewOnlyMode() && !isAutoReconnectSuppressed() && !deviceAddressError(loadDeviceAddresses())) void this.controller.connect()
  }

  /** Device pages need the glasses to themselves and must not be redialled. */
  async withDisconnected(fn: () => void): Promise<void> {
    suppressAutoReconnect()
    await this.controller.disconnect()
    this.beforeDetour = this.glassesMark()
    fn()
  }

  /**
   * A device/firmware detour holds the controller paused, as leaving the old
   * main page did, then re-runs the auto-connect check on return.
   */
  setDetour(open: boolean): void {
    this.inDetour = open
    if (open) this.controller.pause()
    else {
      // Resume first: a paused controller does not report state, and the reset must reach pages.
      this.controller.resume()
      // A halted session's report says why it halted; keep it unless the detour could have
      // changed the glasses: a flash ran or a pairing completed (glassesMark), or a
      // config save or passed firmware check lifted the reconnect suppression.
      if (this.beforeDetour != null && (this.glassesMark() !== this.beforeDetour || !isAutoReconnectSuppressed()))
        this.controller.forgetSessionReport()
      this.beforeDetour = null
      this.autoConnect()
    }
    this.emit('detour', open)
  }

  private glassesMark(): string {
    // pairedAtMs: re-pairing the same glasses (the 'unpaired' halt's remedy) keeps their addresses.
    return `${flashesStarted()}\n${JSON.stringify(loadDeviceAddresses())}\n${loadPairedGlassesIdentity()?.pairedAtMs ?? 0}`
  }

  get connected(): boolean {
    return ['connected', 'connecting', 'retrying'].includes(this.controller.connectionState?.phase ?? '')
  }
}

let runtime: IosRuntime | null = null
export function getRuntime(): IosRuntime {
  return runtime ??= new IosRuntime()
}
