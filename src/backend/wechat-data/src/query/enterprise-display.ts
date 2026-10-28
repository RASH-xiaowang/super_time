import type { ChatlogRecord, FavItemPart } from '../types.ts'

/** Contact metadata indexes used only for display-time enterprise suffixes. */
export interface EnterpriseDisplayIndex {
  byUsername: ReadonlyMap<string, string>
  byDisplayName: ReadonlyMap<string, string>
}

/** Build a display index without guessing when a display name is ambiguous. */
export function createEnterpriseDisplayIndex(
  contactNames: ReadonlyMap<string, string>,
  enterpriseNames: ReadonlyMap<string, string>,
): EnterpriseDisplayIndex {
  const byUsername = new Map<string, string>()
  for (const [username, raw] of enterpriseNames) {
    const enterpriseName = raw.trim()
    if (username.trim() !== '' && enterpriseName !== '') byUsername.set(username, enterpriseName)
  }

  const byDisplayName = new Map<string, string>()
  const conflicts = new Set<string>()
  for (const [username, enterpriseName] of byUsername) {
    const displayName = contactNames.get(username)?.trim() ?? ''
    if (displayName === '') continue
    const previous = byDisplayName.get(displayName)
    if (previous !== undefined && previous !== enterpriseName) conflicts.add(displayName)
    else byDisplayName.set(displayName, enterpriseName)
  }
  for (const displayName of conflicts) byDisplayName.delete(displayName)
  return { byUsername, byDisplayName }
}

/** Resolve an enterprise name only from a username, or from a unique display name. */
export function enterpriseNameFor(
  index: EnterpriseDisplayIndex,
  username?: string,
  displayName?: string,
): string | undefined {
  const user = username?.trim() ?? ''
  if (user !== '') return index.byUsername.get(user)
  const display = displayName?.trim() ?? ''
  return display === '' ? undefined : index.byDisplayName.get(display)
}

/** Enrich merged chat-log senders recursively for display only. */
export function withChatlogEnterprise(
  records: readonly ChatlogRecord[],
  index: EnterpriseDisplayIndex,
): ChatlogRecord[] {
  return records.map((record) => {
    const enterpriseName = enterpriseNameFor(index, record.sourceUsername, record.name)
    const nested = record.nested === undefined ? undefined : withChatlogEnterprise(record.nested, index)
    if (enterpriseName === undefined && nested === undefined) return record
    return {
      ...record,
      ...(enterpriseName === undefined ? {} : { enterpriseName }),
      ...(nested === undefined ? {} : { nested }),
    }
  })
}

/** Enrich favorite chat-log senders for display only. */
export function withFavoritePartEnterprise(
  parts: readonly FavItemPart[],
  index: EnterpriseDisplayIndex,
): FavItemPart[] {
  return parts.map((part) => {
    const enterpriseName = enterpriseNameFor(index, part.sourceUsername, part.sourceName)
    return enterpriseName === undefined ? part : { ...part, sourceEnterpriseName: enterpriseName }
  })
}
