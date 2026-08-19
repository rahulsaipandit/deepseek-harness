/**
 * `dsh-imchat`: bridges Telegram/WhatsApp/Slack chat to DSH agent sessions.
 * A single Cordis plugin per the design doc's architecture — see
 * `docs/adr/rp_dshPlugin_imChat.md` in the main repo for the full design and
 * its rejected alternatives. v1 assumes this plugin owns its host's question
 * seam exclusively (see the design doc's Non-goals); approvals compose with
 * any other UI's answerer regardless.
 * @module dsh-plugin-imchat
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-user-approval'
import '@deepseek-ai/dsh-user-questions'
import { randomUUID } from 'node:crypto'
import { IdentityRegistry } from './core/identity-registry.ts'
import { StateStore } from './core/state-store.ts'
import { SessionRouter, type AgentsPort } from './core/session-router.ts'
import { ApprovalRelay } from './core/approval-relay.ts'
import type { ChatAdapter, Platform } from './core/types.ts'
import { TelegramAdapter } from './adapters/telegram.ts'
import type { SlackEventsClient } from './adapters/slack.ts'

/** Services required before this plugin can register its question provider and route sessions. */
export const inject = ['agents', 'credentials', 'userQuestions']

const identityEntrySchema = z.object({
  senderId: z.string(),
  approvalPolicy: z.union([z.const('ask'), z.const('never')]),
})

/**
 * Plugin config, schema-first: `Config`'s TYPE is inferred from the schema
 * below (`Schemastery.TypeT`, the fully-resolved post-default output type),
 * rather than a hand-written interface kept in sync by hand — the two
 * otherwise drift under `exactOptionalPropertyTypes` (readonly vs. mutable
 * arrays, optional-vs-nullable fields) for anything past flat scalar fields.
 */
export const Config = z.object({
  /** Per-platform allow-listed sender identities. A platform with no entries here is not started. */
  identities: z.object({
    telegram: z.array(identityEntrySchema).default([]),
    whatsapp: z.array(identityEntrySchema).default([]),
    slack: z.array(identityEntrySchema).default([]),
  }).default({ telegram: [], whatsapp: [], slack: [] }),
  /** `ctx.credentials` reference naming the Telegram bot token; required to enable Telegram. */
  telegramTokenRef: z.string().default(''),
  /** `ctx.credentials` reference naming the Slack bot token; required to enable Slack. */
  slackBotTokenRef: z.string().default(''),
  /** Idle eviction TTL (ms) for in-memory session bindings. Defaults to 24h. */
  sessionIdleTtlMs: z.number().default(24 * 60 * 60 * 1000),
  /** How long a rendered approval/question prompt waits for a reply before failing closed. Defaults to 5 minutes. */
  promptTimeoutMs: z.number().default(5 * 60 * 1000),
  /** Directory for this plugin's local state files (session-id map, poll cursor). */
  stateDir: z.string().default('.dsh-imchat'),
})

export type Config = Schemastery.TypeT<typeof Config>

/** Constructs a `SlackEventsClient`; overridden in tests to avoid a real Socket Mode connection. */
export type SlackEventsClientFactory = (appToken: CredentialRef) => SlackEventsClient

/** Extension point for tests: everything `apply()` would otherwise construct itself. */
export interface ApplyOverrides {
  telegramAdapter?: ChatAdapter
  slackAdapter?: ChatAdapter
  now?: () => number
}

/** Register the `dsh-imchat` bridge. */
export async function apply(ctx: Context, config: Config, overrides: ApplyOverrides = {}): Promise<void> {
  const resolved = config
  const identities = new IdentityRegistry(resolved.identities)

  const adapters = new Map<Platform, ChatAdapter>()

  if (overrides.telegramAdapter !== undefined) {
    // The allowlist check applies even when a test/deployment injects its own adapter — an
    // empty allowlist is refused regardless of which code path constructed the adapter.
    identities.assertConfigured('telegram')
    adapters.set('telegram', overrides.telegramAdapter)
  } else if (resolved.telegramTokenRef.length > 0) {
    identities.assertConfigured('telegram')
    const resolvedToken = await ctx.credentials.resolve(credentialRef(resolved.telegramTokenRef))
    if (resolvedToken === undefined) {
      throw new Error(`dsh-imchat: telegramTokenRef "${resolved.telegramTokenRef}" is not configured`)
    }
    adapters.set('telegram', new TelegramAdapter({ token: resolvedToken.value }))
  }

  if (overrides.slackAdapter !== undefined) {
    identities.assertConfigured('slack')
    adapters.set('slack', overrides.slackAdapter)
  } else if (resolved.slackBotTokenRef.length > 0) {
    identities.assertConfigured('slack')
    const resolvedToken = await ctx.credentials.resolve(credentialRef(resolved.slackBotTokenRef))
    if (resolvedToken === undefined) {
      throw new Error(`dsh-imchat: slackBotTokenRef "${resolved.slackBotTokenRef}" is not configured`)
    }
    // A real deployment supplies a genuine Socket Mode `SlackEventsClient`; wiring one is
    // outside this plugin's scope (see slack.ts's module doc) until a concrete client is chosen.
    throw new Error('dsh-imchat: Slack requires a SlackEventsClient (Socket Mode) — pass one via overrides.slackAdapter')
  }

  const stateStores = new Map<Platform, StateStore<unknown>>()
  const sessionRouters = new Map<Platform, SessionRouter>()
  const now = overrides.now ?? (() => Date.now())

  for (const platform of adapters.keys()) {
    const store = new StateStore<unknown>(`${resolved.stateDir}/${platform}.json`)
    stateStores.set(platform, store)
    sessionRouters.set(platform, new SessionRouter(
      ctx.agents as AgentsPort,
      store,
      (raw: string) => SessionId(raw),
      () => randomUUID(),
      resolved.sessionIdleTtlMs,
      now,
    ))
  }

  function locate(sessionId: SessionId) {
    for (const router of sessionRouters.values()) {
      const location = router.chatFor(sessionId)
      if (location !== undefined) return location
    }
    return undefined
  }

  const relay = new ApprovalRelay(adapters, locate, resolved.promptTimeoutMs)

  for (const [platform, adapter] of adapters) {
    const router = sessionRouters.get(platform)
    if (router === undefined) continue
    adapter.onMessage((message) => {
      if (!identities.isAllowed(platform, message.senderId)) return
      void router.followup(platform, message.chatId, createUserMessage({
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'user' },
      }))
    })
  }

  ctx.effect(function* () {
    const disposeQuestions = ctx.userQuestions.registerProvider({
      ask: request => relay.ask(request),
    })
    const disposeApproval = ctx.on('approval/request', (req, next) => relay.handleApprovalRequest(req, next))
    yield () => {
      disposeQuestions()
      disposeApproval()
    }
  }, 'dsh-imchat.registerRelay()')

  for (const adapter of adapters.values()) await adapter.start()
  ctx.effect(function* () {
    yield () => {
      for (const adapter of adapters.values()) void adapter.stop()
    }
  }, 'dsh-imchat.stopAdapters()')
}
