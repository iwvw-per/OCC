// ============================================
// HostMetricsBar - 侧栏底部的当前主机资源监控
//
// 只显示**当前活动主机**的整机 CPU / 内存，用于观察编译等重负载时的主机压力。
//
// 交互（与下方 HostQuickSwitcher 复用同一排主机按钮，不另起一行主机列表）：
//   - 点别的某台主机 → 切换到那台，并自动展开本块；
//   - 重复点当前主机 → 收起 / 展开本块。
//   折叠状态通过 hostMetricsUi 共享，HostQuickSwitcher 与这里读同一个开关。
//
// 为什么是「整机」而不是「进程」：
//   用户关心的是「这台机器现在有多累」。编译由 agent 拉起的子进程执行，
//   进程级 CPU 会低估真实压力，所以取主机 Agent 上报的整机指标。
//
// 轮询策略：
//   - 仅在页面可见且**已展开**时轮询（折叠时没必要占用带宽）；
//   - 主机上报间隔本身是 10~30 秒，因此 5 秒轮询足够；
//   - 非 AI Agent 服务器（手填 URL）没有实例指标，整块不渲染。
// ============================================

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { serverStore } from '../../../store/serverStore'
import {
  readAccount,
  instanceIdFromServerId,
  fetchHostMetrics,
  listInstances,
  type HostMetrics,
} from '../../../api/aiagent'
import { subscribeHostMetrics, type RealtimeHostMetrics } from '../../../api/hostMetricsSocket'
import { barColor, formatMegabytes, isMetricsStale } from './hostMetricsModel'
import { isMetricsDemoEnabled, getHostMetricsCollapsed, subscribeHostMetricsCollapsed } from './hostMetricsUi'

/** 轮询间隔：主机指标本身约 10~30 秒一条，5 秒足够且不至于打满网关。 */
const POLL_INTERVAL_MS = 5000

/**
 * 占位数据：真实接口未就绪时用来调整样式。
 *
 * 取一组「中等负载」的数值，便于看到条宽与阈值配色的实际观感。
 */
const DEMO_METRICS: HostMetrics = {
  serverId: 'demo',
  cpuPercent: 63,
  cpuLoad: 2.41,
  cpuCores: 8,
  cpuThreads: 16,
  memPercent: 41,
  // 单位 MB，与网关返回口径一致（见 HostMetrics.memUsed 的说明）
  memUsed: 6758,
  memTotal: 16384,
  diskPercent: 52,
  platform: 'linux',
}

/**
 * 订阅当前活动服务器 id。
 *
 * 只取 id（字符串，引用天然稳定），不取服务器对象 ——
 * `getStoredServers()` 每次返回新数组，直接当快照会触发无限重渲染。
 */
function useActiveServerId(): string | null {
  return useSyncExternalStore(
    cb => serverStore.subscribe(cb),
    () => serverStore.getActiveServerId(),
    () => serverStore.getActiveServerId(),
  )
}

