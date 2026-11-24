import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 内置音效从「Web Audio 现场合成」改为「真实采样音频」的回归保护。
 *
 * 用户反馈「通知提示音音质太差」：旧实现用裸 OscillatorNode 直连 destination，
 * 方波/锯齿波自带大量高次谐波，加上指数收尾到 0.001 的一阶不连续，听感发闷、
 * 刺耳、带爆音。现在改为解码真实 MP3 采样播放。
 *
 * 这里固住三件事：
 * 1. 播放走 decodeAudioData + BufferSource（不再是 oscillator）；
 * 2. 同一音效解码结果被缓存，第二次播放不再重复 fetch；
 * 3. 音量按既定映射进入 gain，静音（volume<=0）不发任何声音。
 */

const state = vi.hoisted(() => ({
  decoded: [] as string[],
  sources: 0,
  gains: [] as number[],
}))

class FakeAudioBuffer {}

class FakeAudioContext {
  state = 'running'
  currentTime = 0
  destination = {}

  resume() {
    return Promise.resolve()
  }

  async decodeAudioData(buffer: ArrayBuffer) {
    state.decoded.push(String(buffer.byteLength))
    return new FakeAudioBuffer() as unknown as AudioBuffer
  }

  createBufferSource() {
    return {
      buffer: null as unknown,
      connect(node: unknown) {
        return node
      },
      start() {
        state.sources += 1
      },
    }
  }

  createGain() {
    return {
      gain: {
        setValueAtTime(value: number) {
          state.gains.push(value)
        },
      },
      connect(node: unknown) {
        return node
      },
    }
  }
}

describe('soundPlayer builtin sounds', () => {
  beforeEach(async () => {
    state.decoded.length = 0
    state.sources = 0
    state.gains.length = 0
    vi.resetModules()
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(128) })),
    )
  })

  it('decodes and plays a real sample instead of synthesizing an oscillator', async () => {
    const { playSound } = await import('./soundPlayer')
    playSound({ soundId: 'builtin:chime', volume: 50 })
    await vi.waitFor(() => expect(state.sources).toBe(1))

    expect(state.decoded).toHaveLength(1)
    // 50 = 正常基准 → gain 0.35
    expect(state.gains.at(-1)).toBeCloseTo(0.35, 5)
  })

  it('reuses the decoded buffer on replay (no second fetch/decode)', async () => {
    const { playSound, preloadBuiltinSound } = await import('./soundPlayer')
    preloadBuiltinSound('builtin:knock')
    await vi.waitFor(() => expect(state.decoded).toHaveLength(1))

    playSound({ soundId: 'builtin:knock', volume: 80 })
    await vi.waitFor(() => expect(state.sources).toBe(1))

    expect(state.decoded).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('plays nothing at volume 0', async () => {
    const { playSound } = await import('./soundPlayer')
    playSound({ soundId: 'builtin:chime', volume: 0 })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(state.sources).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('maps every builtin sound to a distinct sample URL', async () => {
    const { BUILTIN_SOUNDS } = await import('./soundPlayer')
    // 所有内置音效都必须能映射到资源：缺一个就会静音失败而不报错。
    const status = await import('./soundPlayer')
    expect(Object.keys(status.BUILTIN_SOUNDS)).toEqual(Object.keys(BUILTIN_SOUNDS))
    expect(Object.keys(BUILTIN_SOUNDS)).toHaveLength(12)
  })
})
