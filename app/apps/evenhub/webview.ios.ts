import { EVENHUB_BRIDGE_INJECT_SCRIPT, buildFaceclawExtensionsScript, type EvenHubSession } from './session'
import { FACECLAW_VERSION } from '../../version'
import type { EvenHubWebView } from './webview'

export const IOS_EVENHUB_TRANSPORT_SCRIPT = `
window.__faceclawEvenHub = { postMessage: function(name, args, id) {
  window.webkit.messageHandlers.faceclaw.postMessage({kind:'call', name:name, args:args, id:id});
}};
(function() {
  ['log','warn','error'].forEach(function(level) {
    var original = console[level];
    console[level] = function() {
      original.apply(console, arguments);
      window.webkit.messageHandlers.faceclaw.postMessage({kind:'console', message:Array.prototype.map.call(arguments, String).join(' ').slice(0,4000)});
    };
  });
  window.addEventListener('error', function(e) { console.error(e.message); });
  window.addEventListener('unhandledrejection', function(e) { console.error(String(e.reason)); });
})();
`

/**
 * A WKUserScript has no origin scope (Android's document-start injection takes
 * one), so the shim would also run in a page the app opens in a popup — an
 * OAuth login, say. That page must keep the platform's real timers: the shim
 * replaces setTimeout/setInterval/requestAnimationFrame with queues that only
 * drain when the native host ticks the app's own web view, so a foreign page
 * that inherited them loads and then never runs anything again.
 *
 * Packaged apps are matched by scheme alone: only this app's URL scheme
 * handler serves faceclaw-ehpk:, and `location.origin` is not dependable for
 * a non-special scheme.
 */
function scopeToAppOrigin(script: string, remoteUrl: string | null | undefined, declared: string[]): string {
  // A packaged app is served from either the loopback server (whose port is
  // picked at runtime, hence the host-only test) or the custom scheme. Host
  // access is gated natively against the exact origin either way, so a wider
  // test here only decides where the SDK shim is installed.
  const tests = [remoteUrl ? null : "(location.protocol === 'faceclaw-ehpk:' || location.hostname === '127.0.0.1')"]
  for (const origin of (remoteUrl ? [remoteUrl, ...declared] : declared)) {
    const parts = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]+)/i.exec(origin)
    if (!parts) continue
    const protocol = JSON.stringify(parts[1].toLowerCase())
    const host = parts[2].toLowerCase()
    // A declared wildcard host ("*.tesla.com") matches whole labels only.
    if (host.startsWith('*.')) {
      const suffix = JSON.stringify(host.slice(1))
      tests.push(`(location.protocol === ${protocol} && location.host.length > ${suffix}.length && location.host.endsWith(${suffix}))`)
    } else {
      tests.push(`(location.protocol === ${protocol} && location.host === ${JSON.stringify(host)})`)
    }
  }
  // Everything inside is an assignment to window or an IIFE, so a block is safe.
  return `if (${tests.filter(Boolean).join(' || ')}) {\n${script}\n}`
}

/**
 * The origins of the hosts the manifest declares, as "scheme://host[:port]"
 * with a default port dropped — the same shape the native side compares. An
 * app's auth flow redirects the whole page to its own hosted copy, which is
 * one of these, and that page has to reach the bridge to finish signing in.
 */
function declaredOrigins(hosts: string[]): string[] {
  const origins = new Set<string>()
  for (const host of hosts) {
    const parts = /^(https?):\/\/(\*?[^/?#:]+)(?::(\d+))?/i.exec(host.trim())
    if (!parts) continue
    const scheme = parts[1].toLowerCase()
    const port = parts[3] && parts[3] !== (scheme === 'https' ? '443' : '80') ? `:${parts[3]}` : ''
    origins.add(`${scheme}://${parts[2].toLowerCase()}${port}`)
  }
  return [...origins]
}

export function createEvenHubWebView(session: EvenHubSession): EvenHubWebView {
  const host = FaceclawEvenHubWebView.new()
  host.packageIdentifier = session.manifest.packageId
  // The manager's close callback for the shown phone UI; the native back
  // button hides the host itself and reports it as a 'hidden' event.
  let onClose: (() => void) | null = null
  host.eventHandler = (json: string) => {
    try {
      const event = JSON.parse(json)
      if (event.kind === 'call' && typeof event.name === 'string' && typeof event.args === 'string' && Number.isSafeInteger(event.id))
        session.handleBridgeCall(event.name, event.args, event.id)
      else if (event.kind === 'loaded') session.webViewLoaded()
      else if (event.kind === 'error') session.webViewFailed(String(event.message))
      else if (event.kind === 'hidden') { const close = onClose; onClose = null; close?.() }
      else if (event.kind === 'console') console.log(`[evenhub:${session.manifest.name}] ${event.message}`)
    } catch (error) { console.warn(`EvenHub bridge: ${error}`) }
  }
  // Defer loading until manager.ts has attached the session/window handles.
  const declared = declaredOrigins(session.manifest.networkWhitelist ?? [])
  host.allowedOrigins = declared
  const script = scopeToAppOrigin(
    IOS_EVENHUB_TRANSPORT_SCRIPT + EVENHUB_BRIDGE_INJECT_SCRIPT + buildFaceclawExtensionsScript(`Faceclaw/${FACECLAW_VERSION}`),
    session.remoteUrl, declared)
  const loading = setTimeout(() => {
    if (session.remoteUrl) host.startURLScript(session.remoteUrl, script)
    else host.startEntrypointScript(session.distDir, session.manifest.entrypoint, script)
  }, 0)
  return { native: host, evaluateJs: js => host.evaluate(js),
    destroy: () => { clearTimeout(loading); host.destroy() },
    showOnPhone: close => { onClose = close; host.showOnPhone() },
    hideOnPhone: () => { onClose = null; host.hideOnPhone() } }
}
