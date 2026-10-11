import {
  cloneElement,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

type TooltipSide = 'top' | 'bottom'

type TooltipChildProps = {
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void
  onPointerMove?: (event: PointerEvent<HTMLElement>) => void
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void
  onFocus?: (event: FocusEvent<HTMLElement>) => void
  onBlur?: (event: FocusEvent<HTMLElement>) => void
  'aria-describedby'?: string
}

interface TooltipProps {
  content: ReactNode
  children: ReactElement<TooltipChildProps>
  side?: TooltipSide
}

interface TooltipPosition {
  top: number
  left: number
  side: TooltipSide
  arrowLeft: number
}

interface TooltipAnchor {
  element: HTMLElement
  pointerX: number | null
}

const VIEWPORT_GUTTER = 12
const TOOLTIP_GAP = 8

function hasTooltipContent(content: ReactNode) {
  return content !== null && content !== undefined && content !== ''
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

function resolveTooltipPosition(
  anchorRect: DOMRect,
  tooltipRect: DOMRect,
  preferredSide: TooltipSide,
  pointerX: number | null,
): TooltipPosition {
  const viewportWidth = Math.max(window.innerWidth, document.documentElement.clientWidth)
  const viewportHeight = Math.max(window.innerHeight, document.documentElement.clientHeight)
  const tooltipWidth = Math.min(
    Math.max(tooltipRect.width, 1),
    Math.max(1, viewportWidth - VIEWPORT_GUTTER * 2),
  )
  const tooltipHeight = Math.min(
    Math.max(tooltipRect.height, 1),
    Math.max(1, viewportHeight - VIEWPORT_GUTTER * 2),
  )
  const anchorX = pointerX ?? anchorRect.left + anchorRect.width / 2
  const topCandidate = anchorRect.top - TOOLTIP_GAP - tooltipHeight
  const bottomCandidate = anchorRect.bottom + TOOLTIP_GAP
  const topFits = topCandidate >= VIEWPORT_GUTTER
  const bottomFits = bottomCandidate + tooltipHeight <= viewportHeight - VIEWPORT_GUTTER
  const side =
    preferredSide === 'top'
      ? topFits || !bottomFits
        ? 'top'
        : 'bottom'
      : bottomFits || !topFits
        ? 'bottom'
        : 'top'
  const top = clamp(
    side === 'top' ? topCandidate : bottomCandidate,
    VIEWPORT_GUTTER,
    viewportHeight - tooltipHeight - VIEWPORT_GUTTER,
  )
  const left = clamp(
    anchorX - tooltipWidth / 2,
    VIEWPORT_GUTTER,
    viewportWidth - tooltipWidth - VIEWPORT_GUTTER,
  )
  const arrowInset = Math.min(12, tooltipWidth / 2)

  return {
    top,
    left,
    side,
    arrowLeft: clamp(anchorX - left, arrowInset, tooltipWidth - arrowInset),
  }
}

export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  const [anchor, setAnchor] = useState<TooltipAnchor | null>(null)
  const [position, setPosition] = useState<TooltipPosition | null>(null)
  const anchorRef = useRef<TooltipAnchor | null>(null)
  const tooltipRef = useRef<HTMLSpanElement | null>(null)
  const tooltipId = useId()
  const enabled = hasTooltipContent(content)

  const updatePosition = useCallback(() => {
    if (!anchor || !tooltipRef.current) return
    setPosition(
      resolveTooltipPosition(
        anchor.element.getBoundingClientRect(),
        tooltipRef.current.getBoundingClientRect(),
        side,
        anchor.pointerX,
      ),
    )
  }, [anchor, side])

  useLayoutEffect(() => {
    if (!anchor) return
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition)
    resizeObserver?.observe(anchor.element)
    if (tooltipRef.current) resizeObserver?.observe(tooltipRef.current)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      resizeObserver?.disconnect()
    }
  }, [anchor, content, updatePosition])

  const show = (target: HTMLElement, pointerX: number | null = null) => {
    if (!enabled) return
    const currentAnchor = anchorRef.current
    const preservePointerAnchor = pointerX === null && currentAnchor?.element === target
    const nextAnchor = {
      element: target,
      pointerX: preservePointerAnchor ? currentAnchor.pointerX : pointerX,
    }
    anchorRef.current = nextAnchor
    if (!preservePointerAnchor) setPosition(null)
    setAnchor(nextAnchor)
  }

  const updatePointerAnchor = (target: HTMLElement, pointerX: number) => {
    const currentAnchor = anchorRef.current
    if (currentAnchor?.element !== target) {
      show(target, pointerX)
      return
    }

    const nextAnchor = { element: target, pointerX }
    anchorRef.current = nextAnchor
    setAnchor(nextAnchor)
  }

  const hide = () => {
    anchorRef.current = null
    setAnchor(null)
    setPosition(null)
  }

  if (!enabled) return children

  const existingDescription = children.props['aria-describedby']
  const trigger = cloneElement(children, {
    'aria-describedby': anchor
      ? [existingDescription, tooltipId].filter(Boolean).join(' ')
      : existingDescription,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      children.props.onPointerEnter?.(event)
      show(event.currentTarget, event.clientX)
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      children.props.onPointerMove?.(event)
      updatePointerAnchor(event.currentTarget, event.clientX)
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      children.props.onPointerDown?.(event)
      updatePointerAnchor(event.currentTarget, event.clientX)
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      children.props.onPointerLeave?.(event)
      hide()
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event)
      show(event.currentTarget)
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event)
      hide()
    },
  })

  const tooltip =
    anchor && typeof document !== 'undefined'
      ? createPortal(
          <span
            ref={tooltipRef}
            id={tooltipId}
            className={`echo-tooltip echo-tooltip--${position?.side ?? side}`}
            role="tooltip"
            data-tooltip-side={position?.side ?? side}
            style={
              {
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                visibility: position ? 'visible' : 'hidden',
                '--echo-tooltip-arrow-left': `${position?.arrowLeft ?? 0}px`,
              } as CSSProperties
            }
          >
            {content}
          </span>,
          document.body,
        )
      : null

  return (
    <>
      {trigger}
      {tooltip}
    </>
  )
}
