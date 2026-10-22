/**
 * 问答目录缓存：已知实体名与会话 username/显示名映射。
 *
 * 两类查询共用同一个数据源和失效口径（解密目录），但返回形状不同。
 * 读取失败按空目录缓存，问答仍可继续，不影响主链路。
 *
 * @module gateway-ask-catalog
 */
import { knownEntityNames, knownSessionCatalog } from './query/search.ts'

export interface AskSessionCatalogEntry {
  username: string
  name: string
}

export class AskCatalogCache {
  private readonly entities = new Map<string, string[]>()
  private readonly sessions = new Map<string, AskSessionCatalogEntry[]>()

  public constructor(private readonly currentDirectory: () => string) {}

  private cached<T>(cache: Map<string, T[]>, load: (directory: string) => T[]): T[] {
    const directory = this.currentDirectory()
    const hit = cache.get(directory)
    if (hit) return hit
    let values: T[] = []
    try {
      values = load(directory)
    } catch {
      values = []
    }
    cache.set(directory, values)
    return values
  }

  /** 问答点名识别用的联系人/会话名称。 */
  public entitiesForCurrentDirectory(): string[] {
    return this.cached(this.entities, knownEntityNames)
  }

  /** 工具参数解析用的 username → 显示名目录。 */
  public sessionsForCurrentDirectory(): AskSessionCatalogEntry[] {
    return this.cached(this.sessions, knownSessionCatalog)
  }
}
