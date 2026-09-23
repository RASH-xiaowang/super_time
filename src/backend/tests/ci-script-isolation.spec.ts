/**
 * CI 有效性守卫（N23）：被 CI 调用的每一步都必须能在**干净检出**上成立。
 *
 * 起因：`check:backend-restart` 曾经读仓库里的签发私钥（`vendor-keys/` 下那份 pem，被 gitignore）
 * 去现签一张许可证 —— 本机工作树里有它，CI 上永远没有。于是「后端进程死了能否自己回来」
 * 这条唯一的自动化证据在 CI 上必然 ENOENT 失败，而**本机跑多少遍都是全绿**：
 * 这类缺口靠本地执行发现不了，只能靠静态守卫 + CI 自己证明。
 *
 * 判据用 AST 取**字符串字面量**，不扫原始文本：解释性注释里提到这些路径是正常的
 * （这份用例自己、以及被它守着的脚本都在注释里说明过这件事），而真正的依赖必然以字面量
 * 出现在 `readFileSync`/`path.join` 里。这是 M12/N19/N20 反复栽的同一个坑的第四次应用：
 * 判定要看「真的用到了」，不是「字面上出现过」。
 *
 * 它守得住什么、守不住什么（如实标注）：
 *   · 守得住：CI 步骤引用的脚本里出现「本机专有资产」的硬编码路径、CI 里 `npm run` 打错名字、
 *     以及扫描集合本身失效（空转）；
 *   · **守不住**：通过 `path.join(a, b, c)` 拼出来的路径（会把段拆成多个字面量）、
 *     间接依赖（require 了别的模块而那个模块读本机资产）、运行期才下载的资产。
 *
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
/** 守卫自己的相对路径：它必须在源码里写出这些资产的路径（作为判据），因此扫描时排除自己。 */
const SELF = 'src/backend/tests/ci-script-isolation.spec.ts'
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * 只存在于**本机**的资产：干净检出 / CI runner 上不存在。
 * 只列「读不到就必然失败」的那两类，避免误报（临时文件、构建产物、输出目录都不在此列）。
 */
const FORBIDDEN_PATH_PATTERNS = [
  { name: '签发私钥目录 vendor-keys', test: (s: string) => s.includes('vendor-keys') },
  { name: '仓库里的微信配置 wechat/llm.json 或 wechat/config.json', test: (s: string) => /(^|[\\/])wechat[\\/](llm|config)\.json$/.test(s) },
]

/**
 * 取一段源码里的**字符串字面量**（注释与标识符不算）。
 * @param src - 源码全文。
 * @param filename - 仅用于解析器选择（含 tsx 时按 TSX 解析）。
 * @returns 字面量文本列表。
 */
function stringLiterals(src: string, filename: string): string[] {
  const kind = filename.endsWith('.tsx') ? ts.ScriptKind.TSX : filename.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sf = ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, true, kind)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text)
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

/** 收集某个 workflow 里所有 `run:` 命令（含 `run: |` 多行块）。 */
function commandsIn(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const cur = lines[i]
    if (cur === undefined) continue
    const inline = /^\s*run:\s*(\S.*)$/.exec(cur)
    const inlineCmd = inline?.[1]
    if (inlineCmd !== undefined && inlineCmd !== '|' && inlineCmd !== '>') {
      out.push(inlineCmd.trim())
      continue
    }
    if (/^\s*run:\s*[|>]\s*$/.test(cur)) {
      const baseIndent = cur.search(/\S/)
      const block: string[] = []
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j]
        if (line === undefined) break
        if (line.trim() !== '' && line.search(/\S/) <= baseIndent) break
        block.push(line.trim())
      }
      out.push(block.join('\n').trim())
    }
  }
  return out
}

const workflowDir = join(ROOT, '.github', 'workflows')
const workflowFiles = existsSync(workflowDir)
  ? readdirSync(workflowDir).filter((f) => /\.ya?ml$/i.test(f))
  : []
const ciCommands = workflowFiles.flatMap((f) => commandsIn(readFileSync(join(workflowDir, f), 'utf8')))

/** `npm` 子命令里不是 package.json 脚本的那些。 */
const NPM_BUILTINS = new Set(['ci', 'install', 'i', 'exec', 'x', 'init'])

/** 抽出命令里所有 `npm run X` / `npm test` 形式引用到的脚本名（只保留真实存在的）。 */
function scriptNamesIn(command: string): string[] {
  const names: string[] = []
  for (const m of command.matchAll(/\bnpm\s+(?:run\s+)?([\w:.-]+)/g)) {
    const name = m[1]
    if (name === undefined) continue
    if (NPM_BUILTINS.has(name)) continue
    if (pkg.scripts[name]) names.push(name)
  }
  return names
}

