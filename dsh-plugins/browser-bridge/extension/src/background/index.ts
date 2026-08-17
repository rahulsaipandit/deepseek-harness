/**
 * Background service worker entry: owns the bridge connection, controlled-tab
 * tool dispatch, and the panel port service.
 *
 * This is a simplified reimplementation of upstream's
 * `extensions/dsh-browser/src/background/index.ts` — see the README "Trust
 * and limitations" section for the full list of what was dropped. In
 * particular, this port always targets `chrome.tabs.query({active:true,
 * lastFocusedWindow:true})` at dispatch time instead of upstream's explicit
 * tab-affinity/handoff state machine (`tab-affinity.ts`, `focused-window.ts`,
 * `session-continuity.ts`) — there is no "keep working on the backgrounded
 * tab while the user looks elsewhere" continuity, and no automatic
 * followed-page snapshot injection. The security-critical properties are
 * unchanged: every state-changing action and (when `sharePageContent ===
 * 'ask'`) every page read still requires the approval flow in
 * `authorization.ts`/`approval-coordinator.ts` before the content script ever
 * runs it, page text is wrapped by `untrusted.ts` before being sent back over
 * the bridge, and this file's only reachable inbound listener from outside
 * the extension is `chrome.runtime.onConnect`/`onMessage`, both restricted by
 * the manifest to this extension's own scripts.
 *
 * Panel port protocol (chrome.runtime.connect, name "dsh-panel"):
 *   panel -> bg: { type: 'rpc', id, method, payload }
 *   panel -> bg: { type: 'settings', settings: Partial<Settings> }
 *   panel -> bg: { type: 'approval.response', id, decision }
 *   panel -> bg: { type: 'request-status' }
 *   bg -> panel: { type: 'rpc.result', id, ok, result? | error? }
 *   bg -> panel: { type: 'status', state: BridgeState, caps? }
 *   bg -> panel: { type: 'event', frame: ServerFrame }
 *   bg -> panel: { type: 'approval.request', request }
 *   bg -> panel: { type: 'approval.resolved', id }
 *
 * @module
 */

import type { BridgeCaps } from '../protocol.ts'
import { BRIDGE_CONFIG_PATH, BRIDGE_PATH } from '../protocol.ts'
import { BridgeClient, type BridgeState } from './bridge.ts'
import { dispatchToolCall, resetTabSnapshot, type ToolAnswer, type ToolCall } from './tools.ts'
import {
  isApprovalDecision,
  type ApprovalAuthorization,
  type ApprovalPrompt,
  type ApprovalRequest,
} from '../security/approval.ts'
import { actionCoveredByTrustedOrigins, normalizeTrustedOrigin } from '../security/trusted-origins.ts'
import { ApprovalCoordinator, type ApprovalRequestResult } from './approval-coordinator.ts'

/** User settings persisted in chrome.storage.local. */
export interface Settings {
  bridgeUrl: string
  token: string
  sharePageContent: 'ask' | 'auto' | 'off'
  /** Origins whose state-changing actions may run without another prompt. */
  trustedActionOrigins: string[]
  approvalNotifications: boolean
}

const SETTINGS_DEFAULTS: Settings = {
  // Empty = auto-discover the local dsh instance (zero-config); a manually
  // configured address always wins.
  bridgeUrl: '',
  token: '',
  sharePageContent: 'auto',
  trustedActionOrigins: [],
  approvalNotifications: true,
}

/** Candidate auto-discovery ports (dsh web defaults to 3080; common --port overrides). */
const DISCOVERY_PORTS = [3080, 3081, 3090]

