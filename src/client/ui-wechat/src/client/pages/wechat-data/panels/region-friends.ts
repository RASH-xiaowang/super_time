/**
 * Friend-region tree helpers shared by the world map avatar rails.
 *
 * Region nodes carry friends on city leaves; the map panel needs the contacts
 * of the whole current subtree at every drill level (世界 / 省 / 市), so this
 * module walks the tree once and deduplicates by username.
 */
import type { RegionFriend, RegionNode } from '@deepseek-ai/dsh-wechat-data/types'

/**
 * Collect every friend in the subtree of a region node, deduplicated by username.
 * @param node - current region node (or the world root when on the world level).
 * @returns the friend list in tree order.
 */
export function collectSubtreeFriends(node: RegionNode | null | undefined): RegionFriend[] {
  const out: RegionFriend[] = []
  const seen = new Set<string>()
  const walk = (n: RegionNode): void => {
    for (const f of n.friends) {
      if (!seen.has(f.username)) {
        seen.add(f.username)
        out.push(f)
      }
    }
    for (const c of n.children) walk(c)
  }
  if (node) walk(node)
  return out
}
