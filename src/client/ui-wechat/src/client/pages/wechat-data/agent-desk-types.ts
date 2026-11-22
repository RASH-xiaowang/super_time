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

