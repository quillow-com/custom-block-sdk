import { invalidArgument, WidgetSDKError } from './errors.js'
import type { JsonValue } from './types.js'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

/** Reject lossy JSON conversions without invoking getters or toJSON, and take a detached snapshot. */
export function snapshotJson(value: unknown): JsonValue {
  const ancestors = new Set<object>()
  const visit = (input: unknown): JsonValue => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (typeof input !== 'object' || input === null)
      return invalidArgument('Storage values must contain only finite numbers and plain JSON data')

    const array = Array.isArray(input)

    if (array ? Object.getPrototypeOf(input) !== Array.prototype : !isPlainObject(input))
      return invalidArgument(
        'Storage values must use plain objects and arrays, not class instances'
      )
    if (ancestors.has(input)) return invalidArgument('Storage values must not contain cycles')

    ancestors.add(input)

    const descriptors = Object.getOwnPropertyDescriptors(input)
    const keys = Reflect.ownKeys(descriptors)
    const result: JsonValue[] | Record<string, JsonValue> = array ? [] : {}

    if (array && keys.length !== input.length + 1)
      return invalidArgument('Storage arrays must not contain holes or extra properties')

    for (const key of keys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string')
        return invalidArgument('Storage objects must not contain symbol properties')

      const descriptor = descriptors[key]!

      if (!descriptor.enumerable || !('value' in descriptor))
        return invalidArgument(
          'Storage values must not contain getters or non-enumerable properties'
        )
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length))
        return invalidArgument('Storage arrays must not contain extra properties')

      // Defining rather than assigning also preserves the literal JSON key "__proto__".
      Object.defineProperty(result, key, {
        value: visit(descriptor.value),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    ancestors.delete(input)

    return result
  }

  try {
    return visit(value)
  } catch (error) {
    if (error instanceof WidgetSDKError) throw error
    throw new WidgetSDKError('INVALID_ARGUMENT', 'Unable to read the JSON value safely', {
      cause: error,
    })
  }
}

export function readOptions(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) return invalidArgument('Options must be a plain object')

  const result = Object.create(null) as Record<string, unknown>

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!

    if (typeof key !== 'string' || !allowed.includes(key) || !('value' in descriptor))
      return invalidArgument('Options contain an unknown property or getter')

    result[key] = descriptor.value
  }

  return result
}
