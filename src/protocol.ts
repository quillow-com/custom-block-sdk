import type { BlockContext } from './types.js'

export const PROTOCOL = 'quillow:custom-block'
export const VERSION = 1

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isMessage(value: unknown, type: string): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.protocol === PROTOCOL &&
    value.version === VERSION &&
    value.type === type
  )
}

export function isContext(value: unknown): value is BlockContext {
  if (!isRecord(value) || !isRecord(value.theme) || !isRecord(value.layout)) return false

  const { theme, layout } = value

  return (
    ['editor', 'published'].includes(value.environment as string) &&
    ['light', 'dark'].includes(theme.mode as string) &&
    ['Normal', 'Pill', 'Sharp'].includes(theme.cornerStyle as string) &&
    isRecord(theme.variables) &&
    Object.entries(theme.variables).every(
      ([key, val]) => /^--quillow-[a-z0-9-]+$/.test(key) && typeof val === 'string'
    ) &&
    (theme.fontStylesheet === null ||
      (typeof theme.fontStylesheet === 'string' && isHttpUrl(theme.fontStylesheet))) &&
    ['1:1', '2:1', '2:2'].includes(layout.size as string) &&
    ['mobile', 'desktop'].includes(layout.viewport as string) &&
    typeof layout.width === 'number' &&
    Number.isFinite(layout.width) &&
    layout.width >= 0 &&
    typeof layout.height === 'number' &&
    Number.isFinite(layout.height) &&
    layout.height >= 0
  )
}

export function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

export function message(type: string, context?: BlockContext) {
  return { protocol: PROTOCOL, version: VERSION, type, ...(context ? { context } : {}) }
}
