/**
 * 可拖拽宽度。用 Pointer Capture 而不是 window 上挂 mousemove——
 * 拖到浏览器窗口外再松手也不会丢事件，且不用手动清理监听。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

export function useResizableWidth({
  storageKey,
  initial,
  min,
  max,
}: {
  storageKey: string
  initial: number
  min: number
  max: number
}) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return Number.isFinite(saved) && saved > 0 ? clamp(saved, min, max) : initial
  })
  const [dragging, setDragging] = useState(false)
  const origin = useRef({ x: 0, w: 0 })

  useEffect(() => {
    localStorage.setItem(storageKey, String(width))
  }, [storageKey, width])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      origin.current = { x: e.clientX, w: width }
      setDragging(true)
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [width]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      setWidth(clamp(origin.current.w + (e.clientX - origin.current.x), min, max))
    },
    [min, max]
  )

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    setDragging(false)
  }, [])

  /** 键盘可达：分隔条是 separator 角色，方向键调节，Home 复位 */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 48 : 16
      if (e.key === 'ArrowLeft') setWidth((w) => clamp(w - step, min, max))
      else if (e.key === 'ArrowRight') setWidth((w) => clamp(w + step, min, max))
      else if (e.key === 'Home') setWidth(initial)
      else return
      e.preventDefault()
    },
    [min, max, initial]
  )

  const reset = useCallback(() => setWidth(initial), [initial])

  return {
    width,
    dragging,
    /** 直接摊给分隔条元素 */
    handleProps: {
      role: 'separator' as const,
      'aria-orientation': 'vertical' as const,
      'aria-valuenow': Math.round(width),
      'aria-valuemin': min,
      'aria-valuemax': max,
      'aria-label': '调整侧栏宽度',
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
      onDoubleClick: reset,
      title: '拖动调整宽度，双击复位',
    },
  }
}
