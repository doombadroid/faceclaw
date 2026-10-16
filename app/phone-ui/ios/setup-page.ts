import { Button, GridLayout, Image, Label, Page, ScrollView, StackLayout } from '@nativescript/core'
import { GENERIC_G2_IMAGE_PATH } from '../../g2/glasses-artwork'
import { APP_NAME } from '../../branding'

export const UNPAIR_PAGE = 'phone-ui/onboarding-unpair-page'

// What Continue actually leads through: the unpair page (one app or phone at a
// time), then the pairing scan (glasses out of the case, both arms heard,
// optional ring), then the firmware check.
export const SETUP_BODY = `${APP_NAME} finds your glasses over Bluetooth, then checks which firmware they run and offers to install Faceclaw's custom firmware if they need it.`
export const SETUP_STEPS = [
  'Disconnect the glasses from any other app or phone, such as the Even Realities app. They can only be connected to one at a time.',
  'Take the glasses out of the case, or wear them, and keep them near this iPhone.',
  'Select your glasses once both arms are found. Adding an R1 ring is optional.',
]
// Pairing saves addresses with ApplicationSettings and sends nothing anywhere,
// but the firmware step Continue leads to (install, or font extraction) fetches
// Even's stock image (firmware-builder.ts FIRMWARE_URL).
export const SETUP_FOOTER = "Pairing uses Bluetooth only, and the addresses of your glasses and ring are saved on this iPhone. The firmware step downloads Even's official firmware from Even Realities."

function label(text: string, className: string): Label {
  const view = new Label()
  view.text = text; view.className = className; view.textWrap = true
  return view
}

/** The Pair Glasses detour's first screen; Continue hands over to the shared unpair page. */
export function createPage(): Page {
  const page = new Page()
  page.className = 'os-page os-setup'
  page.actionBarHidden = true
  const root = new GridLayout()
  root.rows = 'auto,*,auto'
  page.content = root

  const cancel = new Button()
  cancel.text = 'Cancel'; cancel.className = 'os-setup-cancel'
  cancel.horizontalAlignment = 'left'
  // From a detour's first page goBack() closes the detour (detour.ts).
  cancel.on('tap', () => page.frame?.goBack())
  root.addChild(cancel)

  const body = new StackLayout()
  body.className = 'os-setup-body'
  body.verticalAlignment = 'middle'
  const art = new Image()
  art.src = GENERIC_G2_IMAGE_PATH; art.stretch = 'aspectFit'; art.className = 'os-setup-art'
  art.accessibilityHidden = true
  body.addChild(art)
  body.addChild(label('Set Up Even G2', 'os-setup-title'))
  body.addChild(label(SETUP_BODY, 'os-setup-lead'))
  SETUP_STEPS.forEach((text, i) => {
    const step = new GridLayout()
    step.columns = 'auto,*'; step.className = 'os-setup-step'
    step.accessible = true; step.accessibilityLabel = `Step ${i + 1}. ${text}`
    const number = label(String(i + 1), 'os-setup-step-number')
    number.textWrap = false
    step.addChild(number)
    const line = label(text, 'os-setup-step-text')
    GridLayout.setColumn(line, 1); step.addChild(line)
    body.addChild(step)
  })
  // ScrollView lays its content out at least viewport-tall, so 'middle' still centres.
  const scroll = new ScrollView()
  scroll.content = body
  GridLayout.setRow(scroll, 1); root.addChild(scroll)

  const bottom = new StackLayout()
  bottom.className = 'os-setup-bottom'
  const next = new Button()
  next.text = 'Continue'; next.className = 'os-filled-button os-setup-continue'
  next.on('tap', () => page.frame?.navigate({ moduleName: UNPAIR_PAGE }))
  bottom.addChild(next)
  bottom.addChild(label(SETUP_FOOTER, 'os-setup-footer'))
  GridLayout.setRow(bottom, 2); root.addChild(bottom)
  return page
}
