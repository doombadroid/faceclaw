import { KeyboardInputViewModel } from '../keyboard-input-view-model'
import { ActionItem, Application, Builder, Color, GridLayout, Image, Label, Page, TextView, type PropertyChangeData, type TouchGestureEventData, type View } from '@nativescript/core'
import { RemoteControlsViewModel } from '../remote-controls-view-model'
import { PhoneGestureRecognizer } from '../phone-gestures'
import { BleBandwidthMeter } from '../ble-bandwidth-meter'
import { sampleBleTraffic } from '../../native/ble-traffic'
import { onAnySettingChanged, mirrorTouchSetting, showBleBandwidthSetting } from '../../ui/dashboard-settings'
import { getRuntime, type RuntimeEvents } from './runtime'
import { inheritBarTint } from './ui-kit'
import { presentOnTop } from './present'
import type { KeyboardInputSession } from '../../ui/shell/keyboard-input'

/** The controls column beside the mirror, and the most it needs: tab bar plus the 250pt ring pad. */
const CONTROLS_WIDTH = 345, CONTROLS_HEIGHT = 320
/** Side by side only leaves the mirror at least this wide; stacked, the controls keep about this much height. */
const MIN_MIRROR_WIDTH = 280, STACKED_CONTROLS_HEIGHT = 300

/**
 * Remote's layout for a `width` x `height` area (the page inside its safe area),
 * from its size alone: no orientation or idiom, so Split View panes and both
 * displays behave the same. `bodyHeight` is what the keyboard leaves of it.
 */
export function remoteLayout(width: number, height: number, bodyHeight = height): {
  sideBySide: boolean; mirrorWidth: number; controlsHeight: number | 'auto'
} {
  if (width > height && width >= CONTROLS_WIDTH + MIN_MIRROR_WIDTH) {
    return { sideBySide: true, mirrorWidth: Math.max(0, Math.min(width - CONTROLS_WIDTH, bodyHeight * 4 / 3)),
      controlsHeight: Math.max(0, Math.min(bodyHeight, CONTROLS_HEIGHT)) }
  }
  // The mirror never drops below half the height, even when that squeezes the controls.
  const mirrorHeight = Math.max(height - STACKED_CONTROLS_HEIGHT, height / 2)
  return { sideBySide: false, mirrorWidth: Math.max(0, Math.min(width, mirrorHeight * 4 / 3)), controlsHeight: 'auto' }
}

