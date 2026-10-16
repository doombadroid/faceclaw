import { Application, Frame, Page, type NavigationEntry } from '@nativescript/core'
import { getRuntime } from './runtime'
import { createShell, hasShell } from './shell'

/**
 * The legacy 'phone-ui/main-page': shared view models still fall back to that
 * name, and landing on it means "return to the shell".
 */
export const RETURN_PAGE = 'phone-ui/main-page'

let detour: Frame | null = null

/**
 * Pairing, firmware, flash, config and permissions run full screen over the
 * tab bar (no tab bar during a flash), and cannot be swiped away.
 */
export async function presentDetour(moduleName: string, context?: object, disconnect = true): Promise<void> {
  const runtime = getRuntime()
  const present = () => {
    const root = Application.getRootView()
    if (detour || !root) return
    const frame = new Frame()
    // Shared pages leave by goBack() from their first screen, or by navigating to
    // the legacy main page; in a detour both close it. (A blank base page under
    // the first would be what slides up: the queue reaches page two only after
    // page one's viewDidAppear, i.e. after the presentation animation.)
    const goBack = frame.goBack.bind(frame) as Frame['goBack'], navigate = frame.navigate.bind(frame) as (entry: unknown) => void
    frame.goBack = to => { if (frame.canGoBack()) goBack(to); else frame.closeModal() }
    frame.navigate = (entry: NavigationEntry | string | (() => Page)) => {
      if ((typeof entry === 'string' ? entry : (entry as NavigationEntry).moduleName) === RETURN_PAGE) frame.closeModal()
      else navigate(entry)
    }
    frame.navigate({ moduleName, context })
    root.showModal(frame, {
      fullscreen: true, cancelable: false,
      closeCallback: () => { detour = null; runtime.setDetour(false) },
    })
    // NativeScript only traces a refused presentation (e.g. another sheet is up).
    if (root.modal !== frame) return
    detour = frame
    runtime.setDetour(true)
  }
  if (disconnect) await runtime.withDisconnected(present)
  else present()
}

/** iOS finishOnboardingNavigation: close the detour, or leave first-run onboarding for the shell. */
export function finishDetour(): void {
  if (detour) detour.closeModal()
  else if (!hasShell()) Application.resetRootView({ create: createShell })
}

export function createReturnPage(): Page {
  const page = new Page()
  page.actionBarHidden = true
  page.on('navigatedTo', finishDetour)
  return page
}
