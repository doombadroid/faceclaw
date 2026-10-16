import { Utils } from '@nativescript/core'

/**
 * Present a UIKit controller from the topmost presented one: the root view
 * controller refuses a second presentation while a detour, a sheet or an alert
 * is up.
 */
export function presentOnTop(controller: UIViewController): boolean {
  let host = Utils.ios.getRootViewController()
  while (host?.presentedViewController && !host.presentedViewController.beingDismissed) host = host.presentedViewController
  if (!host) return false
  host.presentViewControllerAnimatedCompletion(controller, true, null)
  return true
}
