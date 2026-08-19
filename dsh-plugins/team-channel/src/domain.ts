/**
 * Pure validation for channel names, poster identities, and message bodies.
 * No I/O, no ctx — kept separate so the store and tools modules can both
 * depend on one small, easily-tested surface.
 * @module dsh-plugin-team-channel/domain
 */

/** One posted message, as returned to the model. */
export interface ChannelMessage {
  readonly id: number
  readonly channel: string
  readonly postedBy: string
  readonly body: string
  readonly postedAt: number
}

const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export interface InvalidChannelError { readonly code: 'invalid_channel'; readonly message: string }
export interface InvalidBodyError { readonly code: 'invalid_body'; readonly message: string }
export type ChannelInputError = InvalidChannelError | InvalidBodyError

/** Validate a channel name: same shape DSH already uses for preset ids, so it's a safe identifier anywhere (logs, filenames, tool args). */
export function validateChannelName(channel: string): InvalidChannelError | undefined {
  if (!CHANNEL_NAME_PATTERN.test(channel)) {
    return {
      code: 'invalid_channel',
      message: 'channel must match [a-z0-9][a-z0-9-]* (lowercase letters, digits, hyphens).',
    }
  }
  return undefined
}

/** Validate a post body: non-empty after trimming. */
export function validateBody(body: string): InvalidBodyError | undefined {
  if (body.trim().length === 0) {
    return { code: 'invalid_body', message: 'body must be non-empty after trimming.' }
  }
  return undefined
}
