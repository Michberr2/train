type TitleData = { title?: unknown; titleUpdatedAt?: unknown }

/** An explicit rename survives richer histories and stale clients without it. */
export function mergeChatTitle(preferred: TitleData, other: TitleData): { title: string; titleUpdatedAt?: number } {
  const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  const chosen = time(other.titleUpdatedAt) > time(preferred.titleUpdatedAt) ? other : preferred
  return { title: typeof chosen.title === 'string' ? chosen.title : '', ...(time(chosen.titleUpdatedAt) ? { titleUpdatedAt: time(chosen.titleUpdatedAt) } : {}) }
}
