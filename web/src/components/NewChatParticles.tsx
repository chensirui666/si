import { useEffect, useRef } from 'react'

const bands = [
  { color: '228,148,14', spread: .18, intensity: 1 },
  { color: '0,129,186', spread: .15, intensity: .86 },
  { color: '36,39,167', spread: .11, intensity: .76 },
]
const levels = 10
const fills = bands.flatMap(({ color }) => Array.from({ length: levels + 1 }, (_, level) =>
  `rgba(${color},${.98 * (level / levels) ** .65})`))

function drawParticles(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  elapsed: number,
  pointer: { x: number; y: number; strength: number },
) {
  if (!width || !height) return
  context.clearRect(0, 0, width, height)
  const phase = elapsed * .42
  const paths = fills.map(() => new Path2D())
  const step = width < 500 ? 4 : 4.5
  const radius = width < 500 ? 72 : 105

  for (let x = step / 2; x < width; x += step) {
    const across = x / width
    const waves = [
      .04 + .17 * Math.sin(across * 6 + phase) + .18 * across,
      .27 + .18 * Math.sin(across * 7 - phase * .8 + 2.25),
      .14 + .28 * Math.sin(across * 5 + phase * .6 - .9) + .15 * across,
    ]
    for (let y = step / 2; y < height; y += step) {
      const down = y / height
      const fade = (1 - down) ** 1.9
      let peak = 0
      let ink = 0
      for (let index = 0; index < bands.length; index++) {
        const band = bands[index]
        const distance = (down - waves[index]) / band.spread
        const edge = 1 - Math.min(1, distance * distance / 4)
        const density = edge * edge * band.intensity
        if (density > peak) {
          peak = density
          ink = index
        }
      }

      const distance = ((x - pointer.x) ** 2 + (y - pointer.y) ** 2) / radius ** 2
      const glow = pointer.strength * Math.max(0, 1 - distance) ** 2
      const weight = Math.min(1, peak * fade + glow * .55 * fade)
      const level = Math.round(weight * levels)
      if (!level) continue

      const grain = .87 + .13 * Math.sin(x * 33.21 + y * 7.13)
      const size = Math.min(step * .47, (.64 + weight * 1.56 + glow * .5) * grain)
      const dots = paths[ink * (levels + 1) + level]
      dots.moveTo(x + size, y)
      dots.arc(x, y, size, 0, Math.PI * 2)
    }
  }

  paths.forEach((dots, index) => {
    context.fillStyle = fills[index]
    context.fill(dots)
  })
}

export function NewChatParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = canvas?.parentElement
    if (!canvas || !stage || typeof Path2D !== 'function' || typeof ResizeObserver !== 'function') return
    const context = canvas.getContext('2d')
    if (!context) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const pointer = { x: 0, y: 0, strength: 0, inside: false }
    let width = 0
    let height = 0
    let elapsed = 0
    let frame = 0
    let last = 0

    const draw = () => drawParticles(context, width, height, elapsed, pointer)
    const resize = () => {
      const bounds = canvas.getBoundingClientRect()
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      width = bounds.width
      height = bounds.height
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      context.setTransform(scale, 0, 0, scale, 0, 0)
      draw()
    }
    const tick = (time: number) => {
      frame = 0
      if (reducedMotion.matches) {
        pointer.strength = 0
        draw()
        return
      }
      if (document.hidden) return

      const delta = time - last
      if (delta >= 30) {
        elapsed += Math.min(delta, 60) / 1000
        pointer.strength += ((pointer.inside ? 1 : 0) - pointer.strength) * .17
        last = time
        draw()
      }
      frame = requestAnimationFrame(tick)
    }
    const syncMotion = () => {
      cancelAnimationFrame(frame)
      frame = 0
      if (reducedMotion.matches) {
        pointer.strength = 0
        draw()
      } else if (!document.hidden) {
        last = performance.now()
        frame = requestAnimationFrame(tick)
      }
    }
    const movePointer = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect()
      pointer.x = event.clientX - bounds.left
      pointer.y = event.clientY - bounds.top
      pointer.inside = event.pointerType !== 'touch' && pointer.y >= 0 && pointer.y < height * .86
    }
    const leaveStage = () => { pointer.inside = false }

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    stage.addEventListener('pointermove', movePointer)
    stage.addEventListener('pointerleave', leaveStage)
    reducedMotion.addEventListener('change', syncMotion)
    document.addEventListener('visibilitychange', syncMotion)
    syncMotion()

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      stage.removeEventListener('pointermove', movePointer)
      stage.removeEventListener('pointerleave', leaveStage)
      reducedMotion.removeEventListener('change', syncMotion)
      document.removeEventListener('visibilitychange', syncMotion)
    }
  }, [])

  return <canvas ref={canvasRef} className="new-chat-particles" aria-hidden="true" />
}
