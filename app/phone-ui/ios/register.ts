import { groupedPage, section } from './ui-kit'

// The OcuSmart shell's pages. iOS bundles only registered modules (webpack.config.js).
const stub = (title: string) => () => ({
  createPage: () => groupedPage({ title, build: container => container.addChild(section({ footer: 'Not built yet.', rows: [] })) }).page,
})
global.registerModule('ocusmart/glasses', () => require('./glasses-page'))
global.registerModule('ocusmart/remote', () => require('./remote-page'))
global.registerModule('ocusmart/apps', stub('Apps'))
global.registerModule('ocusmart/hub', stub('Even Hub'))
global.registerModule('ocusmart/hub-detail', stub('App'))
global.registerModule('ocusmart/settings', stub('Settings'))
global.registerModule('ocusmart/settings-category', stub('Settings'))
global.registerModule('ocusmart/settings-choice', stub('Settings'))
global.registerModule('ocusmart/device', stub('Glasses'))
global.registerModule('ocusmart/about', stub('About'))
global.registerModule('ocusmart/update', stub('Software Update'))
global.registerModule('ocusmart/firmware-channel', stub('Firmware Channel'))
global.registerModule('ocusmart/setup', stub('Set Up'))
// Legacy name the shared view models fall back to.
global.registerModule('phone-ui/main-page', () => ({ createPage: (require('./detour') as typeof import('./detour')).createReturnPage }))
