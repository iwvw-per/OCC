// ============================================
// Sound Player - 统一声音播放服务
// ============================================
//
// 职责：
// 1. 内置音效播放（真实采样音频，Vite 打包为静态资源）
// 2. 自定义音频播放（用户上传的音频 Blob）
// 3. 音量控制（统一映射到 0-100 滑条语义）
// 4. 试听 & 真实播放共用一套逻辑
//
// 音量语义：0 = 静音，50 = 正常基准，100 = 安全最大
//
// ⚠️ 历史：内置音效原本用 Web Audio 现场合成（裸 OscillatorNode 直连 destination，
// 只用 gain 做指数衰减）。听感「发闷、刺耳、有'噗'声」，原因是合成路径缺少
// 波形整形与抗混叠处理：方波/锯齿方波自带大量高次谐波，指数收尾到 0.001 在曲线上
// 是不连续的一阶导数，听感即爆音/电流声。现改为**真实采样音频**（45ms~0.9s 的
// 短音效，合计约 52KB），从根本上解决音质问题。

import type { NotificationType } from '../store/notificationStore'
import { logger } from './logger'

// 内置音效资源：Vite 会把它们打包为带 hash 的静态文件并返回 URL。
import chimeUrl from '../assets/sounds/chime.mp3'
import successUrl from '../assets/sounds/success.mp3'
import bellUrl from '../assets/sounds/bell.mp3'
import knockUrl from '../assets/sounds/knock.mp3'
import alertUrl from '../assets/sounds/alert.mp3'
import tapUrl from '../assets/sounds/tap.mp3'
import pingUrl from '../assets/sounds/ping.mp3'
import bubbleUrl from '../assets/sounds/bubble.mp3'
import popUrl from '../assets/sounds/pop.mp3'
import errorUrl from '../assets/sounds/error.mp3'
import buzzUrl from '../assets/sounds/buzz.mp3'
import warningUrl from '../assets/sounds/warning.mp3'

// ============================================
// 内置音效 ID
// ============================================

export const BUILTIN_SOUNDS = {
  // completed
  'builtin:chime': 'notifications.sounds.chime',
  'builtin:success': 'notifications.sounds.success',
  'builtin:bell': 'notifications.sounds.bell',
  // permission
  'builtin:knock': 'notifications.sounds.knock',
  'builtin:alert': 'notifications.sounds.alert',
  'builtin:tap': 'notifications.sounds.tap',
  // question
  'builtin:ping': 'notifications.sounds.ping',
  'builtin:bubble': 'notifications.sounds.bubble',
  'builtin:pop': 'notifications.sounds.pop',
  // error
  'builtin:error': 'notifications.sounds.error',
  'builtin:buzz': 'notifications.sounds.buzz',
  'builtin:warning': 'notifications.sounds.warning',
} as const

export type BuiltinSoundId = keyof typeof BUILTIN_SOUNDS

/** 内置音效 → 采样音频 URL */
const BUILTIN_SOUND_URLS: Record<BuiltinSoundId, string> = {
  'builtin:chime': chimeUrl,
  'builtin:success': successUrl,
  'builtin:bell': bellUrl,
  'builtin:knock': knockUrl,
  'builtin:alert': alertUrl,
  'builtin:tap': tapUrl,
  'builtin:ping': pingUrl,
  'builtin:bubble': bubbleUrl,
  'builtin:pop': popUrl,
  'builtin:error': errorUrl,
  'builtin:buzz': buzzUrl,
  'builtin:warning': warningUrl,
}

// 每类事件推荐的默认音效
export const DEFAULT_SOUNDS: Record<NotificationType, BuiltinSoundId> = {
  completed: 'builtin:chime',
  permission: 'builtin:knock',
  question: 'builtin:ping',
  error: 'builtin:error',
}

// 每类事件的推荐内置音效列表
export const SOUND_OPTIONS: Record<NotificationType, BuiltinSoundId[]> = {
  completed: ['builtin:chime', 'builtin:success', 'builtin:bell'],
  permission: ['builtin:knock', 'builtin:alert', 'builtin:tap'],
  question: ['builtin:ping', 'builtin:bubble', 'builtin:pop'],
  error: ['builtin:error', 'builtin:buzz', 'builtin:warning'],
}

// ============================================
// AudioContext 单例
// ============================================

let _audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (_audioCtx && _audioCtx.state !== 'closed') return _audioCtx
  try {
    _audioCtx = new (
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    )()
    return _audioCtx
  } catch {
    return null
  }
}

/** 检查当前环境是否支持声音播放 */
export function isSoundSupported(): boolean {
  return (
    typeof AudioContext !== 'undefined' ||
    typeof (window as unknown as Record<string, unknown>).webkitAudioContext !== 'undefined'
  )
}

// ============================================
// 音量映射：UI 0-100 → 实际增益
// 50 = 正常基准 (gain=0.35)
// 100 = 安全最大 (gain=0.7)
// 0 = 静音
// ============================================

