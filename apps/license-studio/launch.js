#!/usr/bin/env node
/**
 * 启动 Win32 授权签发台（apps/license-studio/build/LicenseStudio.exe）。
 */
'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const exe = path.join(__dirname, 'build', 'LicenseStudio.exe')
if (!fs.existsSync(exe)) {
  console.error('未找到 Win32 签发台：' + exe)
  console.error('请先在本机运行：apps\\license-studio\\build.bat')
  process.exit(1)
}
const child = spawn(exe, process.argv.slice(2), {
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
})
child.unref()