/** The old main page: mirror with touch input, shared remote controls, keyboard panel. */
export function createRemotePage(): Page {
  const runtime = getRuntime(), controller = runtime.controller
  const page = new Page()
  page.className = 'main-page'
  page.iosOverflowSafeAreaEnabled = false
  page.actionBar.title = 'Remote'
  // sys:// symbols must render as templates to take the bar's tint.
  page.actionBar.iosIconRenderingMode = 'alwaysTemplate'
  inheritBarTint(page)
  /** Share `items`; as a popover (regular width) it points at bar item `index`, 0 being the rightmost. sourceItem is iOS 16+. */
  const share = (items: unknown[], index: number) => {
    const sheet = UIActivityViewController.alloc().initWithActivityItemsApplicationActivities(items, null)
    const popover = sheet.popoverPresentationController, buttons = page.ios.navigationItem.rightBarButtonItems
    const anchor = buttons && buttons.count > index ? buttons.objectAtIndex(index) : null
    if (popover && anchor && popover.respondsToSelector('setSourceItem:')) popover.sourceItem = anchor
    else if (popover) popover.sourceView = page.ios.view
    presentOnTop(sheet)
  }
  // Added first, so it sits left of Share (NativeScript inserts each right item at index 0).
  const recordItem = new ActionItem()
  recordItem.ios.position = 'right'
  const syncRecordItem = () => {
    const recording = controller.screenRecording
    recordItem.icon = recording ? 'sys://stop.circle' : 'sys://record.circle'
    recordItem.text = recording ? 'Stop recording' : 'Record screen'
  }
  syncRecordItem()
  recordItem.on('tap', () => {
    if (!controller.screenRecording) { controller.startScreenRecording(); syncRecordItem(); return }
    const saved = controller.stopScreenRecording()
    syncRecordItem()
    if (saved) share([NSURL.fileURLWithPath(saved)], 1)
  })
  page.actionBar.actionItems.addItem(recordItem)
  const shareItem = new ActionItem()
  shareItem.icon = 'sys://square.and.arrow.up'; shareItem.text = 'Share screenshot'
  shareItem.ios.position = 'right'
  shareItem.on('tap', () => { if (mirror.imageSource) share([mirror.imageSource.ios], 0) })
  page.actionBar.actionItems.addItem(shareItem)
  const root = new GridLayout()
  page.content = root
  const body = new GridLayout()
  root.addChild(body)
  const mirror = new Image()
  mirror.stretch = 'fill'; mirror.backgroundColor = new Color('black')
  mirror.accessibilityIdentifier = 'glasses-preview'
  mirror.accessibilityLabel = 'Interactive glasses screen preview'
  mirror.horizontalAlignment = 'center'; mirror.verticalAlignment = 'middle'; body.addChild(mirror)
  // Load exactly the same XML and binding model as Android. Only input dispatch
  // and the surrounding platform navigation/runtime remain iOS-specific.
  const model = new RemoteControlsViewModel()
  const controls = new GridLayout()
  const remote = Builder.load('~/phone-ui/remote-controls')
  remote.bindingContext = model
  controls.addChild(remote); body.addChild(controls)
  const keyboardModel = new KeyboardInputViewModel()
  const keyboardPanel = Builder.load('~/phone-ui/keyboard-input-panel')
  keyboardPanel.bindingContext = keyboardModel
  root.addChild(keyboardPanel)
  let focusTimer: ReturnType<typeof setTimeout> | null = null
  const keyboardField = () => keyboardPanel.getViewById<TextView>('keyboardInputField')
  const showFrame = ({ image, focus }: RuntimeEvents['frame']) => {
    // Through src: popping Remote tears its Image down, which nulls the native image
    // of whatever imageSource it holds; the wrapper src makes keeps the runtime's cached frame intact.
    mirror.src = image; model.set('padFocusLine', focus)
  }
  const showKeyboard = (session: KeyboardInputSession | null) => {
    keyboardModel.setSession(session)
    controls.visibility = session ? 'collapse' : 'visible'
    if (focusTimer !== null) clearTimeout(focusTimer)
    focusTimer = null
    if (session) {
      focusTimer = setTimeout(() => { focusTimer = null; keyboardField()?.focus() }, 0)
    } else keyboardField()?.dismissSoftInput()
  }
  const watchInput = new PhoneGestureRecognizer(gesture => controller.gesture(gesture, 'watch'))
  const ringInput = new PhoneGestureRecognizer(gesture => controller.gesture(gesture, 'ring'))
  const mirrorInput = new PhoneGestureRecognizer((gesture, x, y) => {
    if (!mirrorTouchSetting.get()) return
    const size = mirror.getActualSize()
    if (size.width > 0 && size.height > 0) controller.gesture(gesture, 'mirror', x / size.width, y / size.height)
  })
  const touch = (recognizer: PhoneGestureRecognizer) => (event: TouchGestureEventData) => {
    if (!['down', 'move', 'up', 'cancel'].includes(event.action)) return
    recognizer.touch({ action: event.action as 'down' | 'move' | 'up' | 'cancel', x: event.getX(), y: event.getY(), pointers: event.getPointerCount() })
  }
  model.set('onPadTouch', touch(watchInput))
  model.set('onRingPadTouch', touch(ringInput))
  model.set('onSyntheticMicTap', () => controller.startVoiceInput())
  model.set('onKeyboardTap', () => { controller.typeIntoApp() })
  mirror.on('touch', touch(mirrorInput))
  const cancelGestures = () => { watchInput.cancel(); ringInput.cancel(); mirrorInput.cancel() }
  model.on('propertyChange', (args: PropertyChangeData) => {
    if (args.propertyName === 'watchTabVisibility') cancelGestures()
  })
  let controlsLayoutTimer: ReturnType<typeof setTimeout> | null = null
  model.set('onControlsContentLayoutChanged', (args: { object: View }) => {
    if (controlsLayoutTimer !== null) clearTimeout(controlsLayoutTimer)
    // Defer binding updates out of UIKit's layout pass.
    controlsLayoutTimer = setTimeout(() => {
      controlsLayoutTimer = null
      const { width, height } = args.object.getActualSize()
      model.set('watchFaceWidth', Math.min(345, Math.max(0, width)))
      model.set('watchFaceHeight', Math.min(230, Math.max(0, height - 2)))
      model.set('ringTouchpadHeight', Math.min(250, Math.max(0, height - 2)))
    }, 0)
  })
  const bandwidth = new Label()
  bandwidth.accessibilityIdentifier = 'ble-bandwidth-indicator'
  bandwidth.className = 'ble-bandwidth-indicator'; bandwidth.isUserInteractionEnabled = false
  bandwidth.horizontalAlignment = 'center'; bandwidth.verticalAlignment = 'bottom'
  bandwidth.visibility = 'collapse'
  root.addChild(bandwidth)
  const bandwidthMeter = new BleBandwidthMeter()
  let bandwidthTimer: ReturnType<typeof setInterval> | null = null
  let foreground = false
  function stopBandwidth(): void {
    if (bandwidthTimer !== null) clearInterval(bandwidthTimer)
    bandwidthTimer = null; bandwidthMeter.reset()
  }
  function syncBandwidth(): void {
    if (!foreground) { stopBandwidth(); return }
    const enabled = showBleBandwidthSetting.get()
    bandwidth.visibility = enabled ? 'visible' : 'collapse'
    if (!enabled) { stopBandwidth(); return }
    if (bandwidthTimer !== null) return
    const refresh = () => { bandwidth.text = bandwidthMeter.sample(sampleBleTraffic(), Date.now()) }
    refresh(); bandwidthTimer = setInterval(refresh, 1000)
  }
  let lastLayout = ''
  function layout(): void {
    // root is the keyboard-free area; the keyboard pads its bottom, shrinking body.
    const size = body.getActualSize(), area = root.getActualSize()
    if (size.width <= 0 || size.height <= 0) return
    const key = `${area.width}:${area.height}:${size.height}`
    if (key === lastLayout) return
    lastLayout = key; cancelGestures()
    const { sideBySide, mirrorWidth, controlsHeight } = remoteLayout(area.width, area.height, size.height)
    body.className = sideBySide ? 'landscape-layout' : ''
    root.className = sideBySide ? 'main-landscape' : ''
    body.rows = sideBySide ? '*' : 'auto,*'; body.columns = sideBySide ? `*,${CONTROLS_WIDTH}` : '*'
    controls.padding = sideBySide ? 0 : 20
    // Side by side, the column centres vertically instead of hanging from the top.
    controls.height = controlsHeight; controls.verticalAlignment = sideBySide ? 'middle' : 'stretch'
    GridLayout.setRow(controls, sideBySide ? 0 : 1); GridLayout.setColumn(controls, sideBySide ? 1 : 0)
    mirror.width = mirrorWidth; mirror.height = mirrorWidth * 3 / 4
  }
  // iOS emits layoutChanged inside its layout pass. Defer mutations so
  // NativeScript does not clear our new layout request at the end of that pass.
  let layoutTimer: ReturnType<typeof setTimeout> | null = null
  body.on('layoutChanged', () => {
    if (layoutTimer !== null) return
    layoutTimer = setTimeout(() => { layoutTimer = null; layout() }, 0)
  })
  // Page-local work only: the runtime owns the controller's pause/resume.
  const pause = () => {
    foreground = false; stopBandwidth()
    if (layoutTimer !== null) clearTimeout(layoutTimer)
    layoutTimer = null
    if (controlsLayoutTimer !== null) clearTimeout(controlsLayoutTimer)
    controlsLayoutTimer = null
    if (focusTimer !== null) clearTimeout(focusTimer)
    focusTimer = null
    keyboardField()?.dismissSoftInput()
    cancelGestures()
  }
  const resume = () => { foreground = true; syncBandwidth() }
  let keyboardObservers: NSObjectProtocol[] = []
  const observe = (name: string, fn: (notification: NSNotification) => void) =>
    NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(name, null, NSOperationQueue.mainQueue, fn)
  /**
   * How far a keyboard ending at `frame` (screen coordinates) covers the page's
   * bottom edge, above the safe area. A floating keyboard, or one that misses
   * this window (a Split View pane), covers nothing.
   */
  const keyboardInset = (frame: CGRect): number => {
    const view = page.ios.view, screen = view.window?.windowScene?.screen
    if (!screen) return 0
    const bounds = view.bounds, overlap = CGRectIntersection(view.convertRectFromCoordinateSpace(frame, screen.coordinateSpace), bounds)
    if (CGRectIsNull(overlap) || CGRectGetMaxY(overlap) < CGRectGetMaxY(bounds) - 1) return 0
    return Math.max(0, CGRectGetMaxY(bounds) - CGRectGetMinY(overlap) - view.safeAreaInsets.bottom)
  }
  let offSettings: (() => void) | null = null
  let offRuntime: (() => void)[] = []
  let releaseMirror: (() => void) | null = null
  page.on('loaded', () => {
    releaseMirror ??= runtime.acquireMirror()
    if (!keyboardObservers.length) keyboardObservers = [
      observe(UIKeyboardWillChangeFrameNotification, notification => {
        root.paddingBottom = keyboardInset(notification.userInfo.objectForKey(UIKeyboardFrameEndUserInfoKey).CGRectValue)
      }),
      observe(UIKeyboardWillHideNotification, () => { root.paddingBottom = 0 }),
    ]
    Application.on(Application.suspendEvent, pause); Application.on(Application.resumeEvent, resume)
    offSettings?.(); offSettings = onAnySettingChanged(() => { model.refreshDisplayControls(); syncBandwidth() })
    for (const off of offRuntime) off()
    offRuntime = [runtime.on('frame', showFrame), runtime.on('keyboardSession', showKeyboard), runtime.on('connection', syncRecordItem)]
    syncRecordItem()
    if (runtime.frame) showFrame(runtime.frame)
    showKeyboard(runtime.keyboardSession)
    model.refreshDisplayControls(); resume()
  })
  page.on('unloaded', () => {
    for (const observer of keyboardObservers) NSNotificationCenter.defaultCenter.removeObserver(observer)
    keyboardObservers = []
    root.paddingBottom = 0
    pause(); offSettings?.(); offSettings = null
    for (const off of offRuntime) off()
    offRuntime = []
    releaseMirror?.(); releaseMirror = null
    Application.off(Application.suspendEvent, pause); Application.off(Application.resumeEvent, resume)
  })
  return page
}

export const createPage = createRemotePage
