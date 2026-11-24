import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { Page } from './screens/layout'

/**
 * Serializes all bridge writes: the first page goes through
 * createStartUpPageContainer, later layouts through rebuildPageContainer.
 */
export class Renderer {
  private started = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly bridge: EvenAppBridge) {}

  show(page: Page): Promise<void> {
    return this.enqueue(async () => {
      const containerTotalNum = page.textObject.length + (page.listObject?.length ?? 0)
      const spec = { containerTotalNum, textObject: page.textObject, listObject: page.listObject }
      if (!this.started) {
        const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(spec))
        if (result !== 0) {
          // A WebView reload (e.g. dev HMR) keeps the host's page alive, so the
          // startup call is refused; fall back to rebuilding that page.
          const rebuilt = await this.bridge.rebuildPageContainer(new RebuildPageContainer(spec))
          if (!rebuilt) throw new Error(`createStartUpPageContainer failed (${String(result)})`)
        }
        this.started = true
        return
      }
      const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(spec))
      if (!ok) throw new Error('rebuildPageContainer returned false')
    })
  }

  /** In-place text update; id AND name must match a live container or the call is a silent no-op. */
  upgrade(target: { id: number; name: string }, content: string): Promise<void> {
    return this.enqueue(async () => {
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: target.id, containerName: target.name, content }),
      )
    })
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task)
    this.queue = next.catch((err: unknown) => console.error('[pagerline] render failed:', err))
    return next
  }
}
