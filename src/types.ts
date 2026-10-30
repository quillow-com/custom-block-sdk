export interface BlockContext {
  readonly theme: {
    readonly mode: 'light' | 'dark'
    readonly cornerStyle: 'Normal' | 'Pill' | 'Sharp'
    readonly variables: Readonly<Record<string, string>>
    /** Absolute stylesheet URL; null uses the block's own fonts. */
    readonly fontStylesheet: string | null
  }
  readonly layout: {
    /** Grid columns:rows, not the pixel aspect ratio. */
    readonly size: '1:1' | '2:1' | '2:2'
    readonly width: number
    readonly height: number
    readonly viewport: 'mobile' | 'desktop'
  }
  readonly environment: 'editor' | 'published'
}
