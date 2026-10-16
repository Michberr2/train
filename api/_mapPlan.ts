/** A narrow grammar for an ordinary POI lookup, not arbitrary map questions.
 * Ambiguous or analytical requests keep the full planning behavior. */
export function isPlainMapPlaceLookup(query: string): boolean {
  const text = query.trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ')
  if (!text || text.length > 180) return false
  if (/\b(?:compare|comparison|versus|vs|rank|best|analy[sz]e|analysis|outline|draw|boundary|boundaries|zone|zones|zoning|area|areas|region|regions|radius|route|routes|directions|distance|walk|walking|walkable|walkability|transit|traffic|flood|flooding|risk|risks|hazard|hazards|crime|safe|safety|income|demographic|demographics|population|density|heatmap|heat|overlay|overlays|layer|layers|catchment|school\s+district|price|prices|cost|costs|affordability|invest|investment)\b/i.test(text)) return false
  // A secondary instruction or relationship is outside the plain-lookup
  // grammar, even if its first words name a recognized business category.
  if (/[;\n]|\b(?:and|or|with|without|where|which|that|including|while|within|under|over)\b/i.test(text.replace(/^where\s+(?:are|is|can\s+i\s+(?:get|find|buy))\s+/i, ''))) return false
  const category = '(?:coffee(?: shops?| houses?)?|caf[eé]s?|espresso|restaurants?|diners?|pizza|baker(?:y|ies)|bars?|pubs?|brewer(?:y|ies)|hotels?|motels?|gyms?|pharmac(?:y|ies)|drug stores?|gas stations?|fuel stations?|grocer(?:y stores?|ies)|supermarkets?|banks?|atms?|hospitals?|clinics?|urgent care|dentists?|parks?|playgrounds?|parking|bookstores?|museums?|tire shops?|auto repair shops?|shops?|stores?)'
  const start = '(?:please )?(?:(?:can|could|would) you )?(?:(?:find|show|locate)(?: me)? |where (?:are|is|can i (?:get|find|buy)) )?(?:(?:the|a|an) )?(?:(?:nearest|nearby|local) )?'
  const location = '(?: (?:near|around|in|by|at|close to) [\\p{L}\\p{N}][\\p{L}\\p{N} ,.’\u0027-]{0,100}| nearby| near me)?'
  return new RegExp(`^${start}${category}${location}$`, 'iu').test(text)
}

/** Real Places will supply the pins; preserve its query and planned viewport. */
export function plainPlacePlan<T extends { search?: unknown; layers?: unknown; shapes?: unknown; comparison?: unknown }>(query: string, plan: T): T {
  if (typeof plan.search !== 'string' || !plan.search.trim() || !isPlainMapPlaceLookup(query)) return plan
  return { ...plan, layers: [], shapes: [], comparison: null }
}
