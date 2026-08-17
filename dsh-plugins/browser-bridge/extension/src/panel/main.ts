/**
 * Minimal side-panel UI: bridge settings (address/token/page-read policy),
 * live connection status, and the approval prompt for pending tool calls.
 *
 * This is a deliberately minimal, from-scratch panel (plain DOM, no React) —
 * the task's port scope explicitly allows a minimal functional panel in
 * exchange for prioritizing the security-critical background/content/security
 * modules, which are ported faithfully. It talks to the background service
 * worker only over `chrome.runtime.connect({ name: 'dsh-panel' })`, matching
 * the protocol documented at the top of `../background/index.ts`.
 *
 * @module
 */

import type { ApprovalRequest } from '../security/approval.ts'
import type { BridgeCaps } from '../protocol.ts'

interface Settings {
  bridgeUrl: string
  token: string
  sharePageContent: 'ask' | 'auto' | 'off'
  trustedActionOrigins: string[]
  approvalNotifications: boolean
}

type BridgeState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'

const port = chrome.runtime.connect({ name: 'dsh-panel' })

const statusEl = document.querySelector<HTMLElement>('#status')!
const approvalsEl = document.querySelector<HTMLElement>('#approvals')!
const bridgeUrlInput = document.querySelector<HTMLInputElement>('#bridgeUrl')!
const tokenInput = document.querySelector<HTMLInputElement>('#token')!
const sharePageContentSelect = document.querySelector<HTMLSelectElement>('#sharePageContent')!
const saveButton = document.querySelector<HTMLButtonElement>('#save')!

void chrome.storage.local.get('dshBrowserBridgeSettings').then((stored) => {
  const settings = stored.dshBrowserBridgeSettings as Partial<Settings> | undefined
  if (settings?.bridgeUrl !== undefined) bridgeUrlInput.value = settings.bridgeUrl
  if (settings?.token !== undefined) tokenInput.value = settings.token
  if (settings?.sharePageContent !== undefined) sharePageContentSelect.value = settings.sharePageContent
})

saveButton.addEventListener('click', () => {
  port.postMessage({
    type: 'settings',
    settings: {
      bridgeUrl: bridgeUrlInput.value.trim(),
      token: tokenInput.value.trim(),
      sharePageContent: sharePageContentSelect.value as Settings['sharePageContent'],
    },
  })
})

function renderStatus(state: BridgeState, caps: BridgeCaps | null): void {
  statusEl.textContent = caps === null
    ? `Bridge: ${state}`
    : `Bridge: ${state} (snapshot budget ${caps.snapshotMaxChars} chars, ${caps.maxInteractiveItems} items)`
}

const pendingApprovals = new Map<string, ApprovalRequest>()

function renderApprovals(): void {
  approvalsEl.replaceChildren()
  for (const request of pendingApprovals.values()) {
    const row = document.createElement('div')
    row.className = 'approval-row'
    const summary = document.createElement('span')
    summary.textContent = `${request.summary} (${request.origins.join(', ') || 'unknown origin'})`
    row.append(summary)
    const allow = document.createElement('button')
    allow.textContent = 'Allow once'
    allow.addEventListener('click', () => { respond(request.id, 'allow-once') })
    const deny = document.createElement('button')
    deny.textContent = 'Deny'
    deny.addEventListener('click', () => { respond(request.id, 'deny') })
    row.append(allow, deny)
    if (request.kind === 'action' && request.canTrust) {
      const trust = document.createElement('button')
      trust.textContent = 'Trust this origin'
      trust.addEventListener('click', () => { respond(request.id, 'trust-origin') })
      row.append(trust)
    }
    if (request.kind === 'read') {
      const always = document.createElement('button')
      always.textContent = 'Always allow reads'
      always.addEventListener('click', () => { respond(request.id, 'always-allow-reads') })
      row.append(always)
    }
    approvalsEl.append(row)
  }
}

function respond(id: string, decision: string): void {
  port.postMessage({ type: 'approval.response', id, decision })
  pendingApprovals.delete(id)
  renderApprovals()
}

port.onMessage.addListener((message: unknown) => {
  if (typeof message !== 'object' || message === null) return
  const msg = message as { type?: string }
  switch (msg.type) {
    case 'status': {
      const status = message as { state: BridgeState; caps: BridgeCaps | null }
      renderStatus(status.state, status.caps)
      break
    }
    case 'approval.request': {
      const { request } = message as { request: ApprovalRequest }
      pendingApprovals.set(request.id, request)
      renderApprovals()
      break
    }
    case 'approval.resolved': {
      const { id } = message as { id: string }
      pendingApprovals.delete(id)
      renderApprovals()
      break
    }
  }
})

port.postMessage({ type: 'request-status' })
