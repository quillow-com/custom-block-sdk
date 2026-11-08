import { expect, it } from 'vitest'

import { connect, Quillow } from '../src/index.js'

it('can be imported without browser globals and rejects connecting without a host', async () => {
  expect(typeof window).toBe('undefined')
  expect(Quillow.getContext()).toBeUndefined()
  await expect(connect()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' })
})