/** 顺着 `npm run` 链展开某个脚本（含防环）。 */
function expandScript(name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return []
  seen.add(name)
  const cmd = String(pkg.scripts[name] ?? '')
  const out = [cmd]
  for (const nested of scriptNamesIn(cmd)) out.push(...expandScript(nested, seen))
  return out
}

/** 从命令文本里抽出被执行的脚本文件。 */
function scriptFilesIn(text: string): string[] {
  return [...new Set([...text.matchAll(/scripts\/[\w./-]+\.(?:c?js|mjs|tsx?)/g)].map((m) => m[0]))]
}

const referencedScripts = [...new Set(ciCommands.flatMap((c) => scriptNamesIn(c).flatMap((n) => expandScript(n))))]
  .flatMap((cmd) => scriptFilesIn(cmd))

/**
 * `npm test` 本身也是一个 CI 步骤，所以单测文件同样受这条不变量约束：
 * 它们不得读本机专有资产（否则 CI 上必然失败，而本机全绿）。
 * @param dir - 起始目录。
 * @returns 相对仓库根的 spec 文件路径。
 */
function allSpecs(dir: string = join(ROOT, 'src')): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allSpecs(abs))
    else if (entry.name.endsWith('.spec.ts')) out.push(relative(ROOT, abs).replace(/\\/g, '/'))
  }
  return out
}

const specFiles = allSpecs().filter((rel) => rel !== SELF)

describe('N23：CI 步骤不得依赖只存在于本机的资产', () => {
  it('解析有效：扫到了 workflow、CI 步骤与脚本文件，且包含那条曾坏掉的步骤（防空转）', () => {
    expect(workflowFiles.length).toBeGreaterThan(0)
    expect(ciCommands.length).toBeGreaterThan(5)
    expect(referencedScripts.length).toBeGreaterThan(5)
    expect(ciCommands.join('\n')).toContain('check:backend-restart')
  })

  it('CI 里引用的每个 npm 脚本都存在', () => {
    for (const command of ciCommands) {
      for (const m of command.matchAll(/\bnpm\s+run\s+([\w:.-]+)/g)) {
        const script = m[1]
        if (script === undefined) continue
        expect(pkg.scripts[script], `CI 调用了不存在的脚本：npm run ${script}`).toBeTruthy()
      }
    }
  })

  it('命令文本本身不含本机专有资产路径', () => {
    for (const command of ciCommands) {
      for (const pattern of FORBIDDEN_PATH_PATTERNS) {
        expect(pattern.test(command), `CI 步骤的命令里引用了${pattern.name}：${command}`).toBe(false)
      }
    }
  })

  it('命令引用的脚本文件里没有本机专有资产的字符串字面量（注释不算）', () => {
    for (const rel of referencedScripts) {
      const abs = join(ROOT, rel)
      expect(existsSync(abs), `CI 引用了不存在的脚本：${rel}`).toBe(true)
      const literals = stringLiterals(readFileSync(abs, 'utf8'), rel)
      // 防空转：AST 抽取失效时（拿到空数组）这条断言会变成恒真
      expect(literals.length, `${rel} 里没抽到任何字符串字面量，抽取可能失效`).toBeGreaterThan(0)
      for (const pattern of FORBIDDEN_PATH_PATTERNS) {
        const hits = literals.filter((l) => pattern.test(l))
        expect(hits, `${rel} 引用了${pattern.name}（${hits.join(', ')}）—— 干净检出/CI 上会失败`).toEqual([])
      }
    }
  })

  it('单测文件里也没有本机专有资产的字符串字面量（npm test 同样是 CI 步骤）', () => {
    expect(specFiles.length, '没扫到任何 spec 文件，扫描逻辑可能失效').toBeGreaterThan(5)
    for (const rel of specFiles) {
      const literals = stringLiterals(readFileSync(join(ROOT, rel), 'utf8'), rel)
      for (const pattern of FORBIDDEN_PATH_PATTERNS) {
        const hits = literals.filter((l) => pattern.test(l))
        expect(hits, `${rel} 引用了${pattern.name}（${hits.join(', ')}）—— CI 上会失败`).toEqual([])
      }
    }
  })

  it('反面确认：这些资产确实被 gitignore（否则上面的判据不成立）', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
    for (const entry of ['vendor-keys/', 'wechat/llm.json', 'wechat/config.json']) {
      expect(ignore, `.gitignore 未覆盖 ${entry}`).toContain(entry)
    }
  })
})
