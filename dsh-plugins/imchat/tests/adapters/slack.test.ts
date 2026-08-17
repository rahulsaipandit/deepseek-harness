import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SlackAdapter } from '../../src/adapters/slack.ts'
import type { InboundMessage, PromptReply } from '../../src/core/types.ts'
import { FakeSlackEventsClient, startMockSlackServer, type MockSlackServer } from '../mocks/slack-mock-server.ts'

describe('SlackAdapter', () => {
  let server: MockSlackServer
  let events: FakeSlackEventsClient
  let adapter: SlackAdapter

  beforeEach(async () => {
    server = await startMockSlackServer()
    events = new FakeSlackEventsClient()
    adapter = new SlackAdapter({ botToken: 'xoxb-test', events, baseUrl: server.baseUrl })
  })

  afterEach(async () => {
    await adapter.stop()
    await server.close()
  })

  it('sendText posts to the mock chat.postMessage endpoint and returns the message ts', async () => {
    const ts = await adapter.sendText('C1', 'hello there')
    expect(server.sent).toEqual([{ channel: 'C1', text: 'hello there', blocks: undefined }])
    expect(ts).toBe('1')
  })

  it('editText posts to the mock chat.update endpoint', async () => {
    await adapter.editText('C1', '1.234', 'edited text')
    expect(server.updated).toEqual([{ channel: 'C1', ts: '1.234', text: 'edited text' }])
  })

  it('sendPrompt renders a Block Kit actions block with action_id `<promptId>:<optionId>`', async () => {
    await adapter.sendPrompt('C1', {
      id: 'p1',
      kind: 'approval',
      text: 'Allow bash?',
      options: [{ id: 'allow', label: 'Allow' }, { id: 'reject', label: 'Reject' }],
    })
    expect(server.sent).toHaveLength(1)
    expect(server.sent[0]!.blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Allow bash?' } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Allow' }, action_id: 'p1:allow' },
          { type: 'button', text: { type: 'plain_text', text: 'Reject' }, action_id: 'p1:reject' },
        ],
      },
    ])
  })

  it('starts the injected events client and delivers a message event to the message handler', async () => {
    const received: InboundMessage[] = []
    adapter.onMessage(message => received.push(message))
    await adapter.start()
    expect(events.started).toBe(true)

    events.emitMessage({ channel: 'C1', user: 'U1', text: 'hi bot' })
    expect(received).toEqual([{ chatId: 'C1', senderId: 'U1', text: 'hi bot' }])
  })

  it('delivers a block_actions interaction as a prompt reply', async () => {
    const replies: PromptReply[] = []
    adapter.onPromptReply(reply => replies.push(reply))
    await adapter.start()

    events.emitBlockAction({ channel: 'C1', actionId: 'p1:reject' })
    expect(replies).toEqual([{ chatId: 'C1', promptId: 'p1', optionId: 'reject' }])
  })

  it('stop() stops the injected events client', async () => {
    await adapter.start()
    await adapter.stop()
    expect(events.started).toBe(false)
  })
})
