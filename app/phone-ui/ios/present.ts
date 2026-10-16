import { Utils } from '@nativescript/core'

/**
 * Present a UIKit controller from the topmost presented one: the root view
 * controller refuses a second presentation while a detour, a sheet or an alert
 * is up, and one being dismissed refuses too. Walks from the window's own root:
 * Utils.ios.getRootViewController() already returns the leaf, dismissing or not.
 */
export function presentOnTop(controller: UIViewController): boolean {
  let host = Utils.getWindow<UIWindow>()?.rootViewController
  while (host?.presentedViewController && !host.presentedViewController.beingDismissed) host = host.presentedViewController
  if (!host) return false
  host.presentViewControllerAnimatedCompletion(controller, true, null)
  return true
}
