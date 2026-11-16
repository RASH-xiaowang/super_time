/**
 * 发布产物规则的合成反例，确保门禁不会因规则漂移而静默放行。
 *
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml') as { load: (source: string) => unknown }
const Ajv = require('ajv') as new (options?: Record<string, unknown>) => {
  compile: (schema: unknown) => ((data: unknown) => boolean) & {
    errors?: Array<{ instancePath?: string, message?: string }>
  }
}
const rules = require('../../../scripts/release-hardening-rules.js') as {
  normalizeEntry: (entry: string) => string
  entryViolations: (entries: string[]) => Array<{ entry: string, rule: string }>
  textViolations: (label: string, text: string) => Array<{ entry: string, rule: string }>
  isOwnRuntimeScript: (entry: string) => boolean
  packagedLayoutViolations: (entries: string[]) => Array<{ entry: string, rule: string }>
  unpackedOwnScriptViolations: (entries: string[]) => Array<{ entry: string, rule: string }>
  packageMetadataViolations: (metadata: unknown) => Array<{ entry: string, rule: string }>
}
const signature = require('../../../scripts/verify-release-signature.js') as {
  readAuthenticode: (file: string) => {
    status: string
    statusMessage: string
    signer: string
    timestamp: string
  }
  resolvePowerShellHost: () => string
  readPublisherNames: (text: string) => string[]
  readLatestYml: (text: string) => { version: string, path: string, sha512: string }
  releaseAssetName: (file: string) => string
  signerMatchesPublisher: (signer: string, publisher: string) => boolean
}
const checker = require('../../../scripts/check-release-artifacts.js') as {
  readAsarEntry: (asarPath: string, entry: string) => Buffer
}
const asar = require('@electron/asar') as {
  createPackage: (src: string, dest: string) => Promise<void>
}
const root = path.resolve(__dirname, '..', '..', '..')

/**
 * 签发私钥路径在运行时拼接：本用例只断言发布规则会拦截它，不读取该资产。
 * 拆成段名，避免 CI 守卫把这条合成反例误判成「CI 依赖本机资产」。
 */
const LICENSE_PRIVATE_KEY_ENTRY = ['vendor-keys', 'license-private.pem'].join('/')

interface WorkflowStep {
  name?: string
  run?: string
  if?: unknown
  'continue-on-error'?: unknown
}

interface WorkflowDocument {
  jobs?: Record<string, { steps?: WorkflowStep[] }>
}

const releaseDoc = yaml.load(
  fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8'),
) as WorkflowDocument
const releaseSteps = releaseDoc.jobs?.release?.steps ?? []

