/** AI 队友面板的 Remote。接口仅桌面 IPC 可用；记忆可进入已开启的 AI回复提示词，显式发送提案会走 Webhook。 */
import { remote, unwrap, type RemoteResult } from './api-core.ts'

export interface AgentControl {
  killed: boolean
  shadow: boolean
  quietStart: string
  quietEnd: string
  cooldownMs: number
  hourCap: number
  dayCap: number
  proactiveHourCap: number
  handoff: boolean
  updatedAt: number
}

export interface AgentDraft {
  id: number
  chatName: string
  targetName: string
  text: string
  error: string
}

export interface AgentMemory {
  id: number
  scope: 'user' | 'conversation'
  scopeKey: string
  kind: string
  text: string
  status: string
}

export interface AgentProposal {
  id: number
  decision: string
  reasonCode: string
  body: string
  status: 'open' | 'accepted' | 'dismissed'
  createdAt: number
}

export interface AgentPromise {
  id: number
  text: string
  dueAt: number
}

export interface AgentAuditEntry {
  id: number
  action: string
  summary: string
  createdAt: number
}

export interface AgentDeskSnapshot {
  control: AgentControl
  memories: AgentMemory[]
  proposals: AgentProposal[]
  promises: AgentPromise[]
  audit: AgentAuditEntry[]
  reconcile: { expected: number; executed: number; skipped: number; delta: number }
  drafts: AgentDraft[]
}

interface AgentDeskRemote {
  getAgentDesk?: () => Promise<RemoteResult<AgentDeskSnapshot>>
  saveAgentControl?: (options: Partial<AgentControl>) => Promise<RemoteResult<AgentControl>>
  writeAgentMemory?: (options: {
    scope: 'user' | 'conversation'
    scopeKey: string
    kind: 'semantic' | 'episode' | 'profile' | 'relation' | 'promise'
    text: string
  }) => Promise<RemoteResult<{ ok: boolean; op: string; error?: string }>>
  deleteAgentMemory?: (options: { id: number }) => Promise<RemoteResult<{ ok: boolean }>>
  addAgentPromise?: (options: { text: string; dueAt: number }) => Promise<RemoteResult<{ ok: boolean }>>
  setAgentProposalStatus?: (options: {
    id: number
    status: 'accepted' | 'dismissed'
  }) => Promise<RemoteResult<{ ok: boolean }>>
  sendAgentDraft?: (options: { id: number }) => Promise<RemoteResult<{ ok: boolean; error?: string }>>
  sendAgentProposal?: (options: { id: number; target: string }) => Promise<RemoteResult<{ ok: boolean; error?: string }>>
}

function client(): AgentDeskRemote {
  return remote() as AgentDeskRemote
}

export async function apiGetAgentDesk(): Promise<AgentDeskSnapshot> {
  const call = client().getAgentDesk
  if (call === undefined) throw new Error('AI 队友接口不可用')
  return unwrap(await call())
}

export async function apiSaveAgentControl(patch: Partial<AgentControl>): Promise<void> {
  const call = client().saveAgentControl
  if (call === undefined) throw new Error('AI 队友接口不可用')
  unwrap(await call(patch))
}

export async function apiWriteAgentMemory(text: string): Promise<void> {
  const call = client().writeAgentMemory
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
  const call = client().deleteAgentMemory
  if (call === undefined) throw new Error('AI 队友接口不可用')
  unwrap(await call({ id }))
}

export async function apiAddAgentPromise(text: string, dueAt: number): Promise<void> {
  const call = client().addAgentPromise
  if (call === undefined) throw new Error('AI 队友接口不可用')
  unwrap(await call({ text, dueAt }))
}

export async function apiSetAgentProposalStatus(id: number, status: 'accepted' | 'dismissed'): Promise<void> {
  const call = client().setAgentProposalStatus
  if (call === undefined) throw new Error('AI 队友接口不可用')
  unwrap(await call({ id, status }))
}

export async function apiSendAgentDraft(id: number): Promise<void> {
  const call = client().sendAgentDraft
  if (call === undefined) throw new Error('AI 队友接口不可用')
  const result = unwrap(await call({ id }))
  if (!result.ok) throw new Error(result.error ?? '草稿没有发出')
}

export async function apiSendAgentProposal(id: number, target: string): Promise<void> {
  const call = client().sendAgentProposal
  if (call === undefined) throw new Error('AI 队友接口不可用')
  const result = unwrap(await call({ id, target }))
  if (!result.ok) throw new Error(result.error ?? '提案没有发出')
}
