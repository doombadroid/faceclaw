import type { Page } from '@nativescript/core'
import { groupedPage, section } from './ui-kit'

/** A titled placeholder for a page that has not been built yet. */
export function stubPage(title: string): () => Page {
  return () => groupedPage({ title, build: container => container.addChild(section({ footer: 'Not built yet.', rows: [] })) }).page
}