function MetricRow({ label, percent, detail }: { label: string; percent: number; detail?: string }) {
  const clamped = Math.min(100, Math.max(0, percent))
  return (
    <div className="flex flex-col gap-1">
      {/* 百分比交给进度条本身表达；右列只显示绝对值（负载 / 已用总量），
          侧栏宽度有限，再堆一个百分号会把两行挤乱 */}
      <div className="flex items-baseline justify-between gap-2 text-[length:var(--fs-xxs)] leading-none">
        <span className="text-text-400">{label}</span>
        {detail && <span className="text-text-500 tabular-nums">{detail}</span>}
      </div>
      <div className="h-1 w-full rounded-full bg-bg-300 overflow-hidden">
        <div
          className={`h-full ${barColor(clamped)} transition-[width] duration-500 ease-out`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}

/**
 * 把实时推送的指标转成展示用的 HostMetrics。
 *
 * 两边字段不同（推送用 `cpu` / `mem_percent` / `load1`，REST 用 `cpuPercent`
 * / `memPercent` / `cpuLoad`），在这里做一次收敛，下游渲染只认 HostMetrics。
 */
function toHostMetrics(pushed: RealtimeHostMetrics): HostMetrics {
  return {
    serverId: pushed.serverId,
    cpuPercent: pushed.cpu,
    cpuLoad: pushed.load1,
    cpuCores: pushed.cores,
    cpuThreads: pushed.logicalCores,
    memPercent: pushed.memPercent,
    // 推送侧已是 MB，与 REST 口径一致
    memUsed: pushed.memUsedMB,
    memTotal: pushed.memTotalMB,
    diskPercent: pushed.diskPercent,
    platform: pushed.platform,
    recordedAt: pushed.timestamp ? new Date(pushed.timestamp).toISOString() : undefined,
  }
}

export function HostMetricsBar() {
  const { t } = useTranslation(['chat', 'common'])
  const activeId = useActiveServerId()
  const instanceId = activeId ? instanceIdFromServerId(activeId) : null
  const collapsed = useSyncExternalStore(
    subscribeHostMetricsCollapsed,
    getHostMetricsCollapsed,
    getHostMetricsCollapsed,
  )

  const [metrics, setMetrics] = useState<HostMetrics | null>(null)
  const [failed, setFailed] = useState(false)
  /**
   * 是否停更，在轮询回调里算好存进 state。
   *
   * 不在渲染期读 `Date.now()`：渲染期读时钟会让结果随重渲染漂移，
   * 也违反 react-hooks/purity。
   */
  const [stale, setStale] = useState(false)
  /** 数据归属的实例 id：切主机时渲染期比对，避免闪出上一台主机的数字 */
  const [loadedFor, setLoadedFor] = useState<string | null>(null)

  /**
   * 实例 id → 面板主机 id（广播里的 serverId）的映射。
   *
   * 实时通道按面板主机 id 广播，而 OCC 用 `aiagent:inst_xxx`，两者要靠实例列表
   * 里的 serverId 字段对上。
   */
  const [panelServerId, setPanelServerId] = useState<string | null>(null)
  /** 实时推送的最新值；有它就优先于轮询结果 */
  const [realtime, setRealtime] = useState<HostMetrics | null>(null)
  /**
   * 是否已经收到过实时推送（ref 而非 state）。
   *
   * 轮询定时器在每次 tick 里读它决定是否继续：用 ref 是为了让判断发生在
   * **回调执行时**，而不是依赖 effect 因状态变化重跑 —— 后者实测没能及时
   * 清掉定时器（首帧 1.1s 就到了，之后仍每 5 秒多打一次 REST）。
   */
  const realtimeSeenRef = useRef(false)

  /**
   * 当前主机的指标：实时推送优先，没有推送就用 REST 兜底结果。
   *
   * 两者字段不同，但都已规整成 HostMetrics 形状，这里只做取舍。
   */
  const current = loadedFor === instanceId ? (realtime ?? metrics) : null
  const currentFailed = loadedFor === instanceId && !realtime ? failed : false
  // 实时值本身即「新鲜」，不需要再判停更；只有 REST 兜底数据才可能过期
  const currentStale = loadedFor === instanceId && !realtime ? stale : false
  const demo = isMetricsDemoEnabled()
  const shown = current ?? (demo ? DEMO_METRICS : null)

  const load = useCallback(async () => {
    if (!instanceId) return
    const account = readAccount()
    if (!account) return
    try {
      const next = await fetchHostMetrics(account, instanceId)
      setMetrics(next)
      setLoadedFor(instanceId)
      setFailed(false)
      setStale(isMetricsStale(next?.recordedAt, Date.now()))
    } catch {
      // 失败不清空上一次数据：网络抖动时保留最后已知值，比闪成空白更有用。
      setLoadedFor(instanceId)
      setFailed(true)
    }
  }, [instanceId])

  /**
   * 解析当前实例对应的面板主机 id（广播里的 serverId）。
   *
   * 只在实例变化时拉一次实例列表：它是低频数据，且已有 30s 级别的缓存价值不大，
   * 但也没必要每次推送都查。
   */
  useEffect(() => {
    if (!instanceId) return
    const account = readAccount()
    if (!account) return
    let cancelled = false
    void listInstances(account)
      .then(instances => {
        if (cancelled) return
        const match = instances.find(item => item.id === instanceId)
        setPanelServerId(match?.serverId ?? null)
      })
      .catch(() => {
        if (!cancelled) setPanelServerId(null)
      })
    return () => {
      cancelled = true
    }
  }, [instanceId])

  /**
   * 订阅面板的实时指标推送（Socket.IO /metrics）。
   *
   * 主机数据本来就是 Agent 心跳上报的，面板收到即广播 —— 直接订阅比定时查库
   * 少一道往返，延迟也从「最多一个轮询周期」降到「心跳到达即显示」。
   * REST 仍保留作首屏兜底（见上方轮询 effect）。
   */
  useEffect(() => {
    if (!instanceId || !panelServerId || collapsed) return
    const account = readAccount()
    if (!account?.domain) return

    const unsubscribe = subscribeHostMetrics({
      domain: account.domain,
      onMetrics: pushed => {
        // 广播面向所有主机，这里只认当前这台
        if (pushed.serverId !== panelServerId) return
        realtimeSeenRef.current = true
        setRealtime(toHostMetrics(pushed))
        setLoadedFor(instanceId)
        setFailed(false)
      },
    })
    return unsubscribe
  }, [instanceId, panelServerId, collapsed])

  /**
   * REST 兜底轮询 —— **只在实时通道还没送上数据时跑**。
   *
   * 实时推送本身 1.5 秒一条（实测），一旦收到第一条，再每 5 秒查一次库就是纯
   * 浪费：实测部署后 45 秒里仍多打了 6 次 REST 请求。因此收到推送即停止轮询，
   * 退回「进页面先拉一次、断线才补拉」的模式。
   *
   * 停止方式：轮询回调里读 realtimeSeenRef，收到过推送就不再续期。
   */
  useEffect(() => {
    if (!instanceId || collapsed) return

    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const tick = async () => {
      if (cancelled) return
      // 后台标签页不轮询：切回来时立刻补一次，用户不会看到过时数据。
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        await load()
      }
      if (cancelled) return
      // 已经收到实时推送：停止续期。推送比轮询密得多（实测 1.5 秒一条），
      // 继续查库纯属浪费。
      if (realtimeSeenRef.current) return
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }
    // 首次加载走一次（异步 tick，避免在 effect 内同步 setState），
    // 保证进页面立刻有数 —— 推送最多要等一个上报周期。
    timer = setTimeout(tick, 0)

    const onVisibility = () => {
      // 已收到实时数据时，切回前台补拉一次即可，不必恢复轮询
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [instanceId, collapsed, load])

  /**
   * 是否可见 —— **不用 return null 实现**。
   *
   * 这里是「隐藏」而不是「卸载」：切换主机时新主机的数据要等一个轮询周期才到，
   * 若这时返回 null，组件会被卸载、数据回来后重新挂载 —— 用户看到的就是
   * 「切一次主机，资源条闪一下重建」。保持挂载后，切换只是内容与行高变化。
   *
   * 三种情况统一按「隐藏」处理：
   *   - 非 AI Agent 服务器（手填 URL）没有实例指标；
   *   - 还没有任何数据（刚切换 / 主机尚未上报）；
   *   - 用户手动折叠了这块。
   */
  const hasAnyMetric = shown?.cpuPercent != null || shown?.memPercent != null
  const visible = !!instanceId && hasAnyMetric && !collapsed

  const warn = currentStale || currentFailed
  const warnText = currentFailed && !currentStale ? t('sidebar.hostMetricsOffline') : t('sidebar.hostMetricsStale')

  return (
    /**
     * 高度动画用 grid 行过渡（`grid-template-rows: 0fr → 1fr`）。
     *
     * 只做 opacity/scale 不够：收起时元素仍占着高度，下面的主机按钮不会跟着
     * 上移，观感上就是「点了没反应」。grid 行能从 0 高度平滑过渡，且不需要
     * 预先知道内容的固定高度。
     *
     * 折叠时面板留在 DOM 里（不 return null），否则没有可动画的退出过程。
     */
    <div
      id="host-metrics-panel"
      aria-hidden={!visible}
      data-state={visible ? 'expanded' : 'collapsed'}
      className="shrink-0 grid border-t border-border-200/40 transition-[grid-template-rows,opacity] duration-200 ease-out"
      style={{
        // 0fr 完全收起、1fr 按内容撑开 —— 能平滑过渡且不必预知内容高度
        gridTemplateRows: visible ? '1fr' : '0fr',
        opacity: visible ? 1 : 0,
        // 收起后不该再占据高度与交互（否则会挡住下方主机按钮的点击）
        borderTopWidth: visible ? 1 : 0,
        pointerEvents: visible ? undefined : 'none',
      }}
    >
      <div className="overflow-hidden">
        <div className="px-3 pt-2 pb-2">
          <div className="flex flex-col gap-1.5">
            {shown?.cpuPercent != null && (
              <MetricRow
                label={t('sidebar.hostMetricsCpu')}
                percent={shown.cpuPercent}
                detail={
                  warn
                    ? warnText
                    : shown.cpuLoad != null
                      ? `${t('sidebar.hostMetricsLoad')} ${shown.cpuLoad.toFixed(2)}`
                      : undefined
                }
              />
            )}
            {shown?.memPercent != null && (
              <MetricRow
                label={t('sidebar.hostMetricsMemory')}
                percent={shown.memPercent}
                detail={
                  shown.memUsed != null && shown.memTotal != null
                    ? `${formatMegabytes(shown.memUsed)}/${formatMegabytes(shown.memTotal)}`
                    : undefined
                }
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
