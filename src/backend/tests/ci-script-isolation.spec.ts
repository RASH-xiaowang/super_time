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
 *
 * W2-13.3 起多一种**合法形态**：被断言的**对象**就是这些资产、但 CI 上跑得起来的脚本
 * （典型是 `scripts/packaged-smoke.js` —— 它要断言「它们不许进包」）。
 * 做法是把路径尾段拆成常量，AST 抽到的是 `wechat/` 与 `config.json` 两个**分开**的字面量。
 * 这不是判据漏洞：判据的实质是「不许**硬编码**依赖这些路径」，而拆常量后
 * 路径仍然由 `path.join(unpackedWechat, WECHAT_CONFIG_JSON)` 拼出来，读的仍是同一个地方。
 * 详见 `split-tail-libs.ts`。
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
    // 宽口径匹配扩展名：只认 `.spec.ts` 的话，将来任何 `.spec.tsx`（含 JSX 的用例）都会
    // 悄悄逃出这道扫描 —— 那个坑由 `spec-file-discoverability.spec.ts` 守着，这里不依赖它。
    else if (/\.spec\.[cm]?[jt]sx?$/.test(entry.name)) out.push(relative(ROOT, abs).replace(/\\/g, '/'))
  }
  return out
}

const specFiles = allSpecs().filter((rel) => rel !== SELF)

/**
 * 已知「拆尾段」的脚本 → 常量名。
 *
 * 为什么要有这张表：拆尾段让 AST 抽不到完整路径，于是这条判据默认放行。但**默认放行**
 * 有两种正当来历 —— ① 真的只在本机跑（门禁不许碰它）；② 拆了尾段、CI 上跑得起来。
 * 不区分的话，第 ② 类会被误当成第 ① 类，于是谁都可以靠「拆常量」绕过这条判据，
 * 而那条判据是 N23 的全部意义。所以拆尾段的脚本要在册，且册子要空转不得。
 */
const SPLIT_TAIL_LIBS: Record<string, string[]> = {
  'scripts/packaged-smoke.js': ['WECHAT_CONFIG_JSON', 'WECHAT_LLM_JSON'],
}

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
    // W2-13.3：拆过尾段的脚本按「拆开后的字面量」判，不再命中完整路径。
    for (const rel of referencedScripts) {
      const abs = join(ROOT, rel)
      expect(existsSync(abs), `CI 引用了不存在的脚本：${rel}`).toBe(true)
      const src = readFileSync(abs, 'utf8')
      const literals = stringLiterals(src, rel)
      // 防空转：AST 抽取失效时（拿到空数组）这条断言会变成恒真
      expect(literals.length, `${rel} 里没抽到任何字符串字面量，抽取可能失效`).toBeGreaterThan(0)
      for (const pattern of FORBIDDEN_PATH_PATTERNS) {
        const hits = literals.filter((l) => pattern.test(l))
        expect(hits, `${rel} 引用了${pattern.name}（${hits.join(', ')}）—— 干净检出/CI 上会失败`).toEqual([])
      }
    }
  })

  it('拆尾段的豁免要在册，且册子里的常量真的在那些脚本里（防空转）', () => {
    // 没有这条，第 ② 类（拆了尾段、CI 上跑得起来）与第 ① 类（真的只在本机跑）就分不开，
    // 于是谁都可以靠「拆常量」绕过这条判据 —— 而它是 N23 的全部意义。
    const splitEntries = Object.entries(SPLIT_TAIL_LIBS)
    expect(splitEntries.length, '册子空了：要么全修好了（那就删掉这张表），要么没人记得登记').toBeGreaterThan(0)
    for (const [rel, consts] of splitEntries) {
      const src = readFileSync(join(ROOT, rel), 'utf8')
      for (const c of consts) {
        expect(src, `${rel} 里找不到常量 ${c}（册子过期了）`).toMatch(new RegExp('const ' + c + ' ='))
      }
    }
    // 反面确认：这张表里的脚本**真的**被 CI 引用着（否则它是张废纸）
    for (const rel of Object.keys(SPLIT_TAIL_LIBS)) {
      expect(referencedScripts, `${rel} 在册但没有任何 workflow 调它（那就该回 LOCAL_ONLY）`).toContain(rel)
    }
  })

  it('反面确认：把尾段拼回完整路径，这条判据当场变红（证明豁免不是漏洞）', () => {
    // 自证而不是修饰：上一条把拆尾段合法化了，这条证明「只有拆开才算合法」。
    const rel = 'scripts/packaged-smoke.js'
    // 把常量定义本身换成完整路径字面量 —— AST 抽到的就是 wechat/config.json。
    const src = readFileSync(join(ROOT, rel), 'utf8').replace(
      /const WECHAT_CONFIG_JSON = 'config\.json'/,
      "const WECHAT_CONFIG_JSON = 'wechat/config.json'",
    )
    const literals = stringLiterals(src, rel)
    const hit = literals.filter((l) => /(^|[\\/])wechat[\\/](llm|config)\.json$/.test(l))
    expect(hit, '把尾段拼回去居然没命中 ⇒ 这条判据本来就是空转的').toEqual(['wechat/config.json'])
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
