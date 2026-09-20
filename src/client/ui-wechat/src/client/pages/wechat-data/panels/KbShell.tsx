/**
 * 知识库外壳 —— 三栏布局的**外层两栏**：库 rail + 「分段条 / 面板体」。
 *
 * 为什么单独一个组件而不是把 rail 直接塞进 `MergedSections`：`MergedSections` 是通用的
 * （「通讯录|社交图谱」「收藏与表情」等七组共用），给它加一个知识库专属的左栏会把通用外壳
 * 变成特例容器。库 rail 是知识库这一组的事，所以包在这一组外面。
 *
 * rail 跨三个分段常驻：库是**作用域**（看哪一份数据），笔记库 / 知识图谱 / 文件是同一份
 * 数据的三种**看法**，三者共用同一个「当前库」。放在分段条上（旧写法）时它只能显示一个库名，
 * 抬到这一栏后才能同时看见「有几个库、各自多少条、现在在哪个」。
 *
 * 窄容器（< 900px）下 rail 收成顶部的横向 chip 条 —— 判据用**容器查询**而不是窗口媒体查询：
 * 侧栏折叠会改变本区域的可用宽度而窗口尺寸不变，媒体查询在那种情况下不触发。
 * 退化规则写在 `kb-rail.module.css` 里（`.rail` 的定义处），因为 CSS Module 的类名按文件哈希，
 * 跨文件选不中。
 */
import { GraphPanel } from './Graph.tsx'
import { KbFilesPanel } from './KbFiles.tsx'
import { KbRail } from './KbRail.tsx'
import { KnowledgeBasePanel } from './KnowledgeBase.tsx'
import { MergedSections } from './MergedSections.tsx'
import css from './kb-shell.module.css'

/**
 * @param props - 当前深链落到的分段，与两个跨面板回调。
 * @returns 知识库三栏外壳。
 */
export function KbShell({ initial, onOpenChat, focusFileId, focusNonce }: {
  /** = 当前 tab（`kb` / `knowledge` / `kbfiles`），决定初始分段。 */
  initial: string
  /** 打开来源会话：问答沉淀而来的笔记要能跳回去。 */
  onOpenChat: (username: string, localId?: number) => void
  /** 从聊天里的文件卡片跳过来时要选中并滚到的那个文件。 */
  focusFileId?: number | null
  /** 与 `focusFileId` 配对的 nonce：同一个文件第二次点进来也要重新聚焦一次。 */
  focusNonce?: number
}): React.JSX.Element {
  /**
   * 侧栏「知识库」那条目的 tab 是 `kb`，但它的**默认落点是文件**，不是与它同名的笔记库分段：
   * 进来先看原料（导入的文件），笔记与图谱是在其上加工出来的两读法。
   * `#kbfiles` / `#knowledge` 两个深链仍各自直达自己的分段。
   */
  const landing = initial === 'kb' ? 'kbfiles' : initial
  return (
    <div className={css.wrap}>
      <div className={css.shell}>
        <KbRail />
        <div className={css.main}>
          <MergedSections
            ariaLabel="知识库视图"
            initial={landing}
            sections={[
              // 2026-09-19 顺序改成 **文件 · 笔记库 · 知识图谱**，按「原料 → 加工 → 总览」排：
              // 文件是进来的资料，笔记是你在这些资料之上写的东西，图谱是写完之后的结构总览。
              //
              // 但**笔记库与知识图谱必须相邻**，不能被文件插开：这两段是同一批笔记
              // （同一个 `wechat_notes.db` 的 notes 表）的两种看法 —— 文档视图与网络视图。
              // 「知识图谱」不是一种独立内容，而是「笔记库」换个读法；中间插一段文件，
              // 这层关系就读不出来了（这也是 2026-09-18 把它们并进同一个导航项的理由）。
              //
              // 侧栏「知识库」经 `landing` 落在**第一段**（文件）上：默认面与左起第一段
              // 从此是同一个，不再需要「惯例 vs 最常用」那套取舍。
              { key: 'kbfiles', label: '文件', render: () => <KbFilesPanel focusFileId={focusFileId ?? null} focusNonce={focusNonce ?? 0} /> },
              { key: 'kb', label: '笔记库', render: () => <KnowledgeBasePanel onOpenChat={onOpenChat} /> },
              { key: 'knowledge', label: '知识图谱', render: () => <GraphPanel variant="knowledge" onOpenChat={onOpenChat} /> },
            ]}
          />
        </div>
      </div>
    </div>
  )
}