/** Probe for a local dsh bridge: fetch /ext/bridge-config until one answers. */
async function discoverBridge(): Promise<string | undefined> {
  for (const port of DISCOVERY_PORTS) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${BRIDGE_CONFIG_PATH}`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (!response.ok) continue
      const body = await response.json() as { wsUrl?: unknown }
      if (typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')) return body.wsUrl
    } catch {
      // No dsh (or no bridge) on this port: try the next one.
    }
  }
  return undefined
}

/** Avoid opening a noisy loopback WebSocket until the local bridge responds. */
async function probeBridge(url: string): Promise<boolean> {
  try {
    const target = new URL(url)
    if (target.hostname !== '127.0.0.1') return true
    target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
    target.pathname = BRIDGE_CONFIG_PATH
    target.search = ''
    target.hash = ''
    const response = await fetch(target, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return false
    const body = await response.json() as { wsUrl?: unknown }
    return typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')
  } catch {
    return false
  }
}

const STORAGE_KEY = 'dshBrowserBridgeSettings'

let settings: Settings = { ...SETTINGS_DEFAULTS }
let caps: BridgeCaps | null = null
let bridge: BridgeClient | null = null
const panelPorts = new Set<chrome.runtime.Port>()
/** Ephemeral allowlist: cleared when the last side panel closes or this worker restarts. */
const sessionTrustedActionOrigins = new Set<string>()
/** Tool calls that can still be withdrawn by a bridge `tool.cancel` frame. */
const activeToolCalls = new Map<string, AbortController>()

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  return normalizeSettings({ ...SETTINGS_DEFAULTS, ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) })
}

async function persistSettings(next: Partial<Settings>): Promise<void> {
  settings = normalizeSettings({ ...settings, ...next })
  await chrome.storage.local.set({ [STORAGE_KEY]: settings })
}

function normalizeSettings(candidate: Settings): Settings {
  const trusted = Array.isArray(candidate.trustedActionOrigins)
    ? [...new Set(candidate.trustedActionOrigins.map(normalizeTrustedOrigin).filter((entry): entry is string => entry !== undefined))].sort()
    : []
  const sharePageContent = candidate.sharePageContent === 'ask' || candidate.sharePageContent === 'off'
    ? candidate.sharePageContent
    : 'auto'
  return {
    ...candidate,
    sharePageContent,
    trustedActionOrigins: trusted,
    approvalNotifications: candidate.approvalNotifications !== false,
  }
}

function broadcastStatus(): void {
  const payload = { type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

const APPROVAL_NOTIFICATION_PREFIX = 'dsh-browser-bridge-approval:'

function approvalNotificationId(id: string): string {
  return `${APPROVAL_NOTIFICATION_PREFIX}${id}`
}

function deliverApproval(request: ApprovalRequest): boolean {
  let delivered = false
  for (const port of panelPorts) {
    try {
      port.postMessage({ type: 'approval.request', request })
      delivered = true
    } catch { /* port already closed */ }
  }
  return delivered
}

function notifyApproval(request: ApprovalRequest, _windowId: number): void {
  if (!settings.approvalNotifications) return
  void Promise.resolve(chrome.notifications.create(approvalNotificationId(request.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title: 'Browser action awaiting approval',
    message: 'Click to open the DSH Browser Bridge panel, then allow or deny within 60 seconds.',
    requireInteraction: true,
  })).catch(() => {})
}

function clearApprovalNotification(id: string): void {
  void Promise.resolve(chrome.notifications.clear(approvalNotificationId(id))).catch(() => {})
}

function broadcastApprovalResolved(id: string): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'approval.resolved', id }) } catch { /* port already closed */ }
  }
}

const approvals = new ApprovalCoordinator({
  deliver: deliverApproval,
  notify: notifyApproval,
  clearNotification: clearApprovalNotification,
  resolved: broadcastApprovalResolved,
})

async function authorizeToolCall(prompt: ApprovalPrompt, signal: AbortSignal, windowId: number, sessionId?: string): Promise<ApprovalAuthorization> {
  if (signal.aborted) return 'cancelled'
  if (actionCoveredByTrustedOrigins(prompt, sessionTrustedActionOrigins, settings.trustedActionOrigins)) {
    return 'approved'
  }
  const result: ApprovalRequestResult = await approvals.request(prompt, signal, windowId, sessionId)
  if (signal.aborted) return 'cancelled'
  if (result.status !== 'decision') return result.status
  const { decision } = result
  if (decision === 'always-allow-reads' && prompt.kind === 'read') {
    await persistSettings({ sharePageContent: 'auto' })
    return 'approved'
  }
  if ((decision === 'trust-session' || decision === 'trust-origin')
    && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    if (decision === 'trust-session') sessionTrustedActionOrigins.add(prompt.origins[0]!)
    else await persistSettings({ trustedActionOrigins: [...settings.trustedActionOrigins, prompt.origins[0]!] })
    return 'approved'
  }
  return decision === 'allow-once' ? 'approved' : 'denied'
}

/** Resolve the current active tab in the last-focused window (no tab-affinity continuity in this port). */
async function resolveActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    return tab
  } catch {
    return undefined
  }
}

/** Route one tool.call frame to the currently active tab. */
function routeToolCall(call: ToolCall): void {
  if (bridge === null) return
  activeToolCalls.get(call.id)?.abort()
  const controller = new AbortController()
  activeToolCalls.set(call.id, controller)
  const budget = caps === null ? undefined : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
  void resolveActiveTab().then((tab): Promise<ToolAnswer> => {
    if (tab === undefined || tab.id === undefined) {
      return Promise.resolve({ ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } })
    }
    return dispatchToolCall(
      call,
      settings.sharePageContent,
      budget,
      (prompt) => authorizeToolCall(prompt, controller.signal, tab.windowId, call.sessionId),
      controller.signal,
      tab,
    )
  }).then(
    (answer) => {
      if (controller.signal.aborted) return
      const socket = bridge
      if (socket === null) return
      if (answer.ok) socket.send({ t: 'tool.result', id: call.id, ok: true, result: answer.result })
      else socket.send({ t: 'tool.result', id: call.id, ok: false, error: answer.error! })
    },
    (error: unknown) => {
      if (controller.signal.aborted) return
      bridge?.send({
        t: 'tool.result',
        id: call.id,
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
      })
    },
  ).finally(() => {
    if (activeToolCalls.get(call.id) === controller) activeToolCalls.delete(call.id)
  })
}

function cancelToolCall(id: string): void {
  activeToolCalls.get(id)?.abort()
}

function cancelAllToolCalls(): void {
  for (const controller of activeToolCalls.values()) controller.abort()
  activeToolCalls.clear()
  approvals.cancelAll()
}

/** (Re)start the bridge with the current settings. Empty address auto-discovers; loopback connections need no token. */
async function startBridge(): Promise<void> {
  let url = settings.bridgeUrl
  if (url === '') url = await discoverBridge() ?? ''
  if (url === '') {
    bridge?.stop()
    bridge = null
    broadcastStatus()
    return
  }
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = BRIDGE_PATH
    url = parsed.toString()
  } catch {
    // An invalid URL is passed through as-is; the WebSocket constructor reports the error.
  }
  if (bridge === null) {
    const client = new BridgeClient({
      onStateChange: (state) => {
        if (state !== 'connected') cancelAllToolCalls()
        broadcastStatus()
      },
      onFrame: (frame) => {
        if (frame.t === 'tool.call') routeToolCall(frame)
        else if (frame.t === 'tool.cancel') cancelToolCall(frame.id)
      },
      onHelloOk: (negotiated) => {
        caps = negotiated
        broadcastStatus()
      },
    }, probeBridge)
    bridge = client
  }
  bridge.start(url, settings.token)
}

// ---- Panel ports ----
// SECURITY: chrome.runtime.onConnect fires only for connections FROM this
// extension's own contexts (the side panel); it is not reachable from web
// pages, matching the manifest's absence of `externally_connectable`.

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dsh-panel') return
  panelPorts.add(port)
  if (bridge === null) void startBridge()
  try { port.postMessage({ type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps }) } catch { /* port closed */ }

  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const msg = message as { type?: string }
    switch (msg.type) {
      case 'settings': {
        const settingsMsg = message as { settings: Partial<Settings> }
        void persistSettings(settingsMsg.settings).then(async () => {
          await startBridge()
          broadcastStatus()
        })
        break
      }
      case 'approval.response': {
        const approval = message as { id?: unknown; decision?: unknown }
        if (typeof approval.id === 'string' && isApprovalDecision(approval.decision)) {
          approvals.respond(approval.id, approval.decision)
        }
        break
      }
      case 'request-status':
        try {
          port.postMessage({ type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps })
          approvals.replay((request) => {
            port.postMessage({ type: 'approval.request', request })
            return true
          })
        } catch { /* port closed */ }
        break
    }
  })
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port)
    if (panelPorts.size === 0) {
      sessionTrustedActionOrigins.clear()
      approvals.notifyPending()
    }
  })
})

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return
  const id = notificationId.slice(APPROVAL_NOTIFICATION_PREFIX.length)
  const windowId = approvals.windowId(id)
  if (windowId === undefined) return
  clearApprovalNotification(id)
  // Notification clicks are extension user gestures; Chrome permits
  // sidePanel.open() only from such a user-initiated event.
  void chrome.sidePanel.open({ windowId }).catch(() => {})
})

chrome.tabs.onRemoved.addListener((tabId) => {
  resetTabSnapshot(tabId)
})

// ---- Keepalive ----

chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'bridge-keepalive') return
  if (bridge === null || bridge.state === 'reconnecting') void startBridge()
})

// ---- Boot ----

// Clicking the toolbar icon opens the side panel directly (Chrome 116+).
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

void loadSettings().then(async (loaded) => {
  settings = loaded
  await startBridge()
})