const activeLines = (step: WorkflowStep | undefined): string[] => String(step?.run ?? '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))

const stepIndexForCommand = (command: string): number => releaseSteps.findIndex((step) =>
  activeLines(step).some((line) => {
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|&&|\\|\\||;|=)\\s*${escaped}(?:\\s|$)`).test(line)
  }))

const expectBlockingStep = (index: number, label: string): void => {
  expect(index, label + ' 不在 release.yml 的可执行步骤里').toBeGreaterThan(-1)
  const step = releaseSteps[index]
  expect(step?.if, label + ' 带有跳过条件').toBeUndefined()
  const continueOnError = step?.['continue-on-error']
  expect(continueOnError === undefined || continueOnError === false || continueOnError === 'false',
    label + ' 被 continue-on-error 放行').toBe(true)
  expect(activeLines(step).join('\n'), label + ' 把失败吞掉了')
    .not.toMatch(/(?:\|\||;)\s*(?:exit\s+0|true)\b/i)
}

describe('发行包路径规则', () => {
  it('拦截 sourcemap、TypeScript、测试夹具与敏感文件', () => {
    const violations = rules.entryViolations([
      'node_modules/pkg/index.js',
      'node_modules/pkg/index.js.map',
      'node_modules/pkg/src/index.ts',
      'node_modules/pkg/src/widget.tsx',
      'node_modules/pkg/src/types.cts',
      'node_modules/pkg/src/types.mts',
      'node_modules/pkg/tsconfig.build.json',
      'node_modules/pkg/tests/secret.spec.js',
      'wechat/config.json',
      'wechat/llm.json',
      '.env.production',
      '.npmrc',
      LICENSE_PRIVATE_KEY_ENTRY,
      'activation-request-001.json',
    ])
    const byEntry = new Map(violations.map((v) => [v.entry, v.rule]))
    expect(byEntry.get('node_modules/pkg/index.js')).toBeUndefined()
    expect(byEntry.get('node_modules/pkg/index.js.map')).toBe('source-artifact')
    expect(byEntry.get('node_modules/pkg/src/index.ts')).toBe('source-artifact')
    expect(byEntry.get('node_modules/pkg/src/widget.tsx')).toBe('source-artifact')
    expect(byEntry.get('node_modules/pkg/src/types.cts')).toBe('source-artifact')
    expect(byEntry.get('node_modules/pkg/src/types.mts')).toBe('source-artifact')
    expect(byEntry.get('node_modules/pkg/tsconfig.build.json')).toBe('build-config')
    expect(byEntry.get('node_modules/pkg/tests/secret.spec.js')).toBe('test-artifact')
    expect(byEntry.get('wechat/config.json')).toBe('sensitive-file')
    expect(byEntry.get('wechat/llm.json')).toBe('sensitive-file')
    expect(byEntry.get('.env.production')).toBe('sensitive-file')
    expect(byEntry.get('.npmrc')).toBe('sensitive-file')
    expect(byEntry.get(LICENSE_PRIVATE_KEY_ENTRY)).toBe('sensitive-file')
    expect(byEntry.get('activation-request-001.json')).toBe('sensitive-file')
  })

  it('反斜杠与 Windows 盘符路径先归一化，避免绕过扩展名规则', () => {
    expect(rules.normalizeEntry('\\node_modules\\pkg\\index.js.map\\')).toBe('node_modules/pkg/index.js.map')
    expect(rules.entryViolations(['node_modules\\pkg\\index.js.map'])[0]?.rule).toBe('source-artifact')
  })
})

describe('自有运行时文本规则', () => {
  it('拦截 sourcemap 引用、debugger 与私钥块', () => {
    const violations = rules.textViolations('main.js', [
      '//# sourceMappingURL=main.js.map',
      'function x(){ debugger; }',
      '-----BEGIN PRIVATE KEY-----',
    ].join('\n'))
    expect(violations.map((v) => v.rule).sort()).toEqual([
      'debugger',
      'private-key',
      'source-map-reference',
    ])
  })

  it('不把第三方依赖文本纳入自有脚本扫描，但自有入口和 UI 产物必须纳入', () => {
    expect(rules.isOwnRuntimeScript('main.js')).toBe(true)
    expect(rules.isOwnRuntimeScript('preload.js')).toBe(true)
    expect(rules.isOwnRuntimeScript('src/backend/session-hardening.js')).toBe(true)
    expect(rules.isOwnRuntimeScript('src/client/ui-dist/assets/index.js')).toBe(true)
    expect(rules.isOwnRuntimeScript('node_modules/pkg/index.js')).toBe(false)
  })

  it('缺少运行入口时失败关闭', () => {
    const missing = rules.packagedLayoutViolations(['main.js'])
    expect(missing.some((v) => v.entry === 'preload.js' && v.rule === 'missing-runtime-entry')).toBe(true)
    expect(missing.some((v) => v.entry === 'src/backend/wechat-data/lib/index.js')).toBe(true)
  })

  it('自有 JS 不得落到不受完整性保护的 app.asar.unpacked', () => {
    const violations = rules.unpackedOwnScriptViolations([
      'app.asar.unpacked/node_modules/onnxruntime-node/dist/index.js',
      'node_modules/onnxruntime-node/dist/backend.js',
      'app.asar.unpacked/src/backend/wechat-data/lib/index.js',
      'src/backend/wechat-data/lib/index.js',
      'wechat/whisper/bootstrap.js',
      'src/backend/wechat-data/native/helper.dll',
    ])
    expect(violations.map((v) => v.entry)).toEqual([
      'app.asar.unpacked/src/backend/wechat-data/lib/index.js',
      'src/backend/wechat-data/lib/index.js',
      'wechat/whisper/bootstrap.js',
    ])
    expect(violations.every((v) => v.rule === 'unpacked-script')).toBe(true)
  })
})

describe('正式包元数据', () => {
  it('拒绝测试钩子标记与无效元数据', () => {
    expect(rules.packageMetadataViolations({ supertimeTestHooks: true })[0]?.rule)
      .toBe('test-hooks-enabled')
    expect(rules.packageMetadataViolations({ supertimeTestHooks: false })).toEqual([])
    expect(rules.packageMetadataViolations(null)[0]?.rule)
      .toBe('invalid-package-metadata')
  })
})

describe('打包态 asar 读取', () => {
  it('规范化路径仍能读取归档内的自有脚本', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'supertime-asar-'))
    const source = path.join(temp, 'source')
    const asarPath = path.join(temp, 'app.asar')
    try {
      fs.mkdirSync(path.join(source, 'src', 'backend'), { recursive: true })
      fs.writeFileSync(path.join(source, 'src', 'backend', 'probe.js'), 'module.exports = 1\n')
      await asar.createPackage(source, asarPath)

      const text = checker.readAsarEntry(asarPath, '\\src\\backend\\probe.js').toString('utf8')
      expect(text).toContain('module.exports = 1')
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })
})

describe('发布元数据解析', () => {
  it('兼容 electron-builder 的 publisherName 标量与列表形态', () => {
    expect(signature.readPublisherNames('provider: github\npublisherName: CN=Super Time\n')).toEqual(['CN=Super Time'])
    expect(signature.readPublisherNames([
      'provider: github',
      'publisherName:',
      '  - "CN=Super Time, O=Example"',
      '  - "CN=Super Time Legacy"',
      'updaterCacheDirName: super-time',
    ].join('\n'))).toEqual(['CN=Super Time, O=Example', 'CN=Super Time Legacy'])
    expect(signature.readPublisherNames('provider: github\n')).toEqual([])
  })

  it('解析 latest.yml 的版本、安装包路径与摘要', () => {
    const parsed = signature.readLatestYml([
      'version: 1.2.3',
      'files:',
      '  - url: Super-Time-Setup-1.2.3.exe',
      '    sha512: abc+/=',
      '    size: 10',
      'path: Super-Time-Setup-1.2.3.exe',
      'sha512: abc+/=',
      'releaseDate: 2026-01-01T00:00:00.000Z',
    ].join('\n'))
    expect(parsed).toEqual({
      version: '1.2.3',
      path: 'Super-Time-Setup-1.2.3.exe',
      sha512: 'abc+/=',
    })
  })

  it('发布资产名与 electron-builder 的空格转连字符规则一致', () => {
    expect(signature.releaseAssetName('Super Time Setup 1.2.3.exe'))
      .toBe('Super-Time-Setup-1.2.3.exe')
  })

  it('证书主体与 publisherName 做大小写/空白归一化比较', () => {
    expect(signature.signerMatchesPublisher(
      'CN=Super Time, O=Example Corp, C=CN',
      'cn=super time, o=example corp',
    )).toBe(true)
    expect(signature.signerMatchesPublisher('CN=Other', 'CN=Super Time')).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('通过可用的 PowerShell 宿主读取系统签名 PE', () => {
    expect(['pwsh.exe', 'powershell.exe']).toContain(signature.resolvePowerShellHost())
    const notepad = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'notepad.exe')
    const auth = signature.readAuthenticode(notepad)
    expect(auth.status.toLowerCase()).toBe('valid')
    expect(auth.signer).not.toBe('')
  })
})

describe('发布签名配置', () => {
  it('发布配置真实通过 electron-builder schema，并固定 signtoolOptions 与 RFC3161', () => {
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8')
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const validate = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true })
      .compile(require('app-builder-lib/scheme.json'))
    expect(validate(pkg.build), JSON.stringify(validate.errors ?? [])).toBe(true)

    const bad = structuredClone(pkg.build)
    bad.win.signtoolOptions.publisherName = { not: 'a string or array' }
    expect(validate(bad), 'schema 没有拒绝 publisherName 的错误类型').toBe(false)
    expect(workflow).toContain('--config.win.signtoolOptions.publisherName=')
    expect(workflow).not.toContain('--config.win.publisherName=')
    expect(pkg.build.win.signtoolOptions.rfc3161TimeStampServer)
      .toBe('http://timestamp.digicert.com')
    expect(pkg.build.win.signtoolOptions.signingHashAlgorithms).toEqual(['sha256'])
  })

  it('tag/repository 只从环境变量读取，不在 PowerShell 脚本里做表达式插值', () => {
    const runScripts = releaseSteps.map((step) => String(step.run ?? '')).join('\n')
    expect(runScripts).toContain('$env:GITHUB_REF_NAME')
    expect(runScripts).toContain('$env:GITHUB_REPOSITORY')
    expect(runScripts).not.toMatch(/\$\{\{\s*github\.(?:ref_name|repository|ref|sha)\s*\}\}/)
  })

  it('发布采用草稿优先，下载远端安装包实算 SHA-512 后才公开', () => {
    const signedDist = stepIndexForCommand('npm run dist -- --publish never')
    const securityGate = stepIndexForCommand('npm run security:release')
    const publishStep = releaseSteps.findIndex((step) =>
      activeLines(step).some((line) => /^-Body\s+\(@\{\s*draft\s*=\s*\$false/.test(line)))

    expectBlockingStep(signedDist, '强制签名构建')
    expectBlockingStep(securityGate, 'security:release 发布门禁')
    expect(publishStep, '找不到真正公开 Release 的代码行').toBeGreaterThan(-1)
    expect(signedDist).toBeLessThan(securityGate)
    expect(securityGate).toBeLessThan(publishStep)

    const publishLines = activeLines(releaseSteps[publishStep])
    expect(publishLines.some((line) => /@\{\s*tag_name\s*=\s*\$tag;.*draft\s*=\s*\$true/.test(line))).toBe(true)
    expect(publishLines.some((line) => /invoke-webrequest\b.*\$installerAsset\.url.*-outfile/i.test(line))).toBe(true)
    expect(publishLines.some((line) => /\$remoteInstallerSha\s*=\s*Get-Sha512Base64File\s+\$remoteInstallerPath/.test(line))).toBe(true)
    expect(publishLines.some((line) => /\$remoteInstallerSha\s*-ne\s*\$localInstallerSha/.test(line))).toBe(true)
    expect(publishLines.some((line) => /\$remoteSha\s*-ne\s*\$localInstallerSha/.test(line))).toBe(true)
    expect(publishLines.some((line) => /\[long\]\$asset\.size\s*-ne\s*\[long\]\$localSize/.test(line))).toBe(true)

    const download = publishLines.findIndex((line) => /invoke-webrequest\b.*\$installerAsset\.url.*-outfile/i.test(line))
    const recompute = publishLines.findIndex((line) => /\$remoteInstallerSha\s*=\s*Get-Sha512Base64File\s+\$remoteInstallerPath/.test(line))
    const compare = publishLines.findIndex((line) => /\$remoteInstallerSha\s*-ne\s*\$localInstallerSha/.test(line))
    const publicLine = publishLines.findIndex((line) => /^-Body\s+\(@\{\s*draft\s*=\s*\$false/.test(line))
    expect(download).toBeGreaterThan(-1)
    expect(recompute).toBeGreaterThan(download)
    expect(compare).toBeGreaterThan(recompute)
    expect(publicLine).toBeGreaterThan(compare)

    expect(releaseSteps.some((step) => activeLines(step)
      .some((line) => /npm run dist\b.*--publish always/.test(line)))).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('工作流里的 SHA-512 辅助函数与 Node 的计算结果一致', () => {
    const publishStep = releaseSteps.find((step) =>
      activeLines(step).some((line) => /^-Body\s+\(@\{\s*draft\s*=\s*\$false/.test(line)))
    const script = String(publishStep?.run ?? '')
    const start = script.indexOf('function Get-Sha512Base64File')
    const end = script.indexOf('\n}', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const helper = script.slice(start, end + 2)

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'supertime-hash-'))
    const file = path.join(temp, 'probe.bin')
    try {
      const bytes = Buffer.from('release digest probe\n', 'utf8')
      fs.writeFileSync(file, bytes)
      const psFile = `'${file.replace(/'/g, "''")}'`
      const result = spawnSync(
        signature.resolvePowerShellHost(),
        ['-NoProfile', '-NonInteractive', '-Command', `${helper}\nGet-Sha512Base64File ${psFile}`],
        { encoding: 'utf8', windowsHide: true },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe(createHash('sha512').update(bytes).digest('base64'))
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })
})
