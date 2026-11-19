/**
 * useAutoScroll — React 移植自 oc 的 createAutoScroll
 *
 * 核心机制：
 * - userScrolled: 用户离开底部后置 true，阻止程序拉回底部
 * - markAuto/isAuto: 程序滚动时打标记（1500ms TTL, 2px 容差），
 *   防止自己的 scrollToBottom 被误判为用户滚动
 * - handleScroll 可无手势门控调用：靠 isAuto 区分程序滚动
 * - 所有回调稳定（useCallback + useMemo），避免 ref 回调重挂载
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const AUTO_TTL = 1500
const AUTO_TOLERANCE = 2
/** 程序滚动后短暂抑制 overlay 滚动条,避免自动输出时滚动条反复闪现 */
const SUPPRESS_ATTR = 'data-os-suppress'
const SUPPRESS_MS = 160
// 上滚离底的确认距离（px）：手指刚离开底部的一两像素不触发收起，留一点死区，
// 避免滚动起手就把输入框收掉。只有累计上移超过此值才判为用户主动离底。
const UPWARD_ESCAPE_PX = 24

export function useAutoScroll(bottomThreshold = 10) {
  const scrollElRef = useRef<HTMLElement | undefined>(undefined)
  const contentElRef = useRef<HTMLElement | undefined>(undefined)
  const userScrolledRef = useRef(false)
  const [userScrolled, setUserScrolled] = useState(false)

  const autoMark = useRef<{ top: number; time: number } | undefined>(undefined)
  const autoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 上滚待确认：记录 wheel 时的 scrollTop，等 scroll 事件确认真的移动后再置 userScrolled。
  // 未确认就置位会让「收起输入框」早于滚动触发，见 handleWheel 注释。
  const pendingUpwardRef = useRef<number | null>(null)
  const pendingUpwardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setScrolled = useCallback((v: boolean) => {
    userScrolledRef.current = v
    setUserScrolled(v)
  }, [])

  const markAuto = useCallback((el?: HTMLElement | null) => {
    const target = el ?? scrollElRef.current
    if (!target) return
    autoMark.current = { top: target.scrollHeight - target.clientHeight, time: Date.now() }
    if (autoTimer.current) clearTimeout(autoTimer.current)
    autoTimer.current = setTimeout(() => {
      autoMark.current = undefined
    }, AUTO_TTL)

    // 程序滚动(贴底跟随 / 流式输出)不展示滚动条:短暂打标,由 overlayScrollbar 读取。
    target.setAttribute(SUPPRESS_ATTR, '')
    if (suppressTimer.current) clearTimeout(suppressTimer.current)
    suppressTimer.current = setTimeout(() => {
      suppressTimer.current = undefined
      target.removeAttribute(SUPPRESS_ATTR)
    }, SUPPRESS_MS)
  }, [])

  const isAuto = useCallback((el: HTMLElement) => {
    const a = autoMark.current
    if (!a) return false
    if (Date.now() - a.time > AUTO_TTL) {
      autoMark.current = undefined
      return false
    }
    return Math.abs(el.scrollTop - a.top) < AUTO_TOLERANCE
  }, [])

  const scrollToBottom = useCallback(
    (force: boolean) => {
      const el = scrollElRef.current
      if (!el) return
      if (force && userScrolledRef.current) setScrolled(false)
      if (!force && userScrolledRef.current) return
      const max = Math.max(0, el.scrollHeight - el.clientHeight)
      if (max - el.scrollTop < 2) {
        markAuto(el)
        return
      }
      markAuto(el)
      el.scrollTop = max
    },
    [markAuto, setScrolled],
  )

  const stop = useCallback(() => {
    const el = scrollElRef.current
    if (!el) return
    if (el.scrollHeight - el.clientHeight <= 1) {
      if (userScrolledRef.current) setScrolled(false)
      return
    }
    if (userScrolledRef.current) return
    setScrolled(true)
  }, [setScrolled])

  const handleScroll = useCallback(() => {
    const el = scrollElRef.current
    if (!el) return
    // 确认上滚：wheel 记录的起始位置累计上移超过死区，才算用户真的离底。
    // 留 UPWARD_ESCAPE_PX 的余量，起手的一两像素不触发收起。
    if (pendingUpwardRef.current !== null) {
      const from = pendingUpwardRef.current
      if (from - el.scrollTop >= UPWARD_ESCAPE_PX) {
        pendingUpwardRef.current = null
        if (pendingUpwardTimerRef.current !== null) {
          clearTimeout(pendingUpwardTimerRef.current)
          pendingUpwardTimerRef.current = null
        }
        if (!userScrolledRef.current) setScrolled(true)
      } else if (el.scrollTop > from) {
        // 手势回退到起点以下：重置基线，等待下一次上滚
        pendingUpwardRef.current = null
      }
    }
    const max = el.scrollHeight - el.clientHeight
    if (max <= 1) {
      // isAuto 守卫：程序滚动（applyScrollAdjustment 经 scrollToFn→markAuto）
      // 不清 userScrolled，只有真实用户滚动到无溢出时才清。
      if (userScrolledRef.current && !isAuto(el)) setScrolled(false)
      return
    }
    if (max - el.scrollTop < bottomThreshold) {
      // 用户已离底时，只有用户主动滚回底才清 userScrolled。
      // 程序滚动路径（resizeItem → queueMicrotask）受 shouldAnchorBottom 守卫，
      // 用户离底时不会产生自动回底滚动——所以 isAuto 标记的 scroll 事件到达
      // 这里只能是用户真实手势，直接清。
      if (userScrolledRef.current) setScrolled(false)
      return
    }
    if (!userScrolledRef.current && isAuto(el)) {
      scrollToBottom(false)
      return
    }
    // 未离底时，距底超过死区才允许 stop() 置位。触屏没有 wheel 事件，
    // 收起完全由这里驱动，所以死区必须在这里也生效——否则轻扫一下就把输入框收掉。
    if (!userScrolledRef.current && max - el.scrollTop < UPWARD_ESCAPE_PX) return
    stop()
  }, [bottomThreshold, isAuto, scrollToBottom, setScrolled, stop])

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      const el = scrollElRef.current
      if (!el) return
      const max = el.scrollHeight - el.clientHeight
      // 容器无溢出时忽略所有 wheel 事件——空白页 spacer 产生的小溢出不该触发折叠
      if (max <= 1) return
      if (e.deltaY >= 0) {
        // 下滚回底时恢复贴底跟随：用户主动下滚到阈值内才清 userScrolled。
        // 流式增长推回不会走这里（不是 wheel 事件）。
        if (userScrolledRef.current) {
          if (max - el.scrollTop < bottomThreshold) setScrolled(false)
        }
        return
      }
      // 上滚立刻离底。清除 auto 标记避免后续 scroll 事件被误判为程序滚动。
      autoMark.current = undefined
      const nested = (e.target instanceof Element ? e.target : undefined)?.closest('[data-scrollable]')
      if (nested && nested !== el) return

      // 已在顶部时上滚：scrollTop 无法再下降，永远等不到「确认移动」，
      // 于是 userScrolled 一直为 false，上滑加载更早历史的判定（依赖
      // userScrolledRef）就永远不会成立 —— 表现为「会话最前面几轮看不到、
      // 怎么滚都不加载」。此时上滚手势本身就是「用户想往上看」的确证，
      // 直接置位。
      if (el.scrollTop <= 0) {
        if (!userScrolledRef.current) setScrolled(true)
        return
      }

      if (userScrolledRef.current) return
      // 不要在这里立即置位。wheel 事件到达时 scrollTop 往往还没变（浏览器在下一帧
      // 才真正滚动），此时置位会让「收起输入框」比滚动早一帧触发；若这次 wheel
      // 最终被虚拟列表吸收、没有产生实际滚动，就等于凭空收起一次。
      // 改为记录上滚前的 scrollTop，交给 scroll 事件确认真的移动后再置位。
      //
      // 基线只在没有待确认时记录一次：连续上滚会不断派发 wheel，若每个都重置基线，
      // 累计位移永远追不上死区，收起就再也不会触发。
      //
      // 实测（scripts/probe-collapse-trigger.mjs）：不确认时 isCollapsed 会在
      // scrollTop 完全未变的情况下翻 true，动画空跑一遍；真实滚动随后发生又翻回，
      // 视觉上表现为「首帧抽两下」。
      if (pendingUpwardRef.current === null) pendingUpwardRef.current = el.scrollTop
      // 兜底：部分环境下 scroll 事件的 scrollTop 与 wheel 同步更新、或容器不产生
      // scroll 事件（滚动被完全吸收）。超过一帧仍未确认就不再等待，避免上滚需要
      // 「先动一下才生效」的迟滞感。
      if (pendingUpwardTimerRef.current !== null) clearTimeout(pendingUpwardTimerRef.current)
      pendingUpwardTimerRef.current = window.setTimeout(() => {
        pendingUpwardTimerRef.current = null
        const from = pendingUpwardRef.current
        pendingUpwardRef.current = null
        if (from === null) return
        const el2 = scrollElRef.current
        if (!el2) return
        // 只有确实没动过才放弃；动过则由 scroll 事件负责置位。
        // 同样要越过死区才算离底，起手的一两像素不收起。
        if (from - el2.scrollTop < UPWARD_ESCAPE_PX) return
        setScrolled(true)
      }, 120)
    },
    [bottomThreshold, setScrolled],
  )

  const handleInteraction = useCallback(() => {
    const sel = window.getSelection()
    if (sel && sel.toString().length > 0) stop()
  }, [stop])

  const setScrollRef = useCallback((el: HTMLElement | null) => {
    scrollElRef.current = el ?? undefined
    if (el) el.style.overflowAnchor = 'none'
  }, [])

  const setContentRef = useCallback((el: HTMLElement | null) => {
    contentElRef.current = el ?? undefined
  }, [])

  // 不使用 contentRef ResizeObserver：
  // measureElement 内置 RO → resizeItem → applyScrollAdjustment 已经处理了贴底。
  // contentRef RO 会在 item 首次测量时触发（container height 变化），
  // 把 scrollTop 拉回底部，覆盖 applyScrollAdjustment 的正确行为。

  useEffect(
    () => () => {
      if (autoTimer.current) clearTimeout(autoTimer.current)
      if (suppressTimer.current) clearTimeout(suppressTimer.current)
      scrollElRef.current?.removeAttribute(SUPPRESS_ATTR)
      if (pendingUpwardTimerRef.current !== null) clearTimeout(pendingUpwardTimerRef.current)
    },
    [],
  )

  const reset = useCallback(() => {
    setScrolled(false)
  }, [setScrolled])

  const resume = useCallback(() => {
    setScrolled(false)
    scrollToBottom(true)
  }, [scrollToBottom, setScrolled])
  const scrollToBottomCb = useCallback(() => scrollToBottom(false), [scrollToBottom])
  const forceScrollToBottom = useCallback(() => scrollToBottom(true), [scrollToBottom])

  return useMemo(
    () => ({
      setScrollRef,
      setContentRef,
      handleScroll,
      handleWheel,
      handleInteraction,
      pause: stop,
      reset,
      resume,
      markAuto,
      scrollToBottom: scrollToBottomCb,
      forceScrollToBottom,
      userScrolledRef,
      userScrolled,
    }),
    [
      setScrollRef,
      setContentRef,
      handleScroll,
      handleWheel,
      handleInteraction,
      stop,
      reset,
      resume,
      markAuto,
      scrollToBottomCb,
      forceScrollToBottom,
      userScrolled,
    ],
  )
}
