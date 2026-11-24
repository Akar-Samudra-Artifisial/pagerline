/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Pagerline server origin, e.g. http://localhost:3300. Empty → mock data. */
  readonly VITE_API_BASE?: string
  /** "1" forces built-in mock alerts. */
  readonly VITE_MOCK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
