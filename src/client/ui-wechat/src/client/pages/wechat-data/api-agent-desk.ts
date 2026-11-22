/** AI 队友面板的 Remote。接口仅桌面 IPC 可用；记忆可进入已开启的 AI回复提示词，显式发送提案会走 Webhook。 */
import { remote, unwrap } from './api-core.ts'

export type * from './agent-desk-types.ts'
import type { AgentControl, AgentDeskSnapshot } from './agent-desk-types.ts'

export async function apiGetAgentDesk(): Promise<AgentDeskSnapshot> {
  const call = remote().getAgentDesk
  if (call === undefined) throw new Error('AI 队友接口不可用')
  return unwrap(await call())
}

export async function apiSaveAgentControl(patch: Partial<AgentControl>): Promise<void> {
  const call = remote().saveAgentControl
  if (call === undefined) throw new Error('AI 队友接口不可用')
  unwrap(await call(patch))
}

export async function apiWriteAgentMemory(text: string): Promise<void> {
  const call = remote().writeAgentMemory
  if (call === undefined) throw new Error('AI 队友接口不可用')
  const result = unwrap(await call({
    scope: 'user',
    scopeKey: 'self',
    kind: 'semantic',
    text,
  }))
  if (!result.ok) throw new Error(result.error ?? '记忆没有写入')
}

export async function apiDeleteAgentMemory(id: number): Promise<void> {
  const call = remote().deleteAgentMemory
  if (call === undefined) throw new Error('AI 队友接口不可用')
  if (!unwrap(await call({ id })).ok) throw new Error('记忆没有删除')
}

export async function apiAddAgentPromise(text: string, dueAt: number): Promise<void> {
  const call = remote().addAgentPromise
  if (call === undefined) throw new Error('AI 队友接口不可用')
  if (!unwrap(await call({ text, dueAt })).ok) throw new Error('承诺没有保存')
}

export async function apiSetAgentProposalStatus(id: number, status: 'accepted' | 'dismissed'): Promise<void> {
  const call = remote().setAgentProposalStatus
  if (call === undefined) throw new Error('AI 队友接口不可用')
  if (!unwrap(await call({ id, status })).ok) throw new Error('提案状态没有更新')
}

export async function apiSendAgentDraft(id: number): Promise<void> {
  const call = remote().sendAgentDraft
  if (call === undefined) throw new Error('AI 队友接口不可用')
  const result = unwrap(await call({ id }))
  if (!result.ok) throw new Error(result.error ?? '草稿没有发出')
}

export async function apiSendAgentProposal(id: number, target: string): Promise<void> {
  const call = remote().sendAgentProposal
  if (call === undefined) throw new Error('AI 队友接口不可用')
  const result = unwrap(await call({ id, target }))
  if (!result.ok) throw new Error(result.error ?? '提案没有发出')
}
