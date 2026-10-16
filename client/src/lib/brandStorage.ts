export const BRAND_KEY = 'nalu-active-brand'
const LEGACY_KEY = 'nalu.brandkit.v2'
export const UNOWNED_BRAND_KEY = 'nalu.brandkit.unowned.v1'

/** The old dotted key survived logout, so even a current owner marker cannot
 * establish who selected it. Keep its exact bytes locally, never upload or
 * display it as the next account's brand. New selections use the account journal.
 */
export function quarantineLegacyBrand(): boolean {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy === null) return true
    const saved = JSON.parse(localStorage.getItem(UNOWNED_BRAND_KEY) || '[]')
    if (!Array.isArray(saved) || saved.some(value => typeof value !== 'string')) return false
    if (!saved.includes(legacy)) localStorage.setItem(UNOWNED_BRAND_KEY, JSON.stringify([...saved, legacy]))
    localStorage.removeItem(LEGACY_KEY)
    return true
  } catch { return false }
}
