// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'

import { connect } from '../src/index.js'
import { message } from '../src/protocol.js'
import {
  context,
  deliver,
  entry,
  lastConnect,
  setup,
  teardown,
  widgets,
} from './helpers/kv-host.js'

beforeEach(setup)
afterEach(teardown)

it('exchanges real structured-clone messages over an independent MessageChannel', async () => {
  const channel = new MessageChannel()

  try {
    const pending = connect()
    const { connectionId } = lastConnect()
    deliver({ ...message('connected'), connectionId, context: context() }, [
      channel.port1 as unknown as MessagePort,
    ])
    const widget = await pending
    widgets.add(widget)
    channel.port2.addEventListener(
      'message',
      ({
        data: request,
      }: MessageEvent<{ requestId: string; type: string; params?: { value: unknown } }>) => {
        if (request.type !== 'request') return
        channel.port2.postMessage({
          ...message('response'),
          connectionId,
          requestId: request.requestId,
          ok: true,
          result: entry('settings', request.params!.value as string),
        })
      }
    )
    channel.port2.start()

    await expect(widget.storage.set('settings', '')).resolves.toEqual(entry('settings', ''))
  } finally {
    channel.port1.close()
    channel.port2.close()
  }
})
