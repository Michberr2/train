import { useId } from 'react'
import type { SlideScene } from './slideScene'
import { slideFontCss } from './slideFonts'

export function SlideSceneView({ scene, thumbnail = false }: { scene: SlideScene; thumbnail?: boolean }) {
  const id = useId().replace(/:/g, '')
  return <svg data-slide-artboard viewBox={`0 0 ${scene.width} ${scene.height}`} className="block h-auto w-full" style={{ aspectRatio: '16 / 9', background: scene.background }} role={thumbnail ? undefined : 'img'} aria-hidden={thumbnail || undefined} aria-label={thumbnail ? undefined : scene.title}>
    <defs><clipPath id={id}><rect width={scene.width} height={scene.height} /></clipPath></defs>
    <g clipPath={`url(#${id})`}>
      {scene.nodes.map((node, i) => {
        if (node.type === 'rect') return <rect key={i} x={node.x} y={node.y} width={Math.max(0, node.w)} height={Math.max(0, node.h)} rx={node.radius || 0} fill={node.fill} stroke={node.stroke} strokeWidth={node.strokeWidth} opacity={node.opacity} />
        if (node.type === 'line') return <line key={i} x1={node.x} y1={node.y} x2={node.x + node.w} y2={node.y + node.h} stroke={node.color} strokeWidth={node.width} />
        if (node.type === 'text') return <text key={i} data-slide-text fontFamily={node.fontFamily || slideFontCss(node.fontFace)} fontSize={node.fontSize} fontWeight={node.bold ? 700 : 400} fontStyle={node.italic ? 'italic' : undefined} fill={node.color} textAnchor={node.align === 'center' ? 'middle' : node.align === 'right' ? 'end' : 'start'}>
          {node.lines.map((line, j) => <tspan key={j} x={node.x + (node.align === 'center' ? node.w / 2 : node.align === 'right' ? node.w : 0)} y={node.y + node.fontSize * .82 + j * node.lineHeight}>{line}</tspan>)}
        </text>
        return <image key={i} x={node.x} y={node.y} width={node.w} height={node.h} href={node.src} preserveAspectRatio={node.type === 'chart' || node.fit === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice'} />
      })}
    </g>
  </svg>
}
