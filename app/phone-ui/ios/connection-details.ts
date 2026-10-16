import { Dialogs } from '@nativescript/core'
import { getRuntime } from './runtime'
import { presentOnTop } from './present'

/**
 * Connection Details, with the whole app log one tap away. The dialog shows
 * the recent errors and the last few lines; Share Log hands bluetooth.log to
 * the share sheet (AirDrop, Files, Messages) so a full trace can leave the
 * phone without a cable.
 */
export async function showConnectionDetails(): Promise<void> {
  const controller = getRuntime().controller
  const choice = await Dialogs.confirm({ title: 'Connection Details', message: controller.connectionDetails,
    okButtonText: 'OK', neutralButtonText: 'Share Log' })
  if (choice !== undefined) return
  const file = NSURL.fileURLWithPath(controller.logFile())
  presentOnTop(UIActivityViewController.alloc().initWithActivityItemsApplicationActivities([file], null))
}
