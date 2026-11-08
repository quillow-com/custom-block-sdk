import type { JsonValue } from './types.js'

/** SDK codes are uppercase; backend codes are preserved verbatim, including unknown future codes. */
export type SDKErrorCode =
  | 'HOST_UNAVAILABLE'
  | 'CONNECT_TIMEOUT'
  | 'REQUEST_TIMEOUT'
  | 'PROTOCOL_MISMATCH'
  | 'PROTOCOL_ERROR'
  | 'DISCONNECTED'
  | 'DESTROYED'
  | 'INVALID_ARGUMENT'
  | 'PERMISSION_DENIED'

export class WidgetSDKError extends Error {
  readonly code: string
  readonly details?: JsonValue
  /** True only when a sent mutation might have succeeded without an acknowledged result. */
  readonly mutationMayHaveSucceeded: boolean

  constructor(
    code: string,
    message: string,
    options: { details?: JsonValue; cause?: unknown; mutationMayHaveSucceeded?: boolean } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = 'WidgetSDKError'
    this.code = code
    this.details = options.details
    this.mutationMayHaveSucceeded = options.mutationMayHaveSucceeded ?? false
  }
}

export function invalidArgument(message: string): never {
  throw new WidgetSDKError('INVALID_ARGUMENT', message)
}

export function protocolError(message: string, cause?: unknown): WidgetSDKError {
  return new WidgetSDKError('PROTOCOL_ERROR', message, { cause })
}

export function uncertainMutation(error: WidgetSDKError): WidgetSDKError {
  return new WidgetSDKError(
    error.code,
    `${error.message}. This mutation may already have been saved; do not retry it automatically.`,
    { details: error.details, cause: error, mutationMayHaveSucceeded: true }
  )
}
