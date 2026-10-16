// @vitest-environment node
/**
 * Whisper 模型/引擎下载的 jobId 接线守卫。
 *
 * 钉的是那个「没有运行时错误、却让取消永远打不到正确任务」的形状：jobId 放进
 * React state 后，同一渲染闭包里读到的仍是旧值。下载/安装发给后端的 jobId 必须
 * 是刚生成的局部值，而取消按钮读的槽位要能立即反映这个值。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStripped, sliceBetween } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const state = readStripped(join(HERE, 'settings-state.tsx'))
const download = sliceBetween(state, 'const whisperDownload = ', '\n  const batchTranscribe', 'whisperDownload 回调体')
const install = sliceBetween(state, 'const installEngine = ', '\n  const save = ', 'installEngine 回调体')

describe('Whisper 下载 jobId 接线', () => {
  it('jobId 是 ref，而不是渲染 state（setState 的提交是异步的）', () => {
    expect(state).toMatch(/const whisperJobId = useRef\(''\)/)
    expect(state, 'jobId 槽位没有改回异步的 useState').not.toMatch(/const \[whisperJobId, setWhisperJobId\] = useState/)
    expect(state, 'jobId 的 state 更新器不应继续存在').not.toContain('setWhisperJobId')
    expect(state, '下载完成后必须归还 ref 槽位').toMatch(/whisperJobId\.current = ''/)
  })

  it('模型下载把同一个局部 jobId 写入槽位并发给后端', () => {
    expect(download, '快速双击时不能绕过异步渲染状态再开一个任务').toContain('if (whisperDownloading || whisperJobId.current)')
    expect(download).toMatch(/const jobId = `whisper-\$\{String\(\(whisperJobSeq\.current \+= 1\)\)\}`/)
    expect(download).toContain('whisperJobId.current = jobId')
    expect(download, 'API 调用没有使用本轮局部 jobId').toContain('apiDownloadWhisperModel({ model: m.id, jobId })')
    expect(download, 'API 调用还在读旧的渲染闭包 state').not.toContain('apiDownloadWhisperModel({ model: m.id, jobId: whisperJobId })')
  })

  it('引擎安装也使用同一个局部 jobId', () => {
    expect(install, '快速双击时不能绕过异步渲染状态再开一个任务').toContain('if (whisperDownloading || whisperJobId.current)')
    expect(install).toMatch(/const jobId = `whisper-\$\{String\(\(whisperJobSeq\.current \+= 1\)\)\}`/)
    expect(install).toContain('whisperJobId.current = jobId')
    expect(install, '安装 API 没有使用本轮局部 jobId').toContain('apiInstallWhisperEngine({ jobId })')
    expect(install, '安装 API 还在读旧的渲染闭包 state').not.toContain('apiInstallWhisperEngine({ jobId: whisperJobId })')
  })

  it('取消按钮读取 ref 的当前值，且两路 finally 都会归还槽位', () => {
    expect(state).toContain('whisperDownloadCanceller(() => whisperJobId.current, setWhisperDirMsg)')
    expect(download).toMatch(/finally \{[\s\S]{0,120}whisperJobId\.current = ''/)
    expect(install).toMatch(/finally \{[\s\S]{0,120}whisperJobId\.current = ''/)
  })
})
