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
  const shareItem = new ActionItem()
  shareItem.icon = 'sys://square.and.arrow.up'; shareItem.text = 'Share screenshot'
  shareItem.ios.position = 'right'
  shareItem.on('tap', () => {
    if (!mirror.imageSource) return
    const share = UIActivityViewController.alloc().initWithActivityItemsApplicationActivities([mirror.imageSource.ios], null)
    if (share.popoverPresentationController) share.popoverPresentationController.sourceView = page.ios.view
    presentOnTop(share)
  })
  page.actionBar.actionItems.addItem(shareItem)
  const root = new GridLayout()
  page.content = root
  const body = new GridLayout()
  root.addChild(body)
  const mirror = new Image()
  mirror.stretch = 'fill'; mirror.backgroundColor = new Color('black')
  mirror.accessibilityIdentifier = 'glasses-preview'
  mirror.accessibilityLabel = 'Interactive glasses screen preview'
  mirror.horizontalAlignment = 'left'; mirror.verticalAlignment = 'middle'; body.addChild(mirror)
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
    const size = body.getActualSize()
    if (size.width <= 0 || size.height <= 0) return
    const landscape = root.getActualSize().width > root.getActualSize().height
    const key = `${size.width}:${size.height}:${landscape}`
    if (key === lastLayout) return
    lastLayout = key; cancelGestures()
    body.className = landscape ? 'landscape-layout' : ''
    root.className = landscape ? 'main-landscape' : ''
    body.rows = landscape ? '*' : 'auto,*'; body.columns = landscape ? '*,345' : '*'
    controls.padding = landscape ? 0 : 20
    GridLayout.setRow(controls, landscape ? 0 : 1); GridLayout.setColumn(controls, landscape ? 1 : 0)
    const width = landscape ? Math.max(0, Math.min(size.width - 345, size.height * 4 / 3)) : size.width
    mirror.width = width; mirror.height = width * 3 / 4
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
  let keyboardObserver: any = null
  let offSettings: (() => void) | null = null
  let offRuntime: (() => void)[] = []
  page.on('loaded', () => {
    if (!keyboardObserver) keyboardObserver = NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(
      UIKeyboardWillChangeFrameNotification, null, NSOperationQueue.mainQueue, notification => {
        const frame = notification.userInfo.objectForKey(UIKeyboardFrameEndUserInfoKey).CGRectValue
        const view = page.ios.view
        const local = view.convertRectFromView(frame, null)
        root.paddingBottom = Math.max(0, view.bounds.size.height - local.origin.y - view.safeAreaInsets.bottom)
      })
    Application.on(Application.suspendEvent, pause); Application.on(Application.resumeEvent, resume)
    offSettings?.(); offSettings = onAnySettingChanged(() => { model.refreshDisplayControls(); syncBandwidth() })
    for (const off of offRuntime) off()
    offRuntime = [runtime.on('frame', showFrame), runtime.on('keyboardSession', showKeyboard)]
    if (runtime.frame) showFrame(runtime.frame)
    showKeyboard(runtime.keyboardSession)
    model.refreshDisplayControls(); resume()
  })
  page.on('unloaded', () => {
    if (keyboardObserver) NSNotificationCenter.defaultCenter.removeObserver(keyboardObserver)
    keyboardObserver = null
    root.paddingBottom = 0
    pause(); offSettings?.(); offSettings = null
    for (const off of offRuntime) off()
    offRuntime = []
    Application.off(Application.suspendEvent, pause); Application.off(Application.resumeEvent, resume)
  })
  return page
}

export const createPage = createRemotePage
