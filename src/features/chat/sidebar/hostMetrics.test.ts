import { describe, expect, it } from 'vitest'
import { instanceIdFromServerId } from '../../../api/aiagent'
import { formatBytes, formatMegabytes, isMetricsStale, parseRecordedAt, STALE_AFTER_MS } from './hostMetricsModel'

/**
 * `instanceIdFromServerId` 是从服务器 id 反查 AI Agent 实例的唯一入口。
 *
 * 侧栏主机监控靠它判断「当前服务器有没有实例指标可查」：
 * 判错会有两种后果 —— 非 AI Agent 服务器（手填 URL）被当成实例去请求（404 刷屏），
 * 或真正的实例服务器被误判成普通服务器导致整条监控不显示。
 */
describe('instanceIdFromServerId', () => {
  it('从 AI Agent 服务器 id 解析出实例 id', () => {
    expect(instanceIdFromServerId('aiagent:inst_def85b8e0e6fd6c626e17fa7')).toBe('inst_def85b8e0e6fd6c626e17fa7')
  })

  it('手填 URL 的普通服务器返回 null（没有实例指标）', () => {
    expect(instanceIdFromServerId('local')).toBeNull()
    expect(instanceIdFromServerId('http://127.0.0.1:4096')).toBeNull()
    expect(instanceIdFromServerId('')).toBeNull()
  })

  it('只有前缀没有实例 id 时返回 null，不产出空实例 id', () => {
    // 空串会被拼成 /instances//metrics，是无效请求
    expect(instanceIdFromServerId('aiagent:')).toBeNull()
  })

  it('实例 id 内部含冒号时完整保留', () => {
    expect(instanceIdFromServerId('aiagent:inst:a:b')).toBe('inst:a:b')
  })
})

/**
 * recordedAt 解析的回归用例。
 *
 * 服务端 `datetime('now')` 产出 `YYYY-MM-DD HH:MM:SS`（UTC 但无时区标记）：
 *   - Safari 不接受空格分隔 → `Date.parse` 返回 NaN → 整条监控被误判成「已停止更新」；
 *   - 无时区标记会被解析成本地时间 → 中国大陆差 8 小时 → 新鲜数据显示成过期。
 * 这两点都必须由解析函数兜住。
 */
describe('parseRecordedAt', () => {
  it('把无时区标记的服务端时间按 UTC 解析', () => {
    expect(parseRecordedAt('2026-11-01 14:00:00')).toBe(Date.UTC(2026, 10, 1, 14, 0, 0))
  })

  it('已带 Z 或偏移时原样保留', () => {
    expect(parseRecordedAt('2026-11-01T14:00:00Z')).toBe(Date.UTC(2026, 10, 1, 14, 0, 0))
    expect(parseRecordedAt('2026-11-01T22:00:00+08:00')).toBe(Date.UTC(2026, 10, 1, 14, 0, 0))
  })

  it('空值与非法值返回 null（调用方据此不做新鲜度判断）', () => {
    expect(parseRecordedAt(undefined)).toBeNull()
    expect(parseRecordedAt('')).toBeNull()
    expect(parseRecordedAt('not-a-date')).toBeNull()
  })
})

describe('isMetricsStale', () => {
  const base = Date.UTC(2026, 10, 1, 14, 0, 0)

  it('刚采到的不算停更', () => {
    expect(isMetricsStale('2026-11-01 14:00:00', base + 5_000)).toBe(false)
  })

  it('超过阈值即判定停更（采集停摆时不能继续显示旧值当实时）', () => {
    expect(isMetricsStale('2026-11-01 14:00:00', base + STALE_AFTER_MS + 1_000)).toBe(true)
  })

  it('没有时间戳时不判定停更（由调用方按「暂无数据」处理）', () => {
    expect(isMetricsStale(undefined, base)).toBe(false)
  })
})

describe('formatMegabytes（网关内存单位是 MB，不是字节）', () => {
  it('按 MB 换算：23972 MB → 23.4G', () => {
    // 实测网关返回值；误当字节会得到 "0M"
    expect(formatMegabytes(23972)).toBe('23.4G')
    expect(formatMegabytes(4020)).toBe('3.9G')
  })

  it('不足 1G 时显示 MB 整数', () => {
    expect(formatMegabytes(512)).toBe('512M')
  })
})

describe('formatBytes', () => {
  it('按 GB / MB 紧凑显示', () => {
    expect(formatBytes(16 * 1024 ** 3)).toBe('16.0G')
    expect(formatBytes(512 * 1024 ** 2)).toBe('512M')
    expect(formatBytes(6.7 * 1024 ** 3)).toBe('6.7G')
  })
})