function volumeToGain(volume: number): number {
  if (volume <= 0) return 0
  if (volume >= 100) return 0.7
  if (volume <= 50) {
    // 0-50 线性映射到 0-0.35
    return (volume / 50) * 0.35
  }
  // 50-100 线性映射到 0.35-0.7
  return 0.35 + ((volume - 50) / 50) * 0.35
}

// ============================================
// 内置音效：解码缓存
// ============================================
//
// 采样音频体积很小(单个 3~6KB),但每次播放都走 fetch + decodeAudioData 会引入
// 明显延迟(提示音必须在事件到达的当帧响起)。这里按 URL 缓存解码结果:
//   - 播放时若已缓存,直接建 BufferSource 播放;
//   - 未缓存则先发起加载,解码完成后播放,之后命中缓存。

const decodedBuiltin = new Map<string, AudioBuffer>()
const loadingBuiltin = new Map<string, Promise<AudioBuffer | null>>()

function loadBuiltinBuffer(url: string): Promise<AudioBuffer | null> {
  const cached = decodedBuiltin.get(url)
  if (cached) return Promise.resolve(cached)
  const inflight = loadingBuiltin.get(url)
  if (inflight) return inflight

  const task = (async (): Promise<AudioBuffer | null> => {
    const ctx = getAudioContext()
    if (!ctx) return null
    try {
      const response = await fetch(url)
      if (!response.ok) return null
      const arrayBuffer = await response.arrayBuffer()
      const buffer = await ctx.decodeAudioData(arrayBuffer)
      decodedBuiltin.set(url, buffer)
      return buffer
    } catch (err) {
      if (import.meta.env.DEV) {
        logger.warn('[SoundPlayer] Failed to load builtin sound:', url, err)
      }
      return null
    } finally {
      loadingBuiltin.delete(url)
    }
  })()

  loadingBuiltin.set(url, task)
  return task
}

/**
 * 预加载某个内置音效(试听/进入设置页时调用),失败静默。
 *
 * 首帧播放虽然会在解码后补放,但首次点击试听仍会有几十毫秒延迟;
 * 提前预热能让试听与真实提示音都即时发声。
 */
export function preloadBuiltinSound(soundId: string): void {
  if (!soundId.startsWith('builtin:')) return
  const url = BUILTIN_SOUND_URLS[soundId as BuiltinSoundId]
  if (url) void loadBuiltinBuffer(url)
}

// ============================================
// 播放内置音效
// ============================================

function playBuiltinSound(soundId: BuiltinSoundId, volume: number): void {
  const ctx = getAudioContext()
  if (!ctx) return

  // 恢复挂起的 AudioContext（浏览器 autoplay 策略）
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }

  const start = (buffer: AudioBuffer) => {
    const source = ctx.createBufferSource()
    const gainNode = ctx.createGain()
    source.buffer = buffer
    gainNode.gain.setValueAtTime(volumeToGain(volume), ctx.currentTime)
    source.connect(gainNode).connect(ctx.destination)
    source.start(0)
  }

  const url = BUILTIN_SOUND_URLS[soundId]
  const cached = decodedBuiltin.get(url)
  if (cached) {
    start(cached)
    return
  }
  // 首次播放:等解码完成再响,而不是静默失败;之后都走缓存。
  void loadBuiltinBuffer(url).then(buffer => {
    if (buffer) start(buffer)
  })
}

// ============================================
// 播放自定义音频（Blob/URL）
// ============================================

async function playCustomSound(audioData: Blob | string, volume: number): Promise<void> {
  const ctx = getAudioContext()
  if (!ctx) return

  if (ctx.state === 'suspended') {
    await ctx.resume()
  }

  let arrayBuffer: ArrayBuffer

  if (typeof audioData === 'string') {
    // data URL 或 object URL
    const response = await fetch(audioData)
    arrayBuffer = await response.arrayBuffer()
  } else {
    arrayBuffer = await audioData.arrayBuffer()
  }

  const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
  const source = ctx.createBufferSource()
  const gainNode = ctx.createGain()

  source.buffer = audioBuffer
  gainNode.gain.setValueAtTime(volumeToGain(volume), ctx.currentTime)
  source.connect(gainNode).connect(ctx.destination)
  source.start(0)
}

// ============================================
// 公共 API
// ============================================

export interface PlaySoundOptions {
  soundId: string // 'builtin:xxx' 或 'custom'
  customAudioData?: Blob | null
  volume: number // 0-100
}

/**
 * 播放提示音（内置或自定义）
 * 统一入口，试听和真实播放都走这里
 */
export function playSound(options: PlaySoundOptions): void {
  const { soundId, customAudioData, volume } = options

  if (volume <= 0) return
  if (!isSoundSupported()) return

  if (soundId === 'custom' && customAudioData) {
    playCustomSound(customAudioData, volume).catch(err => {
      if (import.meta.env.DEV) {
        logger.warn('[SoundPlayer] Failed to play custom sound:', err)
      }
    })
  } else if (soundId.startsWith('builtin:')) {
    playBuiltinSound(soundId as BuiltinSoundId, volume)
  }
}
