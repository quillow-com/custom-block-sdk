import { describe, expect, it, vi } from 'vitest'

import { WidgetSDKError } from '../src/index.js'
import { snapshotJson } from '../src/json.js'

describe('strict JSON snapshots', () => {
  it.each([null, true, false, 0, 1.25, '', 'hello', [], {}, [null, { a: [1, 'x', false] }]])(
    'accepts JSON data: %j',
    (value) => {
      expect(snapshotJson(value)).toEqual(value)
    }
  )

  const cyclic: unknown[] = []
  cyclic.push(cyclic)
  const sparse = [1, , 3]
  const withExtra = Object.assign([1], { extra: 'lost' })
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 })
  const symbolic = { [Symbol('lost')]: 1 }
  const customPrototype = Object.create({ inherited: 1 }) as unknown

  it.each([
    undefined,
    BigInt(1),
    NaN,
    Infinity,
    -Infinity,
    Symbol('value'),
    () => 1,
    { nested: { missing: undefined } },
    [undefined],
    [NaN],
    new Date(),
    new Map(),
    new Set(),
    new Uint8Array([1]),
    new Number(1),
    /pattern/,
    cyclic,
    sparse,
    withExtra,
    hidden,
    symbolic,
    customPrototype,
  ])('rejects non-JSON or lossy values: %#', (value) => {
    expect(() => snapshotJson(value)).toThrow(WidgetSDKError)
    expect(() => snapshotJson(value)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })

  it('does not invoke getters or toJSON', () => {
    const getter = vi.fn(() => 1)
    const toJSON = vi.fn(() => ({ silently: 'changed' }))

    expect(() =>
      snapshotJson(Object.defineProperty({}, 'a', { enumerable: true, get: getter }))
    ).toThrow()
    expect(() => snapshotJson({ toJSON })).toThrow()
    expect(getter).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
  })

  it('detaches data, permits shared references, and preserves literal __proto__ keys', () => {
    const shared = { enabled: true }
    const value = { a: shared, b: shared, array: [shared] }
    const snapshot = snapshotJson(value)

    shared.enabled = false
    expect(snapshot).toEqual({
      a: { enabled: true },
      b: { enabled: true },
      array: [{ enabled: true }],
    })

    const literal = JSON.parse('{"__proto__":{"polluted":true}}') as unknown
    const result = snapshotJson(literal)

    expect(Object.hasOwn(result as object, '__proto__')).toBe(true)
    expect(JSON.stringify(result)).toBe('{"__proto__":{"polluted":true}}')
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(snapshotJson(Object.assign(Object.create(null) as object, { a: null }))).toEqual({
      a: null,
    })
  })
})
