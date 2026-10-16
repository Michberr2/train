export type MapLayerSummary = {
  key: string; label: string; desc: string; cat: string; opacity: number; minZoom: number
  kind: string; url: string; tpl?: string; home?: [number, number, number]
}

export const isMapBackground = (layer: MapLayerSummary) => layer.cat === 'imagery' && layer.kind === 'xyz' && layer.opacity === 1

export function mapLayerOpacity(layer: MapLayerSummary, values: Record<string, number>, hidden: boolean, solo: string | null) {
  if (!isMapBackground(layer) && (hidden || (solo && solo !== layer.key))) return 0
  return values[layer.key] ?? layer.opacity
}

export function mapLayerZoomRange(layer: MapLayerSummary) {
  const cap = Number((layer.tpl || layer.url).match(/GoogleMapsCompatible_Level(\d+)/)?.[1] || 22)
  return [layer.minZoom, cap] as const
}

export function readMapDisplay() {
  try {
    const data = JSON.parse(localStorage.getItem('nalu-map-display') || '{}')
    const opacity: Record<string, number> = {}
    if (data && typeof data === 'object') {
      for (const [key, value] of Object.entries(data.opacity || {})) if (typeof value === 'number' && Number.isFinite(value)) opacity[key] = Math.max(0, Math.min(1, value))
      const view = data.view
      return { opacity, base: typeof data.base === 'string' ? data.base : 'dark', view: view && Number.isFinite(view.lat) && Math.abs(view.lat) <= 85 && Number.isFinite(view.lng) && Math.abs(view.lng) <= 180 && Number.isFinite(view.zoom) ? { lat: view.lat, lng: view.lng, zoom: Math.max(3, Math.min(22, view.zoom)) } : null }
    }
  } catch { /* Keep malformed preferences from blocking the map. */ }
  return { opacity: {} as Record<string, number>, base: 'dark', view: null }
}
