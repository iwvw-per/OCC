import { useCallback, useState, useEffect, useRef } from 'react'

export function useInView(options: IntersectionObserverInit & { triggerOnce?: boolean } = {}) {
  const [inView, setInView] = useState(false)
  const [hasTriggered, setHasTriggered] = useState(false)
  // 回调 ref：节点（重新）挂载后要重新订阅 —— 仅靠声明期解构 ref.current
  // 会漏掉「首次渲染时节点还不存在」或「节点被替换」的场景（如折叠面板开合）。
  const [, setNode] = useState<HTMLDivElement | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  const { root = null, rootMargin, threshold, triggerOnce } = options

  const setRef = useCallback((node: HTMLDivElement | null) => {
    ref.current = node
    setNode(node)
  }, [])

  useEffect(() => {
    // triggerOnce 已触发过，不再观察
    if (triggerOnce && hasTriggered) return

    const element = ref.current
    if (!element) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true)
          if (triggerOnce) {
            setHasTriggered(true)
            observer.unobserve(element)
          }
        } else {
          if (!triggerOnce) {
            setInView(false)
          }
        }
      },
      { root, rootMargin, threshold },
    )

    observer.observe(element)

    return () => {
      observer.disconnect()
    }
  }, [root, rootMargin, threshold, triggerOnce, hasTriggered])

  // triggerOnce 模式下，一旦触发过就永远返回 true
  return { ref: setRef, inView: (triggerOnce && hasTriggered) || inView }
}
