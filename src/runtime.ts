import { Quillow } from './index.js'

declare global {
  interface Window {
    Quillow: typeof Quillow
  }
}

window.Quillow ??= Quillow

if (window.parent !== window) window.Quillow.start()
