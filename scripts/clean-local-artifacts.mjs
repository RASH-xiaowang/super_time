#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')

const GENERATED_PATHS = [
  '.tmp-e2e',
  'ci-evidence',
  'docs/architecture/__pycache__',
  'src/backend/wechat-data/lib/tsconfig.tsbuildinfo',
  'website/tests/smoke.log',
]

// These names were accidentally produced by shell redirection / arithmetic snippets.
// Delete them only while they remain empty, so a future real file is never lost.
const EMPTY_ROOT_NOISE = [
  '$null',
  '0)',
  '130',
  '380',
  '420',
  '430',
  '600',
  "String(i+105).padStart(4)+'",
  "String(i+196).padStart(4)+'",
  "String(i+2).padStart(4)+'",
  "String(i+421).padStart(4)+'",
  'printed.txt',
  'probe.txt',
]

function assertInsideRoot(path) {
  const rel = relative(ROOT, path)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to remove path outside repository: ${path}`)
  }
}

function measure(path) {
  if (!existsSync(path)) return null
  const stat = lstatSync(path)
  if (!stat.isDirectory()) return { files: 1, bytes: stat.size }
  let files = 0
  let bytes = 0
  for (const name of readdirSync(path)) {
    const child = measure(join(path, name))
    if (child !== null) {
      files += child.files
      bytes += child.bytes
    }
  }
  return { files, bytes }
}

function collectTargets() {
  const targets = []
  for (const rel of GENERATED_PATHS) {
    const path = resolve(ROOT, rel)
    assertInsideRoot(path)
    const size = measure(path)
    if (size !== null) targets.push({ rel, path, ...size })
  }
  for (const rel of EMPTY_ROOT_NOISE) {
    const path = resolve(ROOT, rel)
    assertInsideRoot(path)
    if (!existsSync(path)) continue
    const stat = statSync(path)
    if (!stat.isFile() || stat.size !== 0) {
      console.warn(`skip non-empty or non-file root entry: ${rel}`)
      continue
    }
    targets.push({ rel, path, files: 1, bytes: 0 })
  }
  return targets
}

const targets = collectTargets()
if (targets.length === 0) {
  console.log('No local artifacts to clean.')
  process.exit(0)
}

const totalFiles = targets.reduce((sum, item) => sum + item.files, 0)
const totalBytes = targets.reduce((sum, item) => sum + item.bytes, 0)
console.log(`${APPLY ? 'Removing' : 'Would remove'} ${targets.length} paths (${totalFiles} files, ${totalBytes} bytes):`)
for (const target of targets) {
  console.log(`- ${target.rel}`)
}

if (!APPLY) {
  console.log('\nDry run only. Re-run with --apply to delete these local artifacts.')
  process.exit(0)
}

for (const target of targets) {
  rmSync(target.path, { recursive: true, force: true })
}
console.log('Local artifacts removed.')
