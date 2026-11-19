#!/usr/bin/env node

/**
 * watch-deploy.mjs - 监听源码变化,自动重新构建并刷新 occ.dmuk.org
 *
 * 用法:
 *   npm run deploy:watch              # 前台运行(调试用)
 *   由 systemd 单元 occ-autodeploy.service 常驻托管
 *
 * 工作流程:
 *   1. 监听 src/、public/ 与构建相关配置文件(忽略测试文件与临时文件)
 *   2. 变更后 debounce 1.2s,串行执行一次 `npm run build`
 *   3. 构建前备份 dist;构建失败时恢复备份,线上继续用上一个可用版本
 *   4. 构建成功则重启 occ-preview.service 并轮询 127.0.0.1:4188 探活
 *
 * 为什么不用 `vite build --watch`:
 *   vite build --watch 只重建产物,不会刷新预览服务;而且它不跑 tsc,
 *   类型错误会直接产出半成品。这里复用 npm run build(tsc -b && vite build),
 *   保证只有通过类型检查的产物才会上线。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const SERVICE = 'occ-preview.service'
const PORT = process.env.OCC_PREVIEW_PORT || '4188'
const HEALTH_URL = `http://127.0.0.1:${PORT}/`
const DEBOUNCE_MS = 1200
const BUILD_TIMEOUT_MS = 10 * 60 * 1000

// 参与构建的目录与文件
const WATCH_DIRS = ['src', 'public']
const WATCH_FILES = ['index.html', 'package.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']

// 不触发重建的文件:测试、编辑器临时文件、构建产物
const IGNORE_PATTERNS = [/\.test\./, /\.spec\./, /(^|\/)__tests__(\/|$)/, /\.swp$/, /\.swx$/, /~$/, /\.tmp$/, /(^|\/)\.DS_Store$/]

const distDir = path.join(root, 'dist')
// 备份放到仓库外,避免 ESLint/tsc 等工具扫描到构建中途的临时目录。
const backupDir = path.join(os.tmpdir(), 'occ-autodeploy-dist-backup')
const lockFile = path.join(os.tmpdir(), 'occ-autodeploy.lock')

let debounceTimer = null
let running = false
let pending = false
let shuttingDown = false
const watchers = []

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

function shouldIgnore(filename) {
  if (!filename) return false
  const normalized = String(filename).replace(/\\/g, '/')
  return IGNORE_PATTERNS.some(pattern => pattern.test(normalized))
}

/** 单实例锁:systemd 重启或手动运行时避免两个 watcher 同时构建。 */
function acquireLock() {
  try {
    const pid = Number(fs.readFileSync(lockFile, 'utf-8').trim())
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0)
        console.error(`✗ 已有 watch-deploy 在运行(PID ${pid}),本实例退出`)
        process.exit(1)
      } catch {
        // 进程已不存在,清理过期锁
      }
    }
  } catch {
    // 没有锁文件
  }
  fs.writeFileSync(lockFile, String(process.pid))
}

function releaseLock() {
  try {
    if (fs.readFileSync(lockFile, 'utf-8').trim() === String(process.pid)) fs.unlinkSync(lockFile)
  } catch {
    // 忽略
  }
}

/** dist 备份:构建失败时恢复,避免线上停在被清空的产物目录。 */
function backupDist() {
  fs.rmSync(backupDir, { recursive: true, force: true })
  if (!fs.existsSync(distDir)) return false
  fs.cpSync(distDir, backupDir, { recursive: true })
  return true
}

function restoreDist(hadDist) {
  if (!hadDist) return false
  if (!fs.existsSync(backupDir)) return false
  fs.rmSync(distDir, { recursive: true, force: true })
  try {
    fs.renameSync(backupDir, distDir)
  } catch {
    // /tmp 与仓库可能不在同一文件系统,rename 会 EXDEV;退化为复制。
    fs.cpSync(backupDir, distDir, { recursive: true })
    fs.rmSync(backupDir, { recursive: true, force: true })
  }
  return true
}

function runBuild() {
  const startedAt = Date.now()
  try {
    execFileSync('npm', ['run', 'build'], {
      cwd: root,
      stdio: 'inherit',
      timeout: BUILD_TIMEOUT_MS,
      env: { ...process.env, NODE_ENV: 'production' },
    })
    log(`构建完成,耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
    return true
  } catch (error) {
    const reason = error?.signal ? `信号 ${error.signal}` : `退出码 ${error?.status ?? '未知'}`
    log(`构建失败(${reason})`)
    return false
  }
}

function serviceExists() {
  try {
    execFileSync('systemctl', ['cat', SERVICE], { stdio: ['ignore', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}

function restartService() {
  if (!serviceExists()) {
    log(`未找到 ${SERVICE},跳过重启(请确认 127.0.0.1:${PORT} 上有预览服务)`)
    return false
  }
  try {
    execFileSync('systemctl', ['restart', SERVICE], { stdio: 'inherit' })
    log(`已重启 ${SERVICE}`)
    return true
  } catch (error) {
    log(`重启 ${SERVICE} 失败:${error?.message ?? error}`)
    return false
  }
}

async function waitForHealth() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) })
      await response.arrayBuffer()
      if (response.ok) return true
    } catch {
      // 服务可能还在启动
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

async function deployOnce(reason) {
  if (running) {
    pending = true
    return
  }
  running = true
  log(`检测到变更(${reason}),开始构建`)
  try {
    const hadDist = backupDist()
    const built = runBuild() && fs.existsSync(path.join(distDir, 'index.html'))

    if (!built) {
      const restored = restoreDist(hadDist)
      log(restored ? '已恢复上一个可用 dist,线上版本未受影响' : '没有可恢复的 dist,请手动检查')
      return
    }

    fs.rmSync(backupDir, { recursive: true, force: true })
    restartService()
    const healthy = await waitForHealth()
    log(healthy ? `部署完成:${HEALTH_URL} 返回 200` : `探活失败:${HEALTH_URL} 未在 15s 内返回 200`)
  } finally {
    running = false
    if (pending && !shuttingDown) {
      pending = false
      scheduleDeploy('构建期间又有新变更')
    }
  }
}

function scheduleDeploy(reason) {
  if (shuttingDown) return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void deployOnce(reason)
  }, DEBOUNCE_MS)
}

function watchDirectory(dir) {
  const absolute = path.join(root, dir)
  if (!fs.existsSync(absolute)) return
  const watcher = fs.watch(absolute, { recursive: true }, (_event, filename) => {
    if (shouldIgnore(filename)) return
    scheduleDeploy(`${dir}/${filename ?? ''}`)
  })
  watcher.on('error', error => log(`监听 ${dir} 出错:${error.message}`))
  watchers.push(watcher)
}

function watchFile(file) {
  const absolute = path.join(root, file)
  if (!fs.existsSync(absolute)) return
  fs.watchFile(absolute, { interval: 1000 }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return
    scheduleDeploy(file)
  })
}

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log(`收到 ${signal},停止监听`)
  if (debounceTimer) clearTimeout(debounceTimer)
  for (const watcher of watchers) {
    try {
      watcher.close()
    } catch {
      // 忽略
    }
  }
  releaseLock()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('exit', releaseLock)

acquireLock()
log(`watch-deploy 启动,工作目录 ${root}`)
log(`监听目录:${WATCH_DIRS.join(', ')};配置文件:${WATCH_FILES.join(', ')}`)

for (const dir of WATCH_DIRS) watchDirectory(dir)
for (const file of WATCH_FILES) watchFile(file)

// 启动时先对齐一次,修复上次异常退出可能留下的半成品 dist。
void deployOnce('启动对齐')