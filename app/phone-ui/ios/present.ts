import { Utils } from '@nativescript/core'

/**
 * Present a UIKit controller from the topmost presented one: the root view
 * controller refuses a second presentation while a detour, a sheet or an alert
 * is up. Walks from the window's own root (Utils.ios.getRootViewController()
 * returns the leaf, dismissing or not). While a controller is being dismissed
 * its presenter still holds it and refuses too, so wait for the dismissal to
 * finish and present then; true means it was presented or will be.
 */
export function presentOnTop(controller: UIViewController): boolean {
  let host = Utils.getWindow<UIWindow>()?.rootViewController
  if (!host) return false
  while (host.presentedViewController) {
    // ponytail: polls every 50 ms; a coordinator completion if the delay ever shows.
    if (host.presentedViewController.beingDismissed) { setTimeout(() => presentOnTop(controller), 50); return true }
    host = host.presentedViewController
  }
  host.presentViewControllerAnimatedCompletion(controller, true, null)
  return true
}
