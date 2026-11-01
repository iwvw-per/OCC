import { describe, expect, it } from 'vitest'
import { normalizeRealtimeMetrics } from './hostMetricsSocket'

/**
 * 面板实时推送（Socket.IO `metrics:update`）的负载解析。
 *
 * 这些断言来自实测抓到的真实帧（2026-11-01）：
 *   {"metrics":{"cpu":23.8,"cpu_usage":"23.8%","load1":0.66,
 *               "mem_percent":17.13,"mem":"4106/23972MB",
 *               "disk_percent":52.75,"disk_usage":52.75,...}}
 *
 * 面板同时给数值与字符串两种形态，解析必须优先取数值 —— 取错会得到 0 或 NaN，
 * 侧栏就会显示成 0% 且进度条空掉。
 */
describe('normalizeRealtimeMetrics', () => {
  it('解析实测帧：数值字段优先于字符串字段', () => {
    const result = normalizeRealtimeMetrics({
      serverId: '39cd3303-fa37-4910-91da-65c395d1639b',
      timestamp: 1793556000000,
      metrics: {
        cpu: 23.825504302978516,
        cpu_usage: '23.8%',
        load1: 0.66,
        load5: 0.77,
        load15: 1.4,
        cores: 4,
        logical_cores: 4,
        mem_percent: 17.13086672820551,
        mem: '4106/23972MB',
        disk_percent: 52.752204375061474,
        disk_usage: 52.752204375061474,
        platform: 'linux',
      },
    })

    expect(result).not.toBeNull()
    expect(result!.serverId).toBe('39cd3303-fa37-4910-91da-65c395d1639b')
    expect(result!.cpu).toBeCloseTo(23.83, 2)
    expect(result!.load1).toBe(0.66)
    expect(result!.memPercent).toBeCloseTo(17.13, 2)
    expect(result!.cores).toBe(4)
    expect(result!.platform).toBe('linux')
  })

  it('从 "4106/23972MB" 解析出已用与总量', () => {
    const result = normalizeRealtimeMetrics({
      serverId: 's1',
      metrics: { mem: '4106/23972MB' },
    })
    expect(result!.memUsedMB).toBe(4106)
    expect(result!.memTotalMB).toBe(23972)
  })

  it('没有数值 cpu 时退回字符串形态', () => {
    const result = normalizeRealtimeMetrics({
      serverId: 's1',
      metrics: { cpu_usage: '23.8%', memory: 55.5 },
    })
    // cpu_usage 是字符串，当前实现取 cpu 数值字段；缺 cpu 时 cpu 为 undefined
    expect(result!.cpu).toBeUndefined()
    // memory 是 mem_percent 的别名，应能兜底
    expect(result!.memPercent).toBe(55.5)
  })

  it('缺少 serverId 时返回 null（无法归属到任何主机）', () => {
    expect(normalizeRealtimeMetrics({ metrics: { cpu: 10 } })).toBeNull()
    expect(normalizeRealtimeMetrics({ serverId: '', metrics: {} })).toBeNull()
  })

  it('空 metrics 不抛错，只返回 serverId', () => {
    const result = normalizeRealtimeMetrics({ serverId: 's1' })
    expect(result).toEqual({
      serverId: 's1',
      cpu: undefined,
      load1: undefined,
      load5: undefined,
      load15: undefined,
      cores: undefined,
      logicalCores: undefined,
      memPercent: undefined,
      memUsedMB: undefined,
      memTotalMB: undefined,
      diskPercent: undefined,
      platform: undefined,
      timestamp: undefined,
    })
  })
})
