#!/usr/bin/env node

/**
 * deploy-local.mjs - 构建并刷新本机预览站点（occ.dmuk.org）
 *
 * 用法：
 *   npm run deploy:local                # 完整构建
 *   npm run deploy:local -- --skip-build  # 只重启服务（dist 已是最新时）
 *
 * 为什么需要它：
 *   版本号（__APP_VERSION__）是 Vite 在**构建时**从 package.json 注入的。
 *   发版流程里 bump 版本发生在构建之后，若只跑了 validate 里的 build，
 *   dist 里固化的仍是旧版本号，页面会显示上一个版本。本脚本把「构建 →
 *   校验产物版本 → 重启预览服务 → 探活」固化为一条命令。
 *
 * 预览服务由 systemd 单元 occ-preview.service 托管（vite preview，监听
 * 127.0.0.1:4188，Restart=always）。它从磁盘读 dist，因此重启只为清掉
 * 可能被缓存的 index.html；服务不存在时给出明确提示而不是直接失败。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const SERVICE = 'occ-preview.service'
const PORT = process.env.OCC_PREVIEW_PORT || '4188'
const HEALTH_URL = `http://127.0.0.1:${PORT}/`

const args = process.argv.slice(2)
const skipBuild = args.includes('--skip-build')

const log = message => console.log(`\n> ${message}`)
const fail = message => {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function run(command, commandArgs, label) {
  log(label)
  try {
    execFileSync(command, commandArgs, { cwd: root, stdio: 'inherit' })
  } catch {
    fail(`${label} 失败`)
  }
}

function read(command, commandArgs) {
  return execFileSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const version = pkg.version

// ---- 1. 构建 ----
if (skipBuild) {
  log('跳过构建（--skip-build）')
} else {
  run('npm', ['run', 'build'], `构建（版本 ${version}）`)
}

// ---- 2. 校验产物里的版本号与 package.json 一致 ----
// 版本号被注入到 entry chunk。真实入口以 dist/index.html 的引用为准：
// dist/assets 里可能残留历次构建的旧 chunk，按 mtime 取最新会校验错文件。
const indexPath = join(root, 'dist', 'index.html')
let indexHtml
try {
  indexHtml = readFileSync(indexPath, 'utf-8')
} catch {
  fail('未找到 dist/index.html，构建可能没有产出')
}
const entryMatch = indexHtml.match(/<script[^>]+src="[^"]*?(\/assets\/[^"]+\.js)"/)
if (!entryMatch) fail('dist/index.html 中找不到入口 script')

const entryRel = entryMatch[1].replace(/^\//, '')
const entryPath = join(root, 'dist', entryRel)
let entrySource
try {
  entrySource = readFileSync(entryPath, 'utf-8')
} catch {
  fail(`入口文件不存在：dist/${entryRel}`)
}

if (!entrySource.includes(JSON.stringify(version).slice(1, -1))) {
  fail(`产物 ${entryRel} 中找不到版本号 ${version}，dist 可能来自旧构建`)
}
log(`产物版本校验通过：${entryRel} 含 ${version}`)

// ---- 3. 重启预览服务 ----
let serviceManaged = true
try {
  read('systemctl', ['cat', SERVICE])
} catch {
  serviceManaged = false
}

if (serviceManaged) {
  run('systemctl', ['restart', SERVICE], `重启 ${SERVICE}`)
} else {
  console.warn(`\n! 未找到 ${SERVICE}，跳过重启。请自行确认 127.0.0.1:${PORT} 上有预览服务。`)
}

// ---- 4. 探活 ----
log(`探活 ${HEALTH_URL}`)
let healthy = false
for (let i = 0; i < 15; i++) {
  try {
    const code = read('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', HEALTH_URL])
    if (code === '200') {
      healthy = true
      break
    }
  } catch {
    /* 服务可能还在启动 */
  }
  execFileSync('sleep', ['1'])
}

if (!healthy) fail(`${HEALTH_URL} 未在 15 秒内返回 200，请查看 journalctl -u ${SERVICE}`)

log(`完成：已部署 v${version}`)
console.log(`  入口 chunk: ${entryRel}`)
if (serviceManaged) {
  console.log(`  服务状态  : ${read('systemctl', ['is-active', SERVICE])}`)
}
