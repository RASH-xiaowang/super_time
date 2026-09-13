/**
 * 启动页完成状态：localStorage 持久化。
 *
 * 首次启动（无记录）必须完整浏览四页后才能进入主界面；
 * 再次启动时 completed=true，可跳过。
 */
export type OnboardingPageId = 'home' | 'features' | 'help' | 'about'

export const ONBOARDING_PAGES: ReadonlyArray<{ id: OnboardingPageId; label: string }> = [
  { id: 'home', label: '首页' },
  { id: 'features', label: '功能引导' },
  { id: 'help', label: '使用说明' },
  { id: 'about', label: '关于' },
]

export const ONBOARDING_STORAGE_KEY = 'super-time-onboarding-v1'

export interface OnboardingState {
  completed: boolean
  visited: OnboardingPageId[]
  completedAt?: string
}

function emptyState(): OnboardingState {
  return { completed: false, visited: [] }
}

export function loadOnboardingState(): OnboardingState {
  try {
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw) as Partial<OnboardingState>
    const visited = Array.isArray(parsed.visited)
      ? parsed.visited.filter((v): v is OnboardingPageId =>
          ONBOARDING_PAGES.some((p) => p.id === v))
      : []
    return {
      completed: parsed.completed === true,
      visited,
      completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : undefined,
    }
  } catch {
    return emptyState()
  }
}

export function saveOnboardingState(state: OnboardingState): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* 持久化失败不阻塞当前会话 */
  }
}

export function markPageVisited(state: OnboardingState, id: OnboardingPageId): OnboardingState {
  if (state.visited.includes(id)) return state
  return { ...state, visited: [...state.visited, id] }
}

export function allPagesVisited(state: OnboardingState): boolean {
  return ONBOARDING_PAGES.every((p) => state.visited.includes(p.id))
}

export function completeOnboarding(state: OnboardingState): OnboardingState {
  const next: OnboardingState = {
    ...state,
    completed: true,
    visited: ONBOARDING_PAGES.map((p) => p.id),
    completedAt: new Date().toISOString(),
  }
  saveOnboardingState(next)
  return next
}

/** 调试用：重置启动页状态（强制再次首启流程）。 */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
