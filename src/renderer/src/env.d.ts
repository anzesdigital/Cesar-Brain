/// <reference types="vite/client" />
import type { BrainApi } from '@shared/types'

declare global {
  interface Window {
    brain: BrainApi
  }
}
