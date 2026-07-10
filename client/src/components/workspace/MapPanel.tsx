import { useEffect, useRef, useState } from 'react'
import { Search, Loader2, Star, MapPin, ExternalLink, Layers, Sparkles, Trash2, X, PanelLeftOpen } from 'lucide-react'
import { PARCEL_SVCS, parcelSvcFor, parcelFacts, permitSvcFor, queryPermitsNear, permitCities } from '../../lib/geoData'
import { useTheme } from '../ThemeProvider'

// Ploti-style real-estate map: AI/Places search, a stack of free open-source data
// layers, multiple base maps, and drawing tools (polygons/areas/markers) you can
// categorize. Drawn shapes persist. Parcel/zoning at national scale still needs a
// paid provider (Regrid/ATTOM) — everything else here is free + open.

type Place = {
  name: string; address: string; lat: number | null; lng: number | null
  rating: number | null; userRatings: number | null; priceLevel: number | null
  types: string[]; placeId: string; openNow: boolean | null; photoUrl: string | null
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GMaps = any

let mapsPromise: Promise<GMaps> | null = null
function teardownMaps() {
  document.querySelectorAll('script[src*="maps.googleapis.com/maps/api/js"]').forEach((s) => s.remove())
  try { delete (window as unknown as { google?: unknown }).google } catch { /* */ }
  mapsPromise = null
}
function loadMaps(key: string): Promise<GMaps> {
  const w = window as unknown as { google?: { maps?: unknown } }
  if (w.google?.maps) return Promise.resolve((w as { google: GMaps }).google)
  if (mapsPromise) return mapsPromise
  mapsPromise = new Promise<GMaps>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places,geometry`
    s.async = true; s.defer = true
    s.onload = async () => {
      const g = (window as unknown as { google?: GMaps }).google
      try { if (g?.maps?.importLibrary) await g.maps.importLibrary('maps') } catch { /* */ }
      if (g?.maps?.Map) resolve(g)
      else reject(new Error('Google Maps loaded but the Map class is unavailable — confirm "Maps JavaScript API" is enabled.'))
    }
    s.onerror = () => reject(new Error('Failed to load Google Maps — check the API key and that Maps JavaScript API is enabled.'))
    document.head.appendChild(s)
  })
  return mapsPromise
}

const DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#1c2230' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0d1018' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9aa4b8' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#13202e' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a3142' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#7e8aa3' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1d2a22' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#3a4255' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
]
// Warm "quiet-luxury" light map: cream land, near-white street grid, muted
// sage-green water & parks, warm-tan arterials — sampled from the reference.
const LIGHT_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#e9e5db' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#f4f1ea' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#6e665a' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#a6b6aa' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#f8f5ef' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#e7ddca' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#dccfb4' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#8a8175' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#c2cdb9' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#e4e0d3' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#cfc4b0' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
]
const GOLD = '#AF8C56'

const BASES = [
  { key: 'dark', label: 'Dark', gType: 'roadmap' as const },
  { key: 'satellite', label: 'Satellite', gType: 'hybrid' as const },
  { key: 'terrain', label: 'Terrain', gType: 'terrain' as const },
  { key: 'streets', label: 'Streets', gType: 'roadmap' as const },
]

// Web-Mercator tile bbox for ArcGIS dynamic "export" overlays.
function tileToBbox3857(x: number, y: number, z: number): [number, number, number, number] {
  const R = 20037508.342789244
  const n = Math.pow(2, z); const s = (2 * R) / n
  return [-R + x * s, R - (y + 1) * s, -R + (x + 1) * s, R - y * s]
}
// Layer categories (sections in the panel), in display order.
const LAYER_CATS: { key: string; label: string }[] = [
  { key: 'living', label: 'Homes & living' },
  { key: 'realestate', label: 'Real estate & land' },
  { key: 'boundaries', label: 'Boundaries & census' },
  { key: 'hazard', label: 'Hazards & risk' },
  { key: 'wildfire', label: 'Wildfire & smoke' },
  { key: 'weather', label: 'Weather & radar' },
  { key: 'climate', label: 'Climate & drought' },
  { key: 'water', label: 'Water & hydrology' },
  { key: 'nature', label: 'Nature & conservation' },
  { key: 'agriculture', label: 'Agriculture & soils' },
  { key: 'geology', label: 'Geology & energy' },
  { key: 'infra', label: 'Infrastructure' },
  { key: 'demographics', label: 'Demographics & society' },
  { key: 'imagery', label: 'Imagery & terrain' },
]
type LayerDef = {
  key: string; label: string; desc: string; cat: string; opacity: number; minZoom: number
  acs?: { service: string; field: string; fmt: 'usd' | 'pct' | 'num' | 'density'; denom?: string }
  kind: 'xyz' | 'export' | 'feature' | 'wms' | 'acs'; url: string; layers?: string
  // Optional explicit tile template ({z}/{x}/{y}/{-y}/{s}) — for XYZ/WMTS sources
  // like NASA GIBS that don't fit the two default patterns.
  tpl?: string
  // "Showcase" view [lat, lng, zoom] for sparse/regional data: enabling the layer
  // from the panel jumps here so the button ALWAYS shows visible data.
  home?: [number, number, number]
}
// Every entry below was endpoint-verified to serve live tiles (no API key).
const LAYERS: LayerDef[] = [
  // ---- Homes & living (what individuals compare: value, schools, walkability) ----
  { key: 'home-value', label: 'Median home value', desc: 'Single-family home values by area — live Census ACS choropleth', cat: 'living', kind: 'acs', url: '', acs: { service: 'ACS_Housing_Occupancy_and_Tenure_Unit_Value_Boundaries', field: 'B25077_001E', fmt: 'usd' }, opacity: 0.6, minZoom: 4, home: [33.45, -112.07, 10] },
  { key: 'owner-occupied', label: 'Owner-occupied homes', desc: 'Share of homes OWNED vs rented (Census ACS)', cat: 'living', kind: 'acs', url: '', acs: { service: 'ACS_Housing_Occupancy_and_Tenure_Unit_Value_Boundaries', field: 'B25003_calc_pctOwnE', fmt: 'pct' }, opacity: 0.6, minZoom: 4 },
  { key: 'income', label: 'Household income', desc: 'Median household income by area (Census ACS)', cat: 'living', kind: 'acs', url: '', acs: { service: 'ACS_Median_Household_Income_View_Boundaries', field: 'B19049_001E', fmt: 'usd' }, opacity: 0.6, minZoom: 4 },
  { key: 'pop-density', label: 'Population density', desc: 'Crowded vs quiet areas — people per square mile (ACS)', cat: 'living', kind: 'acs', url: '', acs: { service: 'ACS_Total_Population_Boundaries', field: 'B01001_001E', fmt: 'density' }, opacity: 0.55, minZoom: 4 },
  { key: 'median-age', label: 'Median age', desc: 'Young vs established neighborhoods (Census ACS)', cat: 'living', kind: 'acs', url: '', acs: { service: 'ACS_Median_Age_Boundaries', field: 'B01002_001E', fmt: 'num' }, opacity: 0.6, minZoom: 4 },
  { key: 'household-size', label: 'Family size', desc: 'Average household size — family neighborhoods (ACS)', cat: 'living', kind: 'acs', url: '', acs: { service: 'ACS_Household_Size_Boundaries', field: 'B25010_001E', fmt: 'num' }, opacity: 0.6, minZoom: 4 },
  { key: 'schools', label: 'Schools (K-12)', desc: 'School locations across the US (USGS structures)', cat: 'living', kind: 'export', url: 'https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer', layers: '23,22', opacity: 0.95, minZoom: 12, home: [30.27, -97.74, 13] },
  { key: 'school-districts', label: 'School districts', desc: 'District boundaries (Census TIGERweb)', cat: 'living', kind: 'export', url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/Census2020/School/MapServer', opacity: 0.7, minZoom: 8 },
  { key: 'walkability', label: 'Walkability index', desc: 'How walkable every block is (EPA)', cat: 'living', kind: 'export', url: 'https://geodata.epa.gov/arcgis/rest/services/OA/WalkabilityIndex/MapServer', opacity: 0.5, minZoom: 10, home: [40.73, -73.99, 12] },
  // ---- Real estate & land ----
  { key: 'parcels', label: 'Property parcels', desc: 'Boundaries + owner / assessment (public records, where the state publishes)', cat: 'realestate', kind: 'feature', url: '', opacity: 1, minZoom: 15 },
  { key: 'permits', label: 'Building permits', desc: 'Construction filings — pre-design, design & issued (free city open data)', cat: 'realestate', kind: 'feature', url: '', opacity: 1, minZoom: 13 },
  { key: 'flood', label: 'FEMA flood zones', desc: 'National Flood Hazard Layer', cat: 'realestate', kind: 'export', url: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer', layers: '28', opacity: 0.6, minZoom: 14, home: [28.05, -82.46, 14] },
  { key: 'flood-bfe', label: 'Base flood elevations', desc: 'FEMA BFE lines, cross-sections & water lines (NFHL)', cat: 'realestate', kind: 'export', url: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer', layers: '16,14,20', opacity: 0.7, minZoom: 15, home: [27.96, -82.8, 15] },
  { key: 'wetlands', label: 'Wetlands', desc: 'USFWS National Wetlands Inventory', cat: 'realestate', kind: 'export', url: 'https://fwsprimary.wim.usgs.gov/server/rest/services/Wetlands_Raster/ImageServer', opacity: 0.6, minZoom: 12, home: [29.5, -90.4, 12] },
  { key: 'plss', label: 'Public Land Survey (PLSS)', desc: 'BLM township / range / section grid', cat: 'realestate', kind: 'export', url: 'https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer', opacity: 0.7, minZoom: 11 },
  // ---- Boundaries & census ----
  { key: 'counties', label: 'County / state lines', desc: 'US Census TIGERweb', cat: 'boundaries', kind: 'export', url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer', opacity: 0.85, minZoom: 4 },
  { key: 'tracts', label: 'Census tracts & blocks', desc: 'US Census TIGERweb', cat: 'boundaries', kind: 'export', url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer', opacity: 0.75, minZoom: 9 },
  { key: 'places', label: 'Cities & places', desc: 'Incorporated places (Census)', cat: 'boundaries', kind: 'export', url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer', opacity: 0.8, minZoom: 9 },
  { key: 'zcta', label: 'ZIP codes & PUMAs', desc: 'ZCTA / PUMA / TAZ (Census)', cat: 'boundaries', kind: 'export', url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer', opacity: 0.75, minZoom: 7 },
  { key: 'legislative', label: 'Legislative districts', desc: 'Congressional & state (Census)', cat: 'boundaries', kind: 'export', url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer', opacity: 0.75, minZoom: 5 },
  { key: 'geonames', label: 'Place names', desc: 'USGS GNIS named features', cat: 'boundaries', kind: 'export', url: 'https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer', opacity: 0.85, minZoom: 10 },
  // ---- Hazards & risk ----
  { key: 'epa-frs', label: 'EPA regulated sites', desc: 'Superfund, brownfields & facilities', cat: 'hazard', kind: 'export', url: 'https://geodata.epa.gov/arcgis/rest/services/OEI/FRS_INTERESTS/MapServer', opacity: 0.85, minZoom: 11, home: [41.88, -87.63, 11] },
  { key: 'warnings', label: 'Active NWS alerts', desc: 'Watches / warnings / advisories', cat: 'hazard', kind: 'export', url: 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer', opacity: 0.5, minZoom: 3 },
  // ---- Weather & climate ----
  { key: 'radar', label: 'Live weather radar', desc: 'NOAA base reflectivity', cat: 'weather', kind: 'export', url: 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity/MapServer', opacity: 0.6, minZoom: 3 },
  { key: 'precip', label: 'Precipitation estimate', desc: 'NOAA RFC quantitative precip', cat: 'weather', kind: 'export', url: 'https://mapservices.weather.noaa.gov/raster/rest/services/obs/rfc_qpe/MapServer', opacity: 0.6, minZoom: 3 },
  { key: 'slr', label: 'Sea level rise (3 ft)', desc: 'NOAA Digital Coast', cat: 'weather', kind: 'export', url: 'https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_3ft/MapServer', opacity: 0.6, minZoom: 8, home: [25.79, -80.13, 11] },
  // ---- Nature & environment ----
  { key: 'water', label: 'Water & hydrology', desc: 'USGS National Hydrography', cat: 'nature', kind: 'export', url: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer', opacity: 0.7, minZoom: 10 },
  { key: 'watersheds', label: 'Watersheds', desc: 'USGS Watershed Boundary Dataset', cat: 'nature', kind: 'export', url: 'https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer', opacity: 0.55, minZoom: 6 },
  { key: 'forests', label: 'National forests', desc: 'USDA Forest Service boundaries', cat: 'nature', kind: 'export', url: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer', opacity: 0.55, minZoom: 5 },
  { key: 'wilderness', label: 'Wilderness areas', desc: 'USFS designated wilderness', cat: 'nature', kind: 'export', url: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_Wilderness_01/MapServer', opacity: 0.55, minZoom: 6 },
  { key: 'trails', label: 'Forest trails', desc: 'USFS national trail system', cat: 'nature', kind: 'export', url: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer', opacity: 0.8, minZoom: 11 },
  // ---- Infrastructure ----
  { key: 'roads-rail', label: 'Roads & railroads', desc: 'US Census transportation', cat: 'infra', kind: 'export', url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer', opacity: 0.85, minZoom: 9 },
  { key: 'structures', label: 'Public structures', desc: 'USGS schools, hospitals, fire, gov', cat: 'infra', kind: 'export', url: 'https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer', opacity: 0.9, minZoom: 13 },
  { key: 'usgs-transport', label: 'USGS transportation', desc: 'Roads, rail, airports, trails', cat: 'infra', kind: 'export', url: 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer', opacity: 0.85, minZoom: 11 },
  { key: 'forest-roads', label: 'Forest roads', desc: 'USFS road system', cat: 'infra', kind: 'export', url: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RoadBasic_01/MapServer', opacity: 0.8, minZoom: 11 },
  { key: 'charts', label: 'Nautical charts', desc: 'NOAA coastal & marine (ENC)', cat: 'infra', kind: 'export', url: 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/MapServer', opacity: 0.9, minZoom: 10, home: [27.7, -82.55, 11] },
  // ---- Imagery & terrain ----
  { key: 'imagery', label: 'Aerial imagery (USGS)', desc: 'USGS high-res orthoimagery', cat: 'imagery', kind: 'xyz', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile', opacity: 1, minZoom: 3 },
  { key: 'imagery-topo', label: 'Imagery + labels', desc: 'USGS imagery with place labels', cat: 'imagery', kind: 'xyz', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile', opacity: 1, minZoom: 3 },
  { key: 'esri-imagery', label: 'World imagery (Esri)', desc: 'Global high-res satellite', cat: 'imagery', kind: 'xyz', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile', opacity: 1, minZoom: 3 },
  { key: 'topo', label: 'USGS topographic', desc: 'Contours & topo basemap', cat: 'imagery', kind: 'xyz', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile', opacity: 1, minZoom: 3 },
  { key: 'opentopo', label: 'OpenTopoMap', desc: 'Open terrain & contours', cat: 'imagery', kind: 'xyz', url: 'https://a.tile.opentopomap.org', opacity: 1, minZoom: 3 },
  { key: 'contours', label: 'Elevation contours', desc: 'USGS contour lines', cat: 'imagery', kind: 'export', url: 'https://carto.nationalmap.gov/arcgis/rest/services/contours/MapServer', opacity: 0.7, minZoom: 11 },
  { key: 'hillshade', label: 'Hillshade', desc: 'Esri terrain relief', cat: 'imagery', kind: 'xyz', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile', opacity: 0.5, minZoom: 3 },
  { key: 'relief', label: 'Shaded relief', desc: 'USGS shaded relief', cat: 'imagery', kind: 'xyz', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile', opacity: 0.5, minZoom: 3 },
  { key: 'natgeo', label: 'National Geographic', desc: 'Esri NatGeo basemap', cat: 'imagery', kind: 'xyz', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile', opacity: 1, minZoom: 3 },
  { key: 'ocean', label: 'Ocean basemap', desc: 'Esri ocean & bathymetry', cat: 'imagery', kind: 'xyz', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile', opacity: 1, minZoom: 3 },
  { key: 'carto-dark', label: 'Carto dark', desc: 'Minimal dark basemap', cat: 'imagery', kind: 'xyz', url: 'https://a.basemaps.cartocdn.com/dark_all', opacity: 1, minZoom: 3 },
  { key: 'carto-light', label: 'Carto light', desc: 'Minimal light basemap', cat: 'imagery', kind: 'xyz', url: 'https://a.basemaps.cartocdn.com/light_all', opacity: 1, minZoom: 3 },
  { key: 'osm', label: 'OpenStreetMap', desc: 'Detailed streets & places', cat: 'imagery', kind: 'xyz', url: 'https://tile.openstreetmap.org', opacity: 1, minZoom: 3 },
  { key: 'osm-hot', label: 'OSM Humanitarian', desc: 'High-detail OSM style', cat: 'imagery', kind: 'xyz', url: 'https://a.tile.openstreetmap.fr/hot', opacity: 1, minZoom: 3 },
  // ---- Real estate & land (verified live 2026) ----
  { key: "fema-nfhl-flood-zones", label: "FEMA Flood Zones (SFHA)", desc: "FEMA National Flood Hazard Layer - Flood Hazard Zones (SFHA: AE/A/VE/X) from FEMA Mapping Information Platform", cat: "realestate", kind: "export", url: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer", layers: "28,27", opacity: 0.6, minZoom: 14, home: [28.05, -82.46, 14] },
  { key: "fema-nfhl-firm-panels", label: "FEMA FIRM Panels", desc: "FEMA NFHL FIRM Panel index + Base Index grid (effective Flood Insurance Rate Map panels), FEMA Mapping Information Platform", cat: "realestate", kind: "export", url: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer", layers: "3,4", opacity: 0.55, minZoom: 14, home: [28.05, -82.46, 14] },
  { key: "nlcd-impervious-2021", label: "NLCD Impervious 2021", desc: "USGS/MRLC National Land Cover Database 2021 percent developed impervious surface (WMS, EPSG:3857)", cat: "realestate", kind: "wms", url: "https://www.mrlc.gov/geoserver/mrlc_display/wms", layers: "NLCD_2021_Impervious_L48", opacity: 0.85, minZoom: 4 },
  { key: "blm-surface-mgmt-agency-150", label: "BLM Surface Mgmt Agency", desc: "BLM National Surface Management Agency - federal land ownership/jurisdiction by managing agency (ArcGIS MapServer export)", cat: "realestate", kind: "export", url: "https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_LimitedScale/MapServer", opacity: 0.6, minZoom: 14, home: [39.5, -117.0, 14] },
  { key: "noaa-ccap-landcover-2021", label: "NOAA C-CAP Land Cover", desc: "NOAA C-CAP regional moderate-resolution coastal land cover 2021 (ArcGIS MapServer export)", cat: "realestate", kind: "export", url: "https://imagery.coast.noaa.gov/arcgis/rest/services/LandCoverAtlas/LandCover_ModRes_2021/MapServer", opacity: 0.85, minZoom: 5, home: [27.9, -82.5, 9] },
  // ---- Boundaries & census (verified live 2026) ----
  { key: "tiger-congressional", label: "Congressional Districts", desc: "119th Congressional Districts (US Census Bureau TIGERweb)", cat: "boundaries", kind: "export", url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer", layers: "4", opacity: 0.6, minZoom: 6 },
  { key: "tiger-state-leg", label: "State Legislative Dist.", desc: "2024 State Legislative Districts upper + lower chambers (US Census Bureau TIGERweb)", cat: "boundaries", kind: "export", url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer", layers: "5,6", opacity: 0.55, minZoom: 8 },
  { key: "tiger-school-districts", label: "School Districts", desc: "Unified, secondary & elementary school districts (US Census Bureau TIGERweb)", cat: "boundaries", kind: "export", url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/School/MapServer", layers: "0,1,2", opacity: 0.55, minZoom: 6 },
  { key: "tiger-urban-areas", label: "Urban Areas", desc: "2020 Census Urbanized Areas & Urban Clusters (US Census Bureau TIGERweb)", cat: "boundaries", kind: "export", url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Urban/MapServer", layers: "0", opacity: 0.5, minZoom: 7 },
  { key: "tiger-tribal-reservations", label: "Tribal Reservations", desc: "Federal American Indian Reservations & off-reservation trust lands (US Census Bureau TIGERweb AIANNHA)", cat: "boundaries", kind: "export", url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/AIANNHA/MapServer", layers: "2,3", opacity: 0.6, minZoom: 4 },
  { key: "bia-aian-lar", label: "BIA Tribal Trust Lands", desc: "American Indian/Alaska Native Land Area Representation, trust & restricted-fee lands (Bureau of Indian Affairs)", cat: "boundaries", kind: "export", url: "https://biamaps.geoplatform.gov/server/rest/services/DivLTR/BIA_AIAN_National_LAR/MapServer", opacity: 0.6, minZoom: 4 },
  { key: "blm-surface-mgmt-agency", label: "Federal Lands (BLM SMA)", desc: "Surface Management Agency: federal lands classified by managing agency (Bureau of Land Management)", cat: "boundaries", kind: "export", url: "https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer", opacity: 0.6, minZoom: 4 },
  { key: "tiger-county-subdivisions", label: "County Subdivisions", desc: "County subdivisions / minor civil divisions (US Census Bureau TIGERweb)", cat: "boundaries", kind: "export", url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer", layers: "1", opacity: 0.5, minZoom: 9 },
  { key: "usgs-govunits", label: "Gov Unit Boundaries", desc: "Governmental unit boundaries: federal, tribal, congressional & civil areas (USGS The National Map)", cat: "boundaries", kind: "export", url: "https://carto.nationalmap.gov/arcgis/rest/services/govunits/MapServer", opacity: 0.55, minZoom: 4 },
  // ---- Hazards & risk (verified live 2026) ----
  { key: "fema-nfhl-lomr-loma", label: "FEMA LOMR & LOMA", desc: "FEMA NFHL Letters of Map Revision (LOMR) and Letters of Map Amendment (LOMA) - official flood map changes, FEMA", cat: "hazard", kind: "export", url: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer", layers: "1,34", opacity: 0.7, minZoom: 14, home: [30.61, -87.76, 14] },
  { key: "fema-nfhl-bfe", label: "Base Flood Elevations", desc: "FEMA NFHL Base Flood Elevations, Cross-Sections and Water Lines (1% annual chance flood depths), FEMA", cat: "hazard", kind: "export", url: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer", layers: "16,14,20", opacity: 0.8, minZoom: 15, home: [27.96, -82.8, 15] },
  { key: "fema-nfhl-levees", label: "FEMA Levees", desc: "FEMA NFHL Levees and General Structures (levee-protected areas / flood control structures), FEMA", cat: "hazard", kind: "export", url: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer", layers: "23,24", opacity: 0.75, minZoom: 15, home: [38.6, -121.55, 15] },
  { key: "fema-nfhl-full", label: "FEMA NFHL (full)", desc: "FEMA National Flood Hazard Layer - complete effective flood map (all sublayers), FEMA Mapping Information Platform", cat: "hazard", kind: "export", url: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer", opacity: 0.65, minZoom: 14, home: [28.05, -82.46, 14] },
  { key: "fema-prelim-nfhl", label: "Preliminary NFHL", desc: "FEMA Preliminary National Flood Hazard Layer - upcoming/preliminary flood map data not yet effective, FEMA", cat: "hazard", kind: "export", url: "https://hazards.fema.gov/arcgis/rest/services/PrelimPending/Prelim_NFHL/MapServer", opacity: 0.6, minZoom: 14, home: [37.69, -113.07, 14] },
  { key: "noaa-storm-surge-risk", label: "Storm Surge Risk (SLOSH)", desc: "NOAA/NWS National Hurricane Center storm surge inundation risk (SLOSH MOM) by hurricane category, Cat 1-5, NOAA", cat: "hazard", kind: "export", url: "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/StormSurgeRisk/MapServer", opacity: 0.65, minZoom: 5, home: [29.5, -90.4, 9] },
  { key: "usace-nid-dams", label: "Dams (NID)", desc: "US Army Corps of Engineers National Inventory of Dams - 91,000+ dams incl hazard potential classification, USACE", cat: "hazard", kind: "export", url: "https://geospatial.sec.usace.army.mil/dls/rest/services/NID/National_Inventory_of_Dams_Public_Service/MapServer", opacity: 0.85, minZoom: 6 },
  { key: "usgs-recent-earthquakes", label: "Recent Quakes (M2.5+)", desc: "USGS live recent earthquakes, magnitude 2.5+ over the last 30 days, including significant events (US Geological Survey)", cat: "hazard", kind: "export", url: "https://earthquake.usgs.gov/arcgis/rest/services/eq/Recent_Earthquakes/MapServer", opacity: 0.9, minZoom: 3, home: [37, -120, 5] },
  { key: "usgs-eq-catalog", label: "Global Quakes M5.5+", desc: "USGS Earthquake Catalog: global seismic events greater than magnitude 5.5, harvested from the ComCat catalog (US Geological Survey)", cat: "hazard", kind: "export", url: "https://earthquake.usgs.gov/arcgis/rest/services/eq/EQ_Catalog/MapServer", opacity: 0.9, minZoom: 3 },
  { key: "usgs-shakemap-30day", label: "ShakeMaps (30 day)", desc: "USGS ShakeMap products (ground-shaking intensity) from significant earthquakes in the last 30 days (US Geological Survey)", cat: "hazard", kind: "export", url: "https://earthquake.usgs.gov/arcgis/rest/services/eq/sm_ShakeMap30DaySignificant/MapServer", opacity: 0.65, minZoom: 3, home: [37, -120, 5] },
  { key: "usgs-plate-boundaries", label: "Tectonic Plates", desc: "USGS tectonic plate boundaries and microplates that drive global seismic and volcanic activity (US Geological Survey)", cat: "hazard", kind: "export", url: "https://earthquake.usgs.gov/arcgis/rest/services/eq/map_plateboundaries/MapServer", opacity: 0.8, minZoom: 3, home: [37, -125, 5] },
  { key: "usgs-quaternary-faults", label: "Quaternary Faults", desc: "USGS Quaternary Faults and Folds national database (active faults from the last 1.6M years) (US Geological Survey)", cat: "hazard", kind: "export", url: "https://earthquake.usgs.gov/arcgis/rest/services/haz/Qfaults/MapServer", layers: "21", opacity: 0.85, minZoom: 5, home: [34.1, -117.5, 8] },
  { key: "usgs-seismic-hazard-pga", label: "Seismic Hazard (PGA)", desc: "USGS National Seismic Hazard Model: peak ground acceleration with 2% probability of exceedance in 50 years, 2014 (US Geological Survey)", cat: "hazard", kind: "export", url: "https://earthquake.usgs.gov/arcgis/rest/services/haz/USpga250_2014/MapServer", opacity: 0.55, minZoom: 3 },
  { key: "noaa-tsunami-energy", label: "Tsunami Wave Energy", desc: "NOAA NCEI modeled maximum tsunami wave energy for major historical source events (e.g. Cascadia 1700, Tohoku 2011) (NOAA NCEI)", cat: "hazard", kind: "export", url: "https://gis.ngdc.noaa.gov/arcgis/rest/services/tsunami_energy/MapServer", layers: "0", opacity: 0.7, minZoom: 3, home: [44, -130, 4] },
  { key: "dogami-tsunami-evac-or", label: "Tsunami Evac Zones (OR)", desc: "Oregon coast tsunami evacuation zones (local & distant scenarios), Oregon Tsunami Geologic compilation (Oregon DOGAMI)", cat: "hazard", kind: "export", url: "https://gis.dogami.oregon.gov/arcgis/rest/services/Public/OTGC1/MapServer", layers: "12", opacity: 0.6, minZoom: 7, home: [44.62, -124.05, 12] },
  { key: "wadnr-volcano-hazards", label: "Volcano Hazard Zones", desc: "Simplified volcano hazard zones (lahar, debris avalanche, lava, blast) for the major Cascade stratovolcanoes, compiled from USGS (Washington DNR)", cat: "hazard", kind: "export", url: "https://gis.dnr.wa.gov/site1/rest/services/Public_Geology/Volcanic_Hazards/MapServer", opacity: 0.55, minZoom: 6, home: [46.85, -121.75, 9] },
  { key: "dogami-slido-landslides", label: "Landslide Inventory (OR)", desc: "SLIDO statewide landslide inventory for Oregon: mapped historic landslide deposits, points and susceptibility (Oregon DOGAMI)", cat: "hazard", kind: "export", url: "https://gis.dogami.oregon.gov/arcgis/rest/services/Public/SLIDO42/MapServer", opacity: 0.7, minZoom: 7, home: [45.45, -122.6, 10] },
  { key: "epa-current-aqi-county", label: "Current AQI by County", desc: "Current Air Quality Index by county (US EPA MyEnvironment / AirNow feed).", cat: "hazard", kind: "export", url: "https://geopub.epa.gov/arcgis/rest/services/myenv/aqi/MapServer", opacity: 0.6, minZoom: 4 },
  { key: "epa-ozone-monitors", label: "Ozone Monitors (active)", desc: "Active ozone (O3) ambient air monitoring sites, US EPA OAQPS AQS network.", cat: "hazard", kind: "export", url: "https://gispub.epa.gov/arcgis/rest/services/OAR_OAQPS/AQSmonitor_sites/MapServer", layers: "10", opacity: 0.9, minZoom: 4 },
  { key: "epa-pm25-monitors", label: "PM2.5 Monitors (active)", desc: "Active fine particulate (PM2.5) NAAQS/AQI air monitoring sites, US EPA OAQPS AQS network.", cat: "hazard", kind: "export", url: "https://gispub.epa.gov/arcgis/rest/services/OAR_OAQPS/AQSmonitor_sites/MapServer", layers: "14,16", opacity: 0.9, minZoom: 4 },
  { key: "epa-fused-ozone-pm25", label: "Modeled Ozone & PM2.5", desc: "Bayesian space-time fused ozone (ppb) and PM2.5 (ug/m3) prediction surfaces, US EPA OAQPS.", cat: "hazard", kind: "export", url: "https://gispub.epa.gov/arcgis/rest/services/OAR_OAQPS/Fused_AQ_Predictions_Downscaling/MapServer", layers: "0,1", opacity: 0.7, minZoom: 4 },
  { key: "epa-nata-emissions", label: "Air Toxics Emitters", desc: "2014 National Emissions Inventory facility-level hazardous air pollutant emission sources, US EPA OAQPS.", cat: "hazard", kind: "export", url: "https://gispub.epa.gov/arcgis/rest/services/OAR_OAQPS/2014_NATA_Emissions/MapServer", layers: "1", opacity: 0.85, minZoom: 7 },
  { key: "epa-class1-areas", label: "Class 1 Clean-Air Areas", desc: "Mandatory Class 1 Federal Areas with special visibility/haze air-quality protection, US EPA OAQPS.", cat: "hazard", kind: "export", url: "https://gispub.epa.gov/arcgis/rest/services/OAR_OAQPS/Class1_Areas/MapServer", opacity: 0.6, minZoom: 4 },
  { key: "nasa-modis-aod", label: "Aerosol Optical Depth", desc: "MODIS combined value-added Aerosol Optical Depth (haze/particulate proxy), NASA GIBS/Worldview.", cat: "hazard", kind: "wms", url: "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi", layers: "MODIS_Combined_Value_Added_AOD", opacity: 0.75, minZoom: 2 },
  { key: "nasa-omi-no2", label: "Nitrogen Dioxide (NO2)", desc: "OMI tropospheric nitrogen dioxide column density, NASA GIBS/Worldview.", cat: "hazard", kind: "wms", url: "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi", layers: "OMI_Nitrogen_Dioxide_Tropo_Column", opacity: 0.75, minZoom: 2 },
  { key: "nasa-airs-co", label: "Carbon Monoxide (CO)", desc: "AIRS 500hPa carbon monoxide volume mixing ratio (daily, daytime), NASA GIBS/Worldview.", cat: "hazard", kind: "wms", url: "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi", layers: "AIRS_L3_Carbon_Monoxide_500hPa_Volume_Mixing_Ratio_Daily_Day", opacity: 0.75, minZoom: 2 },
  // ---- Wildfire & smoke (verified live 2026) ----
  { key: "viirs-noaa20-fires", label: "VIIRS NOAA-20 Fires", desc: "Active fire / thermal anomaly detections (375m) from VIIRS aboard NOAA-20, via NASA GIBS (LANCE/FIRMS). Near-real-time daily hotspots.", cat: "wildfire", kind: "wms", url: "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi", layers: "VIIRS_NOAA20_Thermal_Anomalies_375m_All", opacity: 0.9, minZoom: 3 },
  { key: "viirs-snpp-fires", label: "VIIRS SNPP Fires", desc: "Active fire / thermal anomaly detections (375m) from VIIRS aboard Suomi-NPP, via NASA GIBS (LANCE/FIRMS). Near-real-time daily hotspots.", cat: "wildfire", kind: "wms", url: "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi", layers: "VIIRS_SNPP_Thermal_Anomalies_375m_All", opacity: 0.9, minZoom: 3 },
  { key: "modis-thermal-fires", label: "MODIS Thermal Anomalies", desc: "Combined Aqua+Terra MODIS active fire / thermal anomaly detections (1km), via NASA GIBS (LANCE/FIRMS). Daily near-real-time.", cat: "wildfire", kind: "wms", url: "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi", layers: "MODIS_Combined_Thermal_Anomalies_All", opacity: 0.9, minZoom: 3 },
  { key: "goes-east-firetemp", label: "GOES-East Fire Temp", desc: "GOES-East ABI Fire Temperature RGB (geostationary, frequent refresh) highlighting active fire heat, via NASA GIBS / NOAA.", cat: "wildfire", kind: "wms", url: "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi", layers: "GOES-East_ABI_FireTemp", opacity: 0.85, minZoom: 3, home: [33, -85, 6] },
  { key: "goes-west-firetemp", label: "GOES-West Fire Temp", desc: "GOES-West ABI Fire Temperature RGB (geostationary) highlighting active fire heat over the western US/Pacific, via NASA GIBS / NOAA.", cat: "wildfire", kind: "wms", url: "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi", layers: "GOES-West_ABI_FireTemp", opacity: 0.85, minZoom: 3, home: [39.5, -110, 6] },
  { key: "mtbs-burn-severity", label: "MTBS Burn Severity", desc: "Monitoring Trends in Burn Severity: mapped burned-area boundaries & severity for large fires (1984-present), USFS/USGS EDW dynamic MapServer.", cat: "wildfire", kind: "export", url: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer", opacity: 0.8, minZoom: 4, home: [39.5, -121, 8] },
  { key: "usfs-fire-occurrence-perimeter", label: "Fire Occurrence & Perimeter", desc: "USFS Fire Occurrence point locations and historical fire perimeters, USDA Forest Service EDW dynamic MapServer.", cat: "wildfire", kind: "export", url: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_FireOccurrenceAndPerimeter_01/MapServer", opacity: 0.8, minZoom: 4, home: [39.5, -121, 8] },
  { key: "usfs-fireshed-registry", label: "Fireshed Registry", desc: "USFS Fireshed Registry: spatial fireshed/project areas characterizing wildfire transmission and exposure risk, Forest Service EDW MapServer.", cat: "wildfire", kind: "export", url: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_FireshedRegistry_01/MapServer", opacity: 0.7, minZoom: 4 },
  { key: "spc-fire-weather-outlook", label: "Critical Fire Weather", desc: "NOAA NWS Storm Prediction Center fire weather outlook (critical/extreme fire weather areas & dry-thunderstorm risk), mapservices.weather.noaa.gov.", cat: "wildfire", kind: "export", url: "https://mapservices.weather.noaa.gov/vector/rest/services/fire_weather/SPC_firewx/MapServer", opacity: 0.55, minZoom: 3 },
  // ---- Weather & radar (verified live 2026) ----
  { key: "goes-east-ir", label: "GOES infrared (clouds)", desc: "NOAA nowCOAST GOES East/West longwave IR cloud-top mosaic (24/7, near-real-time)", cat: "weather", kind: "wms", url: "https://nowcoast.noaa.gov/geoserver/satellite/wms", layers: "global_longwave_imagery_mosaic", opacity: 0.85, minZoom: 3 },
  { key: "goes-visible", label: "GOES visible satellite", desc: "NOAA nowCOAST GOES visible-band imagery mosaic (daytime, near-real-time)", cat: "weather", kind: "wms", url: "https://nowcoast.noaa.gov/geoserver/satellite/wms", layers: "global_visible_imagery_mosaic", opacity: 0.85, minZoom: 3 },
  { key: "goes-water-vapor", label: "GOES water vapor", desc: "NOAA nowCOAST GOES mid-level water-vapor imagery mosaic (near-real-time)", cat: "weather", kind: "wms", url: "https://nowcoast.noaa.gov/geoserver/satellite/wms", layers: "global_water_vapor_imagery_mosaic", opacity: 0.85, minZoom: 3 },
  { key: "radar-reflectivity-mosaic", label: "Radar reflectivity (CONUS)", desc: "NOAA nowCOAST MRMS base reflectivity radar mosaic, CONUS (live, ~2 min)", cat: "weather", kind: "wms", url: "https://nowcoast.noaa.gov/geoserver/observations/weather_radar/wms", layers: "conus_base_reflectivity_mosaic", opacity: 0.7, minZoom: 3 },
  { key: "modis-aod", label: "Aerosol / smoke (AOD)", desc: "NASA GIBS MODIS Combined Value-Added Aerosol Optical Depth (smoke/dust/haze), daily. WMTS REST: append /{z}/{y}/{x}.png (z/y/x order); swap date for current UTC day", cat: "weather", kind: "xyz", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_Value_Added_AOD/default/{date}/GoogleMapsCompatible_Level6", opacity: 0.7, minZoom: 3 },
  { key: "modis-lst-day", label: "Land surface temp (day)", desc: "NASA GIBS MODIS Terra Land Surface Temperature, daytime, daily global. WMTS REST: append /{z}/{y}/{x}.png (z/y/x order); swap date for current UTC day", cat: "weather", kind: "xyz", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_Land_Surface_Temp_Day/default/{date}/GoogleMapsCompatible_Level7", opacity: 0.7, minZoom: 3 },
  { key: "imerg-precip-rate", label: "Precipitation rate (IMERG)", desc: "NASA GIBS GPM IMERG global precipitation rate, near-real-time. WMTS REST: append /{z}/{y}/{x}.png (z/y/x order); swap date for current UTC day", cat: "weather", kind: "xyz", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate/default/{date}/GoogleMapsCompatible_Level6", opacity: 0.7, minZoom: 3 },
  { key: "nws-watch-warn", label: "NWS watches & warnings", desc: "NOAA NWS active watches/warnings/advisories, event-driven live feed (ArcGIS export)", cat: "weather", kind: "export", url: "https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer", opacity: 0.55, minZoom: 3 },
  // ---- Climate & drought (verified live 2026) ----
  { key: "us-drought-monitor", label: "US Drought Monitor", desc: "Current weekly U.S. Drought Monitor severity (D0-D4), National Drought Mitigation Center (NDMC/UNL, NOAA, USDA). ArcGIS tile cache, order /{z}/{y}/{x}.", cat: "climate", kind: "xyz", url: "https://services5.arcgis.com/0OTVzJS4K09zlixn/arcgis/rest/services/US_Drought_Monitor/MapServer/tile", opacity: 0.7, minZoom: 3 },
  { key: "cpc-drought-outlook", label: "Drought Outlook", desc: "NOAA/NWS Climate Prediction Center Monthly & Seasonal Drought Outlook (persist/develop/improve/remove).", cat: "climate", kind: "export", url: "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_drought_outlk/MapServer", opacity: 0.7, minZoom: 3 },
  { key: "nohrsc-snow-analysis", label: "Snow Depth & SWE", desc: "NOAA/NWS NOHRSC National Snow Analysis: snow depth and snow water equivalent raster (seasonal — fullest in winter).", cat: "climate", kind: "export", url: "https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer", opacity: 0.85, minZoom: 3, home: [46.85, -121.75, 9] },
  { key: "noaa-climate-normals", label: "Climate Normals", desc: "NOAA NCEI 1981-2010 Climate Normals stations (hourly/daily/monthly/annual temp & precip).", cat: "climate", kind: "export", url: "https://gis.ncdc.noaa.gov/arcgis/rest/services/cdo/normals/MapServer", opacity: 0.85, minZoom: 4 },
  { key: "cpc-temp-outlook", label: "Temperature Outlook", desc: "NOAA/NWS Climate Prediction Center Monthly Temperature Outlook (above/below normal probability).", cat: "climate", kind: "export", url: "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_mthly_temp_outlk/MapServer", opacity: 0.65, minZoom: 3 },
  { key: "cpc-precip-outlook", label: "Precipitation Outlook", desc: "NOAA/NWS Climate Prediction Center Monthly Precipitation Outlook (above/below normal probability).", cat: "climate", kind: "export", url: "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_mthly_precip_outlk/MapServer", opacity: 0.65, minZoom: 3 },
  { key: "cpc-precip-anomaly", label: "Precip Anomaly (GFS)", desc: "NOAA/NWS Climate Prediction Center GFS week-1/week-2 precipitation anomaly raster.", cat: "climate", kind: "export", url: "https://mapservices.weather.noaa.gov/raster/rest/services/climate/cpc_gfs_precip_anom/MapServer", opacity: 0.8, minZoom: 3 },
  { key: "rfc-qpe-precip", label: "Observed Precip (QPE)", desc: "NOAA/NWS River Forecast Centers Quantitative Precipitation Estimate (multi-sensor observed precip).", cat: "climate", kind: "export", url: "https://mapservices.weather.noaa.gov/raster/rest/services/obs/rfc_qpe/MapServer", opacity: 0.8, minZoom: 3 },
  { key: "noaa-slr-1ft", label: "Sea Level Rise 1 ft", desc: "NOAA Office for Coastal Management Digital Coast: 1 ft sea level rise low-lying areas & depth.", cat: "climate", kind: "export", url: "https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_1ft/MapServer", opacity: 0.7, minZoom: 6, home: [25.79, -80.13, 11] },
  { key: "noaa-slr-3ft", label: "Sea Level Rise 3 ft", desc: "NOAA Office for Coastal Management Digital Coast: 3 ft sea level rise low-lying areas & depth.", cat: "climate", kind: "export", url: "https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_3ft/MapServer", opacity: 0.7, minZoom: 6, home: [25.79, -80.13, 11] },
  { key: "noaa-slr-6ft", label: "Sea Level Rise 6 ft", desc: "NOAA Office for Coastal Management Digital Coast: 6 ft sea level rise low-lying areas & depth.", cat: "climate", kind: "export", url: "https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_6ft/MapServer", opacity: 0.7, minZoom: 6, home: [25.79, -80.13, 11] },
  // ---- Water & hydrology (verified live 2026) ----
  { key: "usgs-nhd", label: "NHD Streams & Waterbodies", desc: "USGS National Hydrography Dataset — flowlines, waterbodies & areas (small + large scale). Source: USGS The National Map.", cat: "water", kind: "export", url: "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer", layers: "4,6,9,10,12", opacity: 0.8, minZoom: 5 },
  { key: "usgs-nhdplus-hr", label: "NHDPlus HR", desc: "USGS NHDPlus High Resolution — stream network, catchments & value-added hydrography. Source: USGS The National Map.", cat: "water", kind: "export", url: "https://hydro.nationalmap.gov/arcgis/rest/services/NHDPlus_HR/MapServer", opacity: 0.8, minZoom: 6 },
  { key: "usgs-hydro-cached", label: "USGS Hydro (tiles)", desc: "USGS cached cartographic NHD overlay, fast national tiles. Source: USGS The National Map (basemap). App appends /{z}/{y}/{x}.", cat: "water", kind: "xyz", url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile", opacity: 0.85, minZoom: 4 },
  { key: "usgs-wbd-watersheds", label: "Watersheds (HUC)", desc: "USGS Watershed Boundary Dataset — hydrologic unit (HUC 2–16) boundaries. Source: USGS The National Map.", cat: "water", kind: "export", url: "https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer", opacity: 0.6, minZoom: 4 },
  { key: "usgs-stream-gauges", label: "USGS Stream Gauges", desc: "USGS streamgage locations (NWIS network) used by the National Water Model. Source: USGS via NOAA/NWS.", cat: "water", kind: "export", url: "https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/USGS_Stream_Gauges/MapServer", opacity: 0.9, minZoom: 6 },
  { key: "nwps-river-gauges", label: "River Gauge Stages", desc: "NWPS river gauges — observed river stages (flood status). Source: NOAA National Water Prediction Service.", cat: "water", kind: "export", url: "https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer", layers: "0", opacity: 0.9, minZoom: 5 },
  { key: "nwm-flood-inundation", label: "NWM Flood Inundation 5d", desc: "National Water Model 5-day max flood inundation extent (experimental). Source: NOAA Office of Water Prediction.", cat: "water", kind: "export", url: "https://maps.water.noaa.gov/server/rest/services/nwm/mrf_nbm_5day_max_inundation_extent/MapServer", opacity: 0.7, minZoom: 11, home: [35.15, -90.07, 11] },
  { key: "epa-attains-assessment", label: "Water Quality (ATTAINS)", desc: "EPA ATTAINS — Clean Water Act 303(d)/305(b) assessed & impaired water assessment units. Source: US EPA Office of Water.", cat: "water", kind: "export", url: "https://gispub.epa.gov/arcgis/rest/services/OW/ATTAINS_Assessment/MapServer", opacity: 0.7, minZoom: 5 },
  { key: "epa-nhdplus-snapshot", label: "EPA NHDPlus v2.1", desc: "EPA Office of Water NHDPlus v2.1 stream snapshot. Source: US EPA WATERS.", cat: "water", kind: "export", url: "https://watersgeo.epa.gov/arcgis/rest/services/NHDPlus_NP21/NHDSnapshot_NP21/MapServer", opacity: 0.8, minZoom: 12 },
  { key: "noaa-enc-nautical-charts", label: "NOAA ENC Nautical Charts", desc: "NOAA Electronic Navigational Charts (S-57) full vector chart display via the Maritime Chart Service (NOAA Office of Coast Survey).", cat: "water", kind: "export", url: "https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/MapServer", opacity: 1, minZoom: 6 },
  { key: "gebco-global-bathymetry", label: "GEBCO Bathymetry", desc: "GEBCO global seafloor bathymetry / ocean depth grid (General Bathymetric Chart of the Oceans, hosted by BODC/NOC).", cat: "water", kind: "wms", url: "https://wms.gebco.net/mapserv", layers: "GEBCO_LATEST", opacity: 0.85, minZoom: 2 },
  { key: "emodnet-bathymetry", label: "EMODnet Bathymetry", desc: "EMODnet high-resolution mean depth bathymetry for European seas (EMODnet Bathymetry / EU).", cat: "water", kind: "wms", url: "https://ows.emodnet-bathymetry.eu/wms", layers: "emodnet:mean_atlas_land", opacity: 0.85, minZoom: 4, home: [54, 3, 6] },
  { key: "noaa-us-maritime-limits-eez", label: "US Maritime Limits / EEZ", desc: "NOAA US Maritime Limits & Boundaries - 12NM Territorial Sea, 24NM Contiguous Zone, 200NM EEZ (NOAA Office of Coast Survey).", cat: "water", kind: "export", url: "https://gis.charttools.noaa.gov/arcgis/rest/services/MaritimeBoundaries/US_Maritime_Limits_Boundaries/MapServer", opacity: 0.8, minZoom: 3 },
  { key: "marineregions-eez-boundaries", label: "World EEZ Boundaries", desc: "Global Exclusive Economic Zone (EEZ) maritime boundaries (Flanders Marine Institute / MarineRegions.org).", cat: "water", kind: "wms", url: "https://geo.vliz.be/geoserver/MarineRegions/wms", layers: "eez_boundaries", opacity: 0.7, minZoom: 3 },
  // ---- Nature & conservation (verified live 2026) ----
  { key: "usfs-padus-protected", label: "PAD-US Protected Areas", desc: "USGS/USDA Forest Service Protected Areas Database of the US (PAD-US) — all fee/easement protected lands nationwide (EDW_PADUS_01)", cat: "nature", kind: "export", url: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_PADUS_01/MapServer", opacity: 0.55, minZoom: 4 },
  { key: "nps-national-parks", label: "National Parks (NPS)", desc: "National Park System boundaries from USGS The National Map Governmental Unit Boundaries (govunits sublayer 29)", cat: "nature", kind: "export", url: "https://carto.nationalmap.gov/arcgis/rest/services/govunits/MapServer", layers: "29", opacity: 0.6, minZoom: 4 },
  { key: "national-monuments", label: "National Monuments", desc: "National Monument boundaries from USGS The National Map Governmental Unit Boundaries (govunits sublayer 30)", cat: "nature", kind: "export", url: "https://carto.nationalmap.gov/arcgis/rest/services/govunits/MapServer", layers: "30", opacity: 0.6, minZoom: 4 },
  { key: "fws-service-lands", label: "USFWS Lands & Refuges", desc: "US Fish & Wildlife Service lands (national wildlife refuges) from USGS The National Map Governmental Unit Boundaries (govunits sublayer 35)", cat: "nature", kind: "export", url: "https://carto.nationalmap.gov/arcgis/rest/services/govunits/MapServer", layers: "35", opacity: 0.6, minZoom: 4 },
  { key: "blm-public-lands", label: "BLM Public Lands", desc: "Bureau of Land Management administered lands from USGS The National Map Governmental Unit Boundaries (govunits sublayer 36)", cat: "nature", kind: "export", url: "https://carto.nationalmap.gov/arcgis/rest/services/govunits/MapServer", layers: "36", opacity: 0.55, minZoom: 4 },
  { key: "usfs-national-forests", label: "National Forests (USFS)", desc: "USDA Forest Service National Forest System administrative boundaries (EDW_ForestSystemBoundaries_01)", cat: "nature", kind: "export", url: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer", opacity: 0.55, minZoom: 4 },
  { key: "usfs-wilderness", label: "Wilderness Areas (USFS)", desc: "Congressionally designated National Wilderness Areas on USDA Forest Service land (EDW_Wilderness_01)", cat: "nature", kind: "export", url: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_Wilderness_01/MapServer", opacity: 0.6, minZoom: 4 },
  { key: "blm-nlcs-monuments-ncas", label: "BLM Monuments & NCAs", desc: "BLM National Landscape Conservation System National Monuments & National Conservation Areas (BLM_Natl_NLCS_NM_NCA_poly)", cat: "nature", kind: "export", url: "https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_NLCS_NM_NCA_poly/MapServer", opacity: 0.6, minZoom: 4 },
  { key: "fws-critical-habitat", label: "Critical Habitat (USFWS)", desc: "USFWS final designated Critical Habitat for threatened & endangered species — ArcGIS tile cache (app appends /{z}/{y}/{x})", cat: "nature", kind: "xyz", url: "https://tiles.arcgis.com/tiles/QVENGdaPbd4LUkLV/arcgis/rest/services/usfws_critical_habitat_final/MapServer/tile", opacity: 0.65, minZoom: 4, home: [34.4, -119.7, 8] },
  { key: "noaa-mpa-inventory", label: "Marine Protected Areas", desc: "NOAA Marine Protected Areas Inventory - all MPA types (State, NERRS, BOEM, Marine National Monuments, NMS, NPS, NWRS, NFS) (NOAA MPA Center).", cat: "nature", kind: "export", url: "https://gis.charttools.noaa.gov/arcgis/rest/services/survey_priorities2_national/MPA_Inventory_Separates/MapServer", opacity: 0.6, minZoom: 4, home: [24.65, -81.3, 7] },
  { key: "noaa-national-marine-sanctuaries", label: "Marine Sanctuaries", desc: "NOAA National Marine Sanctuary boundaries (MPA Inventory NMS sublayer) (NOAA Office of National Marine Sanctuaries).", cat: "nature", kind: "export", url: "https://gis.charttools.noaa.gov/arcgis/rest/services/survey_priorities2_national/MPA_Inventory_Separates/MapServer", layers: "4", opacity: 0.65, minZoom: 4, home: [36.6, -122, 7] },
  { key: "noaa-benthic-coral-habitats", label: "Benthic & Coral Habitats", desc: "NOAA NCCOS shallow-water benthic habitat / coral reef maps (Florida Keys, US Virgin Islands, Puerto Rico) (NOAA National Centers for Coastal Ocean Science).", cat: "nature", kind: "export", url: "https://gis.ngdc.noaa.gov/arcgis/rest/services/nccos/BenthicMapping_BenthicHabitats/MapServer", opacity: 0.7, minZoom: 7, home: [24.65, -81.3, 11] },
  // ---- Agriculture & soils (verified live 2026) ----
  { key: "usa-soil-order", label: "USA Soil Order (SSURGO)", desc: "Soil order derived from USDA NRCS SSURGO (Esri Living Atlas tile cache); ArcGIS tiles, app appends /{z}/{y}/{x}.", cat: "agriculture", kind: "xyz", url: "https://tiles.arcgis.com/tiles/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Soils_Map_Units_Tiles_v6/MapServer/tile", opacity: 0.75, minZoom: 3 },
  { key: "nlcd-land-cover-2021", label: "NLCD Land Cover 2021", desc: "USGS/MRLC National Land Cover Database 2021 — includes cultivated crops & pasture/hay classes (MRLC GeoServer WMS).", cat: "agriculture", kind: "wms", url: "https://www.mrlc.gov/geoserver/mrlc_display/wms", layers: "NLCD_2021_Land_Cover_L48", opacity: 0.75, minZoom: 4 },
  // ---- Geology & energy (verified live 2026) ----
  { key: "sgmc-geology-units", label: "US Geologic Map (SGMC)", desc: "USGS State Geologic Map Compilation (SGMC) — bedrock geologic units/lithology, national. Source: USGS mrdata.", cat: "geology", kind: "wms", url: "https://mrdata.usgs.gov/services/sgmc", layers: "sgmc2", opacity: 0.7, minZoom: 4 },
  { key: "sgmc-contacts", label: "Geologic Contacts", desc: "USGS SGMC geologic contact lines (boundaries between units). Source: USGS mrdata.", cat: "geology", kind: "wms", url: "https://mrdata.usgs.gov/services/sgmc", layers: "sgmc2contact", opacity: 0.8, minZoom: 5 },
  { key: "sgmc-faults-structure", label: "Faults & Structure (SGMC)", desc: "USGS SGMC structural features — fault lines, folds and other geologic structure. Source: USGS mrdata.", cat: "geology", kind: "wms", url: "https://mrdata.usgs.gov/services/sgmc", layers: "sgmc2structure", opacity: 0.85, minZoom: 10, home: [40.5, -111.9, 10] },
  { key: "usgs-quaternary-faults-83", label: "Quaternary Faults", desc: "USGS Quaternary Fault & Fold Database (2020 release) — faults active in the last 1.6M yrs. Source: USGS Earthquake Hazards Program.", cat: "geology", kind: "export", url: "https://earthquake.usgs.gov/arcgis/rest/services/haz/Qfaults/MapServer", opacity: 0.85, minZoom: 4 },
  { key: "usgs-mrds", label: "Mineral Resources (MRDS)", desc: "USGS Mineral Resources Data System — mines, prospects & mineral occurrences. Source: USGS mrdata.", cat: "geology", kind: "wms", url: "https://mrdata.usgs.gov/services/mrds", layers: "mrds", opacity: 0.85, minZoom: 4, home: [39.5, -117, 7] },
  { key: "usgs-usmin", label: "USMIN Mineral Deposits", desc: "USGS USMIN mineral deposit database — mapped mine feature point locations. Source: USGS mrdata.", cat: "geology", kind: "wms", url: "https://mrdata.usgs.gov/services/usmin", layers: "points", opacity: 0.85, minZoom: 5, home: [39.5, -117, 8] },
  { key: "usgs-active-mines", label: "US Active Mines", desc: "USGS US active mines & mineral processing plants. Source: USGS mrdata.", cat: "geology", kind: "wms", url: "https://mrdata.usgs.gov/services/active-mines", layers: "mineplant", opacity: 0.85, minZoom: 4 },
  { key: "usgs-world-deposits", label: "Major Mineral Deposits", desc: "USGS major mineral deposits of the world (OFR 2005-1294). Source: USGS mrdata.", cat: "geology", kind: "wms", url: "https://mrdata.usgs.gov/services/ofr20051294", layers: "ofr20051294", opacity: 0.85, minZoom: 3 },
  { key: "usgs-frac-wells", label: "Oil & Gas (Frac) Wells", desc: "USGS database of hydraulically fractured oil & gas wells, US (all well types). Source: USGS Energy.", cat: "geology", kind: "export", url: "https://energy.usgs.gov/arcgis/rest/services/frac/Frac_All_10/MapServer", opacity: 0.8, minZoom: 4 },
  { key: "usgs-noga-provinces", label: "Oil & Gas Provinces", desc: "USGS National Oil & Gas Assessment province boundaries (conventional/unconventional/coal-bed gas). Source: USGS Energy.", cat: "geology", kind: "export", url: "https://energy.usgs.gov/arcgis/rest/services/BaseMaps/noga_provinces/MapServer", opacity: 0.55, minZoom: 3 },
  { key: "usgs-mine-waste", label: "Mine Waste Inventory", desc: "USGS National Mine Waste Inventory — waste points & polygons. Source: USGS Energy/MRData.", cat: "geology", kind: "export", url: "https://energy.usgs.gov/arcgis/rest/services/MRData/National_Mine_Waste_Inventory/MapServer", opacity: 0.8, minZoom: 5 },
  // ---- Infrastructure (verified live 2026) ----
  { key: "nacei-power-plants", label: "Power Plants (100MW+)", desc: "Power plants 100 MW or more, colored by energy source — North American Cooperation on Energy Information (US EIA / NRCan / Mexico SENER)", cat: "infra", kind: "export", url: "https://geoappext.nrcan.gc.ca/arcgis/rest/services/NACEI/energy_infrastructure_of_north_america_en/MapServer", layers: "16,17,18,19,20,21,22,23,24,25,26,27", opacity: 0.9, minZoom: 4 },
  { key: "nacei-transmission", label: "Electric Transmission", desc: "Electric power transmission lines — North American Cooperation on Energy Information (NACEI: US EIA / NRCan)", cat: "infra", kind: "export", url: "https://geoappext.nrcan.gc.ca/arcgis/rest/services/NACEI/energy_infrastructure_of_north_america_en/MapServer", layers: "1", opacity: 0.8, minZoom: 4, home: [32.55, -116.9, 9] },
  { key: "nacei-pipelines", label: "Oil & Gas Pipelines", desc: "Natural gas and liquids (oil) pipelines — North American Cooperation on Energy Information (NACEI: US EIA / NRCan)", cat: "infra", kind: "export", url: "https://geoappext.nrcan.gc.ca/arcgis/rest/services/NACEI/energy_infrastructure_of_north_america_en/MapServer", layers: "2,3", opacity: 0.8, minZoom: 4, home: [31.33, -109.6, 8] },
  { key: "nacei-refineries", label: "Refineries", desc: "Petroleum refineries and upgraders — North American Cooperation on Energy Information (NACEI: US EIA / NRCan)", cat: "infra", kind: "export", url: "https://geoappext.nrcan.gc.ca/arcgis/rest/services/NACEI/energy_infrastructure_of_north_america_en/MapServer", layers: "10", opacity: 0.85, minZoom: 4 },
  { key: "nacei-lng-terminals", label: "LNG Terminals", desc: "Liquefied natural gas import/export terminals — North American Cooperation on Energy Information (NACEI: US EIA / NRCan)", cat: "infra", kind: "export", url: "https://geoappext.nrcan.gc.ca/arcgis/rest/services/NACEI/energy_infrastructure_of_north_america_en/MapServer", layers: "5", opacity: 0.85, minZoom: 4 },
  { key: "nacei-solar-resource", label: "Solar Resource (GHI)", desc: "Solar resource potential, NSRDB PSM Global Horizontal Irradiance — North American Cooperation on Energy Information / NREL", cat: "infra", kind: "export", url: "https://geoappext.nrcan.gc.ca/arcgis/rest/services/NACEI/energy_resource_potential_of_north_america_en/MapServer", layers: "0", opacity: 0.7, minZoom: 4 },
  { key: "epa-solar-potential", label: "Solar Re-Power Sites", desc: "Solar renewable-energy potential on contaminated lands/landfills/mines — EPA RE-Powering America's Land (geopub.epa.gov OLEM/RePM)", cat: "infra", kind: "export", url: "https://geopub.epa.gov/ArcGIS/rest/services/OLEM/RePM/MapServer", layers: "0", opacity: 0.85, minZoom: 5 },
  { key: "epa-wind-potential", label: "Wind Re-Power Sites", desc: "Wind renewable-energy potential on contaminated lands/landfills/mines — EPA RE-Powering America's Land (geopub.epa.gov OLEM/RePM)", cat: "infra", kind: "export", url: "https://geopub.epa.gov/ArcGIS/rest/services/OLEM/RePM/MapServer", layers: "1", opacity: 0.85, minZoom: 5 },
  { key: "hifld-transmission-subs", label: "Transmission + Substations", desc: "HIFLD electric transmission lines (by voltage) and substations (by max voltage), national US dataset rehosted on Rutgers ArcGIS", cat: "infra", kind: "export", url: "https://oceandata.rad.rutgers.edu/arcgis/rest/services/RenewableEnergy/HIFLD_Electric_SubstationsTransmissionLines/MapServer", layers: "0,1", opacity: 0.8, minZoom: 5 },
  { key: "boem-atlantic-energy", label: "Atlantic OCS Oil & Gas", desc: "Atlantic OCS oil & natural gas wells, lease blocks and planning areas — US BOEM (gis.boem.gov BOEM_BSEE/ATL_Layers, can be slow)", cat: "infra", kind: "export", url: "https://gis.boem.gov/arcgis/rest/services/BOEM_BSEE/ATL_Layers/MapServer", layers: "1,4,5", opacity: 0.7, minZoom: 5, home: [38, -74, 6] },
  { key: "usgs-transportation", label: "Roads, Rail & Trails", desc: "USGS The National Map - Transportation: roads, railroads, ferries, trails (national, Census/USGS-sourced)", cat: "infra", kind: "export", url: "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer", opacity: 0.85, minZoom: 5 },
  { key: "usgs-airports-runways", label: "Airports & Runways", desc: "USGS The National Map airports + runways (FAA-derived) - sublayers 15/27/28 of the Transportation service", cat: "infra", kind: "export", url: "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer", layers: "15,27,28", opacity: 0.9, minZoom: 7 },
  { key: "usgs-railroads", label: "Railroads", desc: "USGS The National Map railroad network - sublayers 12/38 of the Transportation service", cat: "infra", kind: "export", url: "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer", layers: "12,38", opacity: 0.85, minZoom: 7 },
  { key: "tigerweb-roads", label: "Census TIGER Roads", desc: "US Census TIGERweb Transportation: primary/secondary/local road network + rail (detailed street geometry)", cat: "infra", kind: "export", url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer", opacity: 0.8, minZoom: 7 },
  { key: "national-highway-system", label: "Natl Highway System", desc: "US DOT/FHWA National Highway System (Interstates + principal arterials) via geo.dot.gov", cat: "infra", kind: "export", url: "https://geo.dot.gov/server/rest/services/National_Highway_System/MapServer", opacity: 0.85, minZoom: 7 },
  { key: "us-scenic-byways", label: "Scenic Byways", desc: "US DOT/FHWA America's Byways - National Scenic Byways & All-American Roads via geo.dot.gov", cat: "infra", kind: "export", url: "https://geo.dot.gov/server/rest/services/US_Scenic_Byways/MapServer", opacity: 0.8, minZoom: 5 },
  { key: "bts-airports-large-hub", label: "Large-Hub Airports", desc: "US DOT/BTS large-hub commercial airports (FAA hub classification, 2020) via geo.dot.gov", cat: "infra", kind: "export", url: "https://geo.dot.gov/server/rest/services/BTS/Airports_Large_Hub_2020/MapServer", opacity: 0.9, minZoom: 4 },
  { key: "bts-natgas-pipelines", label: "Natural Gas Pipelines", desc: "US DOT/BTS natural gas transmission pipelines (NTAD, 2020) via geo.dot.gov", cat: "infra", kind: "export", url: "https://geo.dot.gov/server/rest/services/BTS/NaturalGas_Pipelines_US_202001/MapServer", opacity: 0.7, minZoom: 4 },
  { key: "bts-crudeoil-pipelines", label: "Crude Oil Pipelines", desc: "US DOT/BTS crude oil pipelines (NTAD, 2020) via geo.dot.gov", cat: "infra", kind: "export", url: "https://geo.dot.gov/server/rest/services/BTS/CrudeOil_Pipelines_US_202001/MapServer", opacity: 0.7, minZoom: 4 },
  { key: "bts-hgl-pipelines", label: "HGL Pipelines", desc: "US DOT/BTS hydrocarbon gas liquids (HGL) pipelines (NTAD, 2020) via geo.dot.gov", cat: "infra", kind: "export", url: "https://geo.dot.gov/server/rest/services/BTS/HGL_Pipelines_US_202001/MapServer", opacity: 0.7, minZoom: 4 },
  // ---- Demographics & society (verified live 2026) ----
  { key: "epa-nata-cancer-risk", label: "Air Toxics Cancer Risk", desc: "2014 NATA estimated lifetime cancer risk from air toxics by census tract, US EPA OAQPS.", cat: "demographics", kind: "export", url: "https://gispub.epa.gov/arcgis/rest/services/OAR_OAQPS/2014_NATA_Risks/MapServer", layers: "0", opacity: 0.6, minZoom: 4 },
  { key: "cdc-svi-2022-usa", label: "Social Vulnerability 2022", desc: "CDC/ATSDR Social Vulnerability Index 2022 — overall SVI percentile by US county & census tract (16 social factors).", cat: "demographics", kind: "export", url: "https://onemap.cdc.gov/onemapservices/rest/services/SVI/CDC_ATSDR_Social_Vulnerability_Index_2022_USA/MapServer", opacity: 0.7, minZoom: 4 },
  { key: "cdc-eji-2022", label: "Environmental Justice 2022", desc: "CDC/ATSDR Environmental Justice Index 2022 — cumulative environmental + social + health burden ranks by census tract.", cat: "demographics", kind: "export", url: "https://onemap.cdc.gov/onemapservices/rest/services/EJI/Environmental_Justice_Index_2022/MapServer", opacity: 0.7, minZoom: 4 },
  { key: "cdc-eji-socioeconomic-2024", label: "Socioeconomic Status 2024", desc: "CDC/ATSDR EJI 2024 Socioeconomic module — poverty, unemployment, no health insurance, no diploma, housing cost burden by tract.", cat: "demographics", kind: "export", url: "https://onemap.cdc.gov/onemapservices/rest/services/EJI/SVM_SocioeconomicStatus_2024/MapServer", opacity: 0.7, minZoom: 4 },
  { key: "cdc-eji-minority-2024", label: "Racial/Ethnic Minority 2024", desc: "CDC/ATSDR EJI 2024 — racial & ethnic minority population status percentile by census tract.", cat: "demographics", kind: "export", url: "https://onemap.cdc.gov/onemapservices/rest/services/EJI/SVM_RacialEthnicMinorityStatus_MinorityStatus_2024/MapServer", opacity: 0.7, minZoom: 4 },
  { key: "cdc-eji-household-2024", label: "Household Characteristics 24", desc: "CDC/ATSDR EJI 2024 Household module — age 65+, age 17 & under, disability, limited English proficiency by census tract.", cat: "demographics", kind: "export", url: "https://onemap.cdc.gov/onemapservices/rest/services/EJI/SVM_HouseholdCharacteristics_2024/MapServer", opacity: 0.7, minZoom: 4 },
  { key: "cdc-omh-svi-2018", label: "Minority Health SVI 2018", desc: "CDC Office of Minority Health Social Vulnerability Index 2018 — county-level minority health vulnerability.", cat: "demographics", kind: "export", url: "https://onemap.cdc.gov/onemapservices/rest/services/OMH_SVI/Minority_Health_Social_Vulnerability_Index_2018_County_Data/MapServer", layers: "0", opacity: 0.7, minZoom: 4 },
  { key: "census-tigerweb-tracts", label: "Census Tracts & Blocks", desc: "US Census Bureau TIGERweb — census tracts, block groups & blocks geometry (ACS 2025 / 2020 Census vintages).", cat: "demographics", kind: "export", url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer", layers: "0,1", opacity: 0.65, minZoom: 9 },
  { key: "usda-food-access-fara", label: "Food deserts (USDA)", desc: "USDA ERS Food Access Research Atlas 2019 - census-tract low-income/low-access (food desert) indicators", cat: "demographics", kind: "export", url: "https://gisportal.ers.usda.gov/server/rest/services/FARA/FARA_2019/MapServer", opacity: 0.7, minZoom: 4 },
  { key: "hrsa-hospitals-clinics", label: "Hospitals & clinics (HRSA)", desc: "HRSA Health Care Facilities - hospitals, critical access hospitals, FQHCs & rural health clinics", cat: "demographics", kind: "export", url: "https://gisportal.hrsa.gov/server/rest/services/HealthCareFacilities/HealthCareFacilities/MapServer", layers: "1,2,3,4", opacity: 0.95, minZoom: 6 },
  { key: "usgs-hospitals", label: "Hospitals (USGS NatMap)", desc: "USGS The National Map Structures - Hospitals/Medical Centers point layer", cat: "demographics", kind: "export", url: "https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer", layers: "14", opacity: 0.95, minZoom: 6 },
  { key: "hrsa-shortage-areas", label: "Care shortage areas (HRSA)", desc: "HRSA Health Professional Shortage Areas (Primary Care HPSA) & Medically Underserved Areas", cat: "demographics", kind: "export", url: "https://gisportal.hrsa.gov/server/rest/services/HealthCareShortage/HealthCareShortage/MapServer", layers: "9,15", opacity: 0.6, minZoom: 4 },
  { key: "hrsa-places-obesity", label: "Adult obesity (CDC PLACES)", desc: "CDC PLACES model-based adult obesity prevalence by tract, served via HRSA Health Indicators", cat: "demographics", kind: "export", url: "https://gisportal.hrsa.gov/server/rest/services/HealthEquity/Health_Indicators/MapServer", layers: "3", opacity: 0.65, minZoom: 4 },
  { key: "hrsa-places-heart-disease", label: "Heart disease (CDC PLACES)", desc: "CDC PLACES model-based coronary heart disease prevalence by tract, served via HRSA Health Indicators", cat: "demographics", kind: "export", url: "https://gisportal.hrsa.gov/server/rest/services/HealthEquity/Health_Indicators/MapServer", layers: "0", opacity: 0.65, minZoom: 4 },
  { key: "hrsa-svi", label: "Social vulnerability (CDC/ATSDR)", desc: "CDC/ATSDR Social Vulnerability Index by county/tract, served via HRSA Health Equity", cat: "demographics", kind: "export", url: "https://gisportal.hrsa.gov/server/rest/services/HealthEquity/HealthEquity/MapServer", layers: "7", opacity: 0.65, minZoom: 4 },
  { key: "hrsa-meal-gap", label: "Food insecurity (Meal Gap)", desc: "Feeding America Map the Meal Gap food-insecurity rates by county, served via HRSA Health Equity", cat: "demographics", kind: "export", url: "https://gisportal.hrsa.gov/server/rest/services/HealthEquity/HealthEquity/MapServer", layers: "6", opacity: 0.65, minZoom: 4 },
  { key: "hrsa-county-health-rankings", label: "County Health Rankings", desc: "RWJF/Univ. of Wisconsin County Health Rankings overall health outcomes, served via HRSA Health Equity", cat: "demographics", kind: "export", url: "https://gisportal.hrsa.gov/server/rest/services/HealthEquity/HealthEquity/MapServer", layers: "11", opacity: 0.65, minZoom: 4 },
  { key: "hud-hiv-rates", label: "HIV rates by county (HUD)", desc: "HUD CPD Maps - HIV diagnosis rates per 100,000 population by county", cat: "demographics", kind: "export", url: "https://egis.hud.gov/arcgis/rest/services/cpdmaps/HIV/MapServer", layers: "0", opacity: 0.6, minZoom: 4 },
  { key: "hud-jobs-proximity", label: "Jobs proximity (HUD AFFH)", desc: "HUD AFFH opportunity index - Jobs Proximity Index by block group (access to employment)", cat: "demographics", kind: "export", url: "https://egis.hud.gov/arcgis/rest/services/affht/AffhtMapService/MapServer", layers: "14", opacity: 0.6, minZoom: 4 },
  { key: "hud-env-health-index", label: "Environmental health (HUD)", desc: "HUD AFFH opportunity index - Environmental Health Index (exposure to toxins) by block group", cat: "demographics", kind: "export", url: "https://egis.hud.gov/arcgis/rest/services/affht/AffhtMapService/MapServer", layers: "25", opacity: 0.6, minZoom: 4 },
  // ---- Imagery & terrain (verified live 2026) ----
  { key: "modis-terra-truecolor", label: "MODIS true color (Terra)", desc: "NASA GIBS MODIS Terra Corrected Reflectance true color, daily global. WMTS REST: append /{z}/{y}/{x}.jpg (z/y/x order); swap date for current UTC day", cat: "imagery", kind: "xyz", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9", opacity: 1, minZoom: 3 },
  { key: "viirs-snpp-truecolor", label: "VIIRS true color (SNPP)", desc: "NASA GIBS VIIRS Suomi-NPP Corrected Reflectance true color, daily global. WMTS REST: append /{z}/{y}/{x}.jpg (z/y/x order); swap date for current UTC day", cat: "imagery", kind: "xyz", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9", opacity: 1, minZoom: 3 },
  { key: "viirs-noaa20-truecolor", label: "VIIRS true color (NOAA-20)", desc: "NASA GIBS VIIRS NOAA-20 Corrected Reflectance true color, daily global (freshest overpass). WMTS REST: append /{z}/{y}/{x}.jpg (z/y/x order); swap date for current UTC day", cat: "imagery", kind: "xyz", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9", opacity: 1, minZoom: 3 },
  { key: "naip-imagery", label: "NAIP Aerial Imagery", desc: "USDA FSA NAIP National Agriculture Imagery Program, most-recent CONUS aerial (APFO tile cache); ArcGIS tiles /{z}/{y}/{x}.", cat: "imagery", kind: "xyz", url: "https://gis.apfo.usda.gov/arcgis/rest/services/NAIP/USDA_CONUS_PRIME/ImageServer/tile", opacity: 1, minZoom: 8 },
  { key: "esri-world-imagery", label: "Esri World Imagery", desc: "Global high-res satellite/aerial imagery basemap (Esri/Vantor/Maxar). XYZ tile cache, /{z}/{y}/{x}.", cat: "imagery", kind: "xyz", url: "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile", opacity: 1, minZoom: 3 },
  { key: "usgs-imagery-only", label: "USGS Imagery", desc: "USGS The National Map orthoimagery basemap (USGS). XYZ tile cache, /{z}/{y}/{x}.", cat: "imagery", kind: "xyz", url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile", opacity: 1, minZoom: 4 },
  { key: "usgs-imagery-topo", label: "USGS Imagery + Topo", desc: "USGS orthoimagery with US Topo vector labels overlaid (USGS National Map). XYZ tile cache, /{z}/{y}/{x}.", cat: "imagery", kind: "xyz", url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile", opacity: 1, minZoom: 4 },
  { key: "esri-world-hillshade", label: "World Hillshade", desc: "Global multi-directional terrain hillshade (Esri, sourced from 3DEP/SRTM/GMTED). XYZ tile cache, /{z}/{y}/{x}.", cat: "imagery", kind: "xyz", url: "https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile", opacity: 0.8, minZoom: 3 },
  { key: "usgs-shaded-relief", label: "USGS Shaded Relief", desc: "USGS 3DEP-derived shaded relief / terrain basemap (USGS National Map). XYZ tile cache, /{z}/{y}/{x}.", cat: "imagery", kind: "xyz", url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile", opacity: 0.85, minZoom: 4 },
  { key: "eox-s2cloudless-2024", label: "Sentinel-2 Cloudless", desc: "Global cloudless Sentinel-2 mosaic 2024 (EOX s2cloudless, ESA Copernicus data). WMS layer s2cloudless-2024_3857.", cat: "imagery", kind: "wms", url: "https://tiles.maps.eox.at/wms", layers: "s2cloudless-2024_3857", opacity: 1, minZoom: 3 },
  { key: "usgs-3dep-hillshade-multi", label: "3DEP Hillshade", desc: "USGS 3DEP bare-earth multidirectional hillshade (USGS 3D Elevation Program WMS). Layer 'Hillshade Multidirectional'.", cat: "imagery", kind: "wms", url: "https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WMSServer", layers: "3DEPElevation:Hillshade Multidirectional", opacity: 0.85, minZoom: 5 },
  { key: "usgs-3dep-tinted-hillshade", label: "3DEP Tinted Relief", desc: "USGS 3DEP elevation-tinted hillshade (color by elevation, USGS 3DEP WMS). Layer 'Hillshade Elevation Tinted'.", cat: "imagery", kind: "wms", url: "https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WMSServer", layers: "3DEPElevation:Hillshade Elevation Tinted", opacity: 0.85, minZoom: 5 },
  { key: "usgs-3dep-slope", label: "3DEP Slope Map", desc: "USGS 3DEP terrain slope map, color-ramped by steepness (USGS 3DEP WMS). Layer 'Slope Map'.", cat: "imagery", kind: "wms", url: "https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WMSServer", layers: "3DEPElevation:Slope Map", opacity: 0.7, minZoom: 6 },
  { key: "usgs-3dep-aspect", label: "3DEP Aspect Map", desc: "USGS 3DEP terrain aspect map (slope-facing direction, USGS 3DEP WMS). Layer 'Aspect Map'.", cat: "imagery", kind: "wms", url: "https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WMSServer", layers: "3DEPElevation:Aspect Map", opacity: 0.7, minZoom: 6 },
  { key: "usgs-3dep-contours", label: "3DEP Contours", desc: "USGS 3DEP dynamically generated elevation contour lines (USGS 3DEP WMS). Layer 'Contour 25'; renders best at large scale.", cat: "imagery", kind: "wms", url: "https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WMSServer", layers: "3DEPElevation:Contour 25", opacity: 0.8, minZoom: 11 },
]
// NASA GIBS (and other daily near-real-time sources) need a recent date. GIBS has
// ~a 1-day latency, so we ask for 2 days ago (UTC) — guaranteed-available imagery.
// Used wherever a layer's url/template contains the {date} placeholder.
function recentDateUTC(): string {
  return new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
}
function makeOverlay(g: GMaps, def: LayerDef): GMaps {
  return new g.maps.ImageMapType({
    name: def.label,
    tileSize: new g.maps.Size(256, 256),
    opacity: def.opacity,
    getTileUrl: (coord: { x: number; y: number }, zoom: number) => {
      const date = recentDateUTC()
      const sub = (u: string) =>
        u
          .replace(/\{z\}/g, String(zoom))
          .replace(/\{x\}/g, String(coord.x))
          .replace(/\{-y\}/g, String(Math.pow(2, zoom) - 1 - coord.y))
          .replace(/\{y\}/g, String(coord.y))
          .replace(/\{s\}/g, 'a')
          .replace(/\{date\}/g, date)
      // Explicit template wins (NASA GIBS live imagery, custom XYZ/WMTS).
      if (def.tpl) return sub(def.tpl)
      if (def.kind === 'xyz') {
        const u = sub(def.url)
        // NASA GIBS WMTS REST: /{z}/{y}/{x}.{ext} (true-color = jpg, data = png).
        if (u.includes('gibs.earthdata.nasa.gov')) {
          const ext = /TrueColor/i.test(u) ? 'jpg' : 'png'
          return `${u}/${zoom}/${coord.y}/${coord.x}.${ext}`
        }
        // ArcGIS MapServer/ImageServer tile caches use /{z}/{y}/{x}; OSM-style uses /{z}/{x}/{y}.png
        if (/\/(MapServer|ImageServer)\/tile/.test(u)) return `${u}/${zoom}/${coord.y}/${coord.x}`
        return `${u}/${zoom}/${coord.x}/${coord.y}.png`
      }
      const b = tileToBbox3857(coord.x, coord.y, zoom)
      if (def.kind === 'wms') {
        // OGC WMS 1.3.0, EPSG:3857 (axis order is easting,northing → bbox stays minx,miny,maxx,maxy).
        // No TIME param — temporal servers (NASA GIBS) then default to the LATEST
        // available date, which never 404s (a fixed date breaks layers whose feed
        // lags or needs sub-daily timestamps, e.g. GOES / OMI / AIRS).
        return (
          `${def.url}${def.url.includes('?') ? '&' : '?'}service=WMS&request=GetMap&version=1.3.0` +
          `&layers=${encodeURIComponent(def.layers || '')}&styles=&crs=EPSG:3857` +
          `&bbox=${b.join(',')}&width=256&height=256&format=image/png&transparent=true`
        )
      }
      // ArcGIS dynamic overlay — ImageServer uses /exportImage, MapServer /export.
      if (def.url.includes('/ImageServer')) {
        return `${def.url}/exportImage?bbox=${b.join(',')}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image`
      }
      return `${def.url}/export?bbox=${b.join(',')}&bboxSR=3857&imageSR=3857&size=256,256&dpi=96&format=png32&transparent=true${def.layers ? `&layers=show:${def.layers}` : ''}&f=image`
    },
  })
}
// Some tile caches stop at a fixed zoom (NASA GIBS "GoogleMapsCompatible_LevelN").
// Past that zoom tiles 404 and the layer silently vanishes — so we cap the map.
function layerZoomCap(def: LayerDef): number {
  const m = (def.tpl || def.url).match(/GoogleMapsCompatible_Level(\d+)/)
  return m ? Number(m[1]) : 22
}

// Categories for drawing/labelling areas on the map.
const CATEGORIES = [
  { key: 'area', label: 'Area', color: '#AF8C56' },
  { key: 'residential', label: 'Residential', color: '#34d399' },
  { key: 'commercial', label: 'Commercial', color: '#5b9bff' },
  { key: 'industrial', label: 'Industrial', color: '#fbbf24' },
  { key: 'flood', label: 'Flood risk', color: '#f87171' },
  { key: 'opportunity', label: 'Opportunity', color: '#c084fc' },
]
// ---- AI map command parsing: turn a plain-language prompt into map actions ----
// keyword → data layer(s) to auto-enable when the prompt mentions it.
const LAYER_KEYWORDS: { re: RegExp; key: string }[] = [
  { re: /\b(flood|fema|inundat|floodplain|flood ?zone)\b/i, key: 'flood' },
  { re: /\b(base flood|bfe|flood elevation)\b/i, key: 'flood-bfe' },
  { re: /\b(wetlands?|marsh|swamp|bog)\b/i, key: 'wetlands' },
  { re: /\b(parcels?|propert(y|ies)|lots?|lot lines?|ownership|assessment|who owns)\b/i, key: 'parcels' },
  { re: /\b(plss|township|range|section line|land survey|cadastral)\b/i, key: 'plss' },
  { re: /\b(count(y|ies)|state lines?|borders?|boundar)\b/i, key: 'counties' },
  { re: /\b(census tracts?|block group|tracts?)\b/i, key: 'tracts' },
  { re: /\b(cit(y|ies)|towns?|municipal|places?|incorporated)\b/i, key: 'places' },
  { re: /\b(zip ?codes?|zcta|postal|puma)\b/i, key: 'zcta' },
  { re: /\b(congress|legislative|districts?|voting)\b/i, key: 'legislative' },
  { re: /\b(radar|storm|reflectivity)\b/i, key: 'radar' },
  { re: /\b(warnings?|alerts?|watch|advisor|tornado|hurricane)\b/i, key: 'warnings' },
  { re: /\b(precip|rainfall|rain )\b/i, key: 'precip' },
  { re: /\b(sea ?level|slr|coastal flood|storm surge)\b/i, key: 'slr' },
  { re: /\b(water|rivers?|lakes?|hydro|creek|stream)\b/i, key: 'water' },
  { re: /\b(watersheds?|basins?|drainage)\b/i, key: 'watersheds' },
  { re: /\b(forests?|woodland|national forest)\b/i, key: 'forests' },
  { re: /\b(wilderness|protected area)\b/i, key: 'wilderness' },
  { re: /\b(trails?|hiking|hike)\b/i, key: 'trails' },
  { re: /\b(roads?|railroads?|rail|highways?|streets?)\b/i, key: 'roads-rail' },
  { re: /\b(schools?|hospitals?|fire stations?|structures?|public building)\b/i, key: 'structures' },
  { re: /\b(epa|superfund|brownfield|contaminat|pollut|hazardous|toxic)\b/i, key: 'epa-frs' },
  { re: /\b(topo|contours?|elevation|terrain)\b/i, key: 'topo' },
  { re: /\b(aerial|satellite|imagery|orthophoto)\b/i, key: 'imagery' },
  { re: /\b(hillshade|shaded relief|relief)\b/i, key: 'hillshade' },
  { re: /\b(nautical|marine|charts?|harbor|coast guard)\b/i, key: 'charts' },
  { re: /\b(place names?|landmarks?|gnis|named features?)\b/i, key: 'geonames' },
  // ---- expanded catalog (auto-enable the right verified layer for a topic) ----
  { re: /\b(earthquakes?|seismic|quake|tremor)\b/i, key: 'usgs-recent-earthquakes' },
  { re: /\b(faults?|fault lines?|quaternary fault)\b/i, key: 'usgs-quaternary-faults' },
  { re: /\b(seismic hazard|ground shaking|pga)\b/i, key: 'usgs-seismic-hazard-pga' },
  { re: /\b(tsunami)\b/i, key: 'noaa-tsunami-energy' },
  { re: /\b(storm surge|slosh)\b/i, key: 'noaa-storm-surge-risk' },
  { re: /\b(dams?|levees?)\b/i, key: 'usace-nid-dams' },
  { re: /\b(wildfires?|fire perimeters?|burn scar|fire risk)\b/i, key: 'usfs-fire-occurrence-perimeter' },
  { re: /\b(active fires?|fire hotspots?|hot ?spots?|thermal anomal)\b/i, key: 'viirs-noaa20-fires' },
  { re: /\b(smoke|aerosol|haze)\b/i, key: 'modis-aod' },
  { re: /\b(drought)\b/i, key: 'us-drought-monitor' },
  { re: /\b(air quality|\baqi\b|smog|ozone|pm2\.?5|pollution levels?)\b/i, key: 'epa-current-aqi-county' },
  { re: /\b(snow ?pack|snow ?cover|snow depth|snowfall)\b/i, key: 'nohrsc-snow-analysis' },
  { re: /\b(stream ?gau?ges?|streamflow|river levels?|nwis)\b/i, key: 'usgs-stream-gauges' },
  { re: /\b(soils?|ssurgo|soil type|soil survey)\b/i, key: 'usa-soil-order' },
  { re: /\b(crops?|cropland|farmland|agricultur|harvest)\b/i, key: 'nlcd-land-cover-2021' },
  { re: /\b(land ?cover|nlcd|impervious|developed land)\b/i, key: 'nlcd-land-cover-2021' },
  { re: /\b(power ?plants?|electric generation|power generation)\b/i, key: 'nacei-power-plants' },
  { re: /\b(transmission lines?|power lines?|electric grid|the grid)\b/i, key: 'nacei-transmission' },
  { re: /\b(solar potential|solar resource|solar farm)\b/i, key: 'nacei-solar-resource' },
  { re: /\b(wind potential|wind resource|wind farm|turbines?)\b/i, key: 'epa-wind-potential' },
  { re: /\b(geolog|bedrock|lithology|rock units?)\b/i, key: 'usgs-mrds' },
  { re: /\b(mines?|mining|minerals?|mrds|ore)\b/i, key: 'usgs-mrds' },
  { re: /\b(social vulnerab|\bsvi\b|vulnerable population)\b/i, key: 'cdc-svi-2022-usa' },
  { re: /\b(food deserts?|food access|grocery access)\b/i, key: 'usda-food-access-fara' },
  { re: /\b(hospitals?|clinics?|health ?care facilit|medical center)\b/i, key: 'hrsa-hospitals-clinics' },
  { re: /\b(airports?|runways?|airfield|aviation)\b/i, key: 'usgs-airports-runways' },
  { re: /\b(critical habitat|endangered species|wildlife habitat)\b/i, key: 'fws-critical-habitat' },
  { re: /\b(national parks?|\bnps\b)\b/i, key: 'nps-national-parks' },
  { re: /\b(tribal|reservations?|indian land|native land|aian)\b/i, key: 'tiger-tribal-reservations' },
  { re: /\b(true ?colou?r|live satellite|satellite imagery today|modis|viirs)\b/i, key: 'viirs-noaa20-truecolor' },
]
// keyword → category (drives the color of an AI-drawn zone polygon).
const CAT_KEYWORDS: { re: RegExp; key: string }[] = [
  { re: /\b(resid|homes?|house|housing|apartments?|condos?|family)\b/i, key: 'residential' },
  { re: /\b(commerc|retail|stores?|shops?|office|business|restaurants?)\b/i, key: 'commercial' },
  { re: /\b(industr|warehouses?|factor|manufactur|logistics)\b/i, key: 'industrial' },
  { re: /\b(flood|risk|hazard|danger)\b/i, key: 'flood' },
  { re: /\b(opportun|develop|invest|vacant|land|growth|emerging)\b/i, key: 'opportunity' },
]
// verbs that mean "draw/outline a zone around the results", not just list them.
const DRAW_VERB = /\b(draw|outline|polygon|zone|mark|categor|highlight|boundary|perimeter|cluster|circle (the|around)|area around)\b/i
// Andrew's monotone-chain convex hull (lng = x, lat = y) for a result cluster.
function convexHull(pts: { lat: number; lng: number }[]): { lat: number; lng: number }[] {
  const p = pts.slice().sort((a, b) => a.lng - b.lng || a.lat - b.lat)
  if (p.length < 3) return p
  const cross = (o: typeof p[0], a: typeof p[0], b: typeof p[0]) => (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng)
  const lower: typeof p = []
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q) }
  const upper: typeof p = []
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q) }
  lower.pop(); upper.pop(); return lower.concat(upper)
}
const priceStr = (n: number | null) => (n == null ? '' : '$'.repeat(Math.max(1, n)))
// One-tap Google Places category searches (biased to the current map view).
const CATEGORY_CHIPS: { label: string; term: string }[] = [
  { label: 'Restaurants', term: 'restaurants' },
  { label: 'Retail', term: 'retail stores and shopping' },
  { label: 'Coffee', term: 'coffee shops' },
  { label: 'Hotels', term: 'hotels' },
  { label: 'Groceries', term: 'grocery stores' },
  { label: 'Gas', term: 'gas stations' },
  { label: 'Banks', term: 'banks' },
  { label: 'Gyms', term: 'gyms' },
  { label: 'Pharmacies', term: 'pharmacies' },
]
// Quick-jump targets so a user enabling a feature layer can hop to live coverage.
const PERMIT_JUMPS = [
  { label: 'Chicago', lat: 41.882, lng: -87.629 },
  { label: 'New York', lat: 40.713, lng: -74.006 },
  { label: 'Los Angeles', lat: 34.05, lng: -118.24 },
  { label: 'Austin', lat: 30.27, lng: -97.74 },
  { label: 'Seattle', lat: 47.606, lng: -122.333 },
  { label: 'San Francisco', lat: 37.775, lng: -122.42 },
  { label: 'Orlando', lat: 28.54, lng: -81.38 },
]
const PARCEL_JUMPS = [
  { label: 'Bozeman, MT', lat: 45.68, lng: -111.04 },
  { label: 'Raleigh, NC', lat: 35.78, lng: -78.64 },
  { label: 'Salt Lake City, UT', lat: 40.76, lng: -111.89 },
  { label: 'Montpelier, VT', lat: 44.26, lng: -72.58 },
  { label: 'Seattle, WA', lat: 47.606, lng: -122.333 },
]
const MAP_KEYS = [
  (import.meta.env.VITE_GOOGLE_MAPS_KEY as string) || '',
  (import.meta.env.VITE_GOOGLE_MAPS_KEY2 as string) || '',
].filter(Boolean)
const SHAPES_KEY = 'nalu-map-shapes'

export default function MapPanel() {
  const { isDark } = useTheme()
  // Roadmap base ('dark'/'streets') follows the app theme; satellite/terrain
  // keep Google's native imagery.
  const roadmapStyle = isDark ? DARK_STYLE : LIGHT_STYLE
  const [keyIdx, setKeyIdx] = useState(0)
  const key = MAP_KEYS[keyIdx] || ''
  const mapEl = useRef<HTMLDivElement>(null)
  const mapRef = useRef<GMaps>(null)
  const infoRef = useRef<GMaps>(null)
  const markersRef = useRef<GMaps[]>([])
  const shapesRef = useRef<GMaps[]>([])
  const aiShapesRef = useRef<GMaps[]>([]) // shapes drawn by the LAST AI answer (cleared on new search / cancel)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [ready, setReady] = useState(false)
  const [authErr, setAuthErr] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [base, setBase] = useState('dark')
  const [active, setActive] = useState<Record<string, boolean>>({})
  const overlaysRef = useRef<Record<string, GMaps>>({})
  const parcelDataRef = useRef<GMaps>(null)
  const parcelIdleRef = useRef<GMaps>(null)
  const parcelLoadRef = useRef(0)
  const [parcelMsg, setParcelMsg] = useState('')
  const permitMarkersRef = useRef<GMaps[]>([])
  const permitIdleRef = useRef<GMaps>(null)
  const permitLoadRef = useRef(0)
  const [permitMsg, setPermitMsg] = useState('')
  const [coverageJump, setCoverageJump] = useState<{ label: string; lat: number; lng: number }[] | null>(null)
  const [showLayers, setShowLayers] = useState(false)
  const [layerQuery, setLayerQuery] = useState('')
  const [panelOpen, setPanelOpen] = useState(true)
  const [answer, setAnswer] = useState('')
  type Comparison = { title: string; criteria: string[]; places: Array<{ name: string; lat: number; lng: number; scores: Record<string, number>; note?: string }>; winner?: string }
  const [comparison, setComparison] = useState<Comparison | null>(null)

  useEffect(() => {
    ;(window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => {
      if (keyIdx + 1 < MAP_KEYS.length) { teardownMaps(); setReady(false); setKeyIdx((i) => i + 1) }
      else setAuthErr(true)
    }
  }, [keyIdx])

  // ---- init map + manual drawing listeners ----
  useEffect(() => {
    if (!key) { setErr('Map key not configured (VITE_GOOGLE_MAPS_KEY).'); return }
    let alive = true
    loadMaps(key).then((g) => {
      if (!alive || !mapEl.current) return
      const map = new g.maps.Map(mapEl.current, {
        center: { lat: 28.4, lng: -81.4 }, zoom: 6, clickableIcons: false,
        styles: roadmapStyle, backgroundColor: isDark ? '#1c2230' : '#e9e5db', disableDoubleClickZoom: true,
        mapTypeControl: false, streetViewControl: false, fullscreenControl: false, mapTypeId: 'roadmap',
      })
      mapRef.current = map
      infoRef.current = new g.maps.InfoWindow()
      // No manual drawing toolbar — Nalu draws polygons/lines/markers itself in
      // answer to map questions (see runSearch → drawAIShapes). Saved shapes from
      // earlier sessions still restore.
      restoreShapes(g, map)
      setReady(true)
    }).catch((e) => setErr(e.message))
    return () => { alive = false }
  }, [key])

  // ---- shapes persistence ----
  const saveShapes = () => {
    const g = (window as unknown as { google?: GMaps }).google
    const out = shapesRef.current.map((ov) => {
      if (ov.getPath) return { t: ov.getPaths ? 'polygon' : 'polyline', cat: ov.__cat, path: ov.getPath().getArray().map((p: GMaps) => ({ lat: p.lat(), lng: p.lng() })) }
      if (ov.getBounds) { const b = ov.getBounds(); return { t: 'rectangle', cat: ov.__cat, ne: { lat: b.getNorthEast().lat(), lng: b.getNorthEast().lng() }, sw: { lat: b.getSouthWest().lat(), lng: b.getSouthWest().lng() } } }
      if (ov.getRadius) { const c = ov.getCenter(); return { t: 'circle', cat: ov.__cat, lat: c.lat(), lng: c.lng(), r: ov.getRadius() } }
      const p = ov.getPosition(); return { t: 'marker', cat: ov.__cat, lat: p.lat(), lng: p.lng() }
    })
    try { localStorage.setItem(SHAPES_KEY, JSON.stringify(out)) } catch { /* */ }
    void g
  }
  const restoreShapes = (g: GMaps, map: GMaps) => {
    let saved: GMaps[] = []
    try { saved = JSON.parse(localStorage.getItem(SHAPES_KEY) || '[]') } catch { /* */ }
    for (const s of saved) {
      const color = CATEGORIES.find((c) => c.key === s.cat)?.color || GOLD
      const opt = { fillColor: color, strokeColor: color, fillOpacity: 0.18, strokeWeight: 2, map }
      let ov: GMaps
      if (s.t === 'polygon') ov = new g.maps.Polygon({ ...opt, paths: s.path })
      else if (s.t === 'polyline') ov = new g.maps.Polyline({ ...opt, path: s.path, fillOpacity: 0 })
      else if (s.t === 'rectangle') ov = new g.maps.Rectangle({ ...opt, bounds: { north: s.ne.lat, east: s.ne.lng, south: s.sw.lat, west: s.sw.lng } })
      else if (s.t === 'circle') ov = new g.maps.Circle({ ...opt, center: { lat: s.lat, lng: s.lng }, radius: s.r })
      else ov = new g.maps.Marker({ position: { lat: s.lat, lng: s.lng }, map })
      ov.__cat = s.cat
      shapesRef.current.push(ov)
    }
  }
  const clearShapes = () => {
    shapesRef.current.forEach((ov) => ov.setMap(null))
    shapesRef.current = []
    saveShapes()
  }

  // The trashcan: undo everything on the map — all active data layers AND drawn
  // shapes. (clearLayers is defined below; both are in scope by click time.)
  const clearMap = () => {
    clearLayers()
    clearShapes()
    clearAIShapes()
    setCoverageJump(null)
  }

  // ---- base map ----
  useEffect(() => {
    if (!mapRef.current) return
    const b = BASES.find((x) => x.key === base) || BASES[0]
    mapRef.current.setMapTypeId(b.gType)
    // Satellite/terrain keep native imagery; roadmap bases follow the theme.
    const styled = b.gType === 'roadmap'
    mapRef.current.setOptions({ styles: styled ? roadmapStyle : [] })
  }, [base, ready, roadmapStyle])

  // Frame the view so a just-enabled layer is actually VISIBLE.
  //  'toggle' (layer button): sparse/regional layers jump to their guaranteed-data
  //           home view; everything else nudges the zoom into the drawing range.
  //  'auto'   (AI/keyword enable): only jump home when the current view can't
  //           render the layer at all; otherwise gently nudge.
  //  'none'   (AI provided its own center/zoom): leave the view alone.
  const frameLayer = (def: LayerDef, mode: 'toggle' | 'auto' | 'none') => {
    const map = mapRef.current
    if (!map || mode === 'none') return
    const cap = layerZoomCap(def)
    const cur = map.getZoom() ?? 4
    if (def.home && (mode === 'toggle' || cur < def.minZoom)) {
      map.panTo({ lat: def.home[0], lng: def.home[1] })
      map.setZoom(Math.min(def.home[2], cap))
      return
    }
    if (def.opacity >= 1) {
      // A basemap renders at every zoom — only clamp to its floor/ceiling.
      if (cur < def.minZoom) map.setZoom(def.minZoom)
      else if (cur > cap) map.setZoom(cap)
      return
    }
    // Frame a DATA overlay where it's clearly visible: zoom IN if we're too far
    // out for it to render, and zoom OUT for broad/national layers when we're too
    // deep to see the pattern — so toggling any layer immediately shows it working.
    const target = Math.min(Math.max(6, Math.min(17, def.minZoom + 1)), cap)
    if (Math.abs(cur - target) > 1) map.setZoom(target)
  }

  // ---- ACS choropleths (live Census data drawn as colored polygons) --------
  // Zoom-adaptive granularity: states → counties → tracts, so the layer is
  // visible and correct at EVERY zoom height. Click any area for its value.
  const acsDataRef = useRef<Record<string, { data: GMaps; listener: GMaps | null; seq: number }>>({})
  const acsInfoRef = useRef<GMaps | null>(null)
  const acsLevelFor = (zoom: number) => (zoom < 7 ? 0 : zoom < 11 ? 1 : 2)
  const ACS_RAMP = ['#f5ead7', '#e8cf9f', '#d4ab62', '#b57f35', '#8a5a1d'] // brand-gold ramp
  const fmtAcs = (v: number, fmt: string) =>
    fmt === 'usd' ? `$${Math.round(v).toLocaleString()}` : fmt === 'pct' ? `${v.toFixed(0)}%` : fmt === 'density' ? `${Math.round(v).toLocaleString()} / mi²` : v.toFixed(1)
  const loadAcs = async (lk: string) => {
    const g = (window as unknown as { google?: GMaps }).google
    const map = mapRef.current
    const entry = acsDataRef.current[lk]
    const def = LAYERS.find((l) => l.key === lk)
    if (!g || !map || !entry || !def?.acs) return
    const b = map.getBounds()
    if (!b) return
    const seq = ++entry.seq
    const sw = b.getSouthWest()
    const ne = b.getNorthEast()
    const lvl = acsLevelFor(map.getZoom() ?? 10)
    const { service, field, fmt } = def.acs
    const url =
      `https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/${service}/FeatureServer/${lvl}/query` +
      `?geometry=${sw.lng()},${sw.lat()},${ne.lng()},${ne.lat()}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326` +
      `&spatialRel=esriSpatialRelIntersects&outFields=${field},NAME&returnGeometry=true&geometryPrecision=4&resultRecordCount=2000&f=geojson`
    try {
      const r = await fetch(url)
      const gj = (await r.json()) as { features?: Array<{ properties?: Record<string, unknown> }> }
      if (seq !== entry.seq || !acsDataRef.current[lk]) return // superseded / disabled
      const feats = gj.features || []
      // quantile breaks over the visible values
      const vals = feats
        .map((f) => {
          const raw = Number(f.properties?.[field])
          if (fmt === 'density') {
            const area = Number((f.properties as Record<string, unknown>)?.Shape__Area)
            return area > 0 ? raw / (area / 2.59e6) : NaN
          }
          return raw
        })
        .filter((v) => isFinite(v) && v > 0)
        .sort((a, z) => a - z)
      const breaks = [0.2, 0.4, 0.6, 0.8].map((q) => vals[Math.floor(q * (vals.length - 1))] ?? Infinity)
      entry.data.forEach((f: GMaps) => entry.data.remove(f))
      const added = entry.data.addGeoJson(gj)
      // stash computed display value per feature
      for (const f of added as GMaps[]) {
        let v = Number(f.getProperty(field))
        if (fmt === 'density') {
          const area = Number(f.getProperty('Shape__Area'))
          v = area > 0 ? v / (area / 2.59e6) : NaN
        }
        f.setProperty('__v', v)
      }
      entry.data.setStyle((f: GMaps) => {
        const v = Number(f.getProperty('__v'))
        if (!isFinite(v) || v <= 0) return { visible: false }
        let i = 0
        while (i < 4 && v > breaks[i]) i++
        return { fillColor: ACS_RAMP[i], fillOpacity: def.opacity, strokeColor: '#8a5a1d', strokeOpacity: 0.35, strokeWeight: 0.5, clickable: true }
      })
    } catch {
      /* transient — next idle retries */
    }
  }
  const enableAcs = (lk: string) => {
    const g = (window as unknown as { google?: GMaps }).google
    const map = mapRef.current
    const def = LAYERS.find((l) => l.key === lk)
    if (!g || !map || !def?.acs) return
    const data = new g.maps.Data({ map })
    if (!acsInfoRef.current) acsInfoRef.current = new g.maps.InfoWindow()
    data.addListener('click', (e: GMaps) => {
      const v = Number(e.feature.getProperty('__v'))
      const name = e.feature.getProperty('NAME')
      if (isFinite(v) && acsInfoRef.current) {
        acsInfoRef.current.setContent(`<div style="font:12px system-ui;color:#111"><b>${name || ''}</b><br/>${def.label}: <b>${fmtAcs(v, def.acs!.fmt)}</b></div>`)
        acsInfoRef.current.setPosition(e.latLng)
        acsInfoRef.current.open({ map })
      }
    })
    const listener = map.addListener('idle', () => void loadAcs(lk))
    acsDataRef.current[lk] = { data, listener, seq: 0 }
    void loadAcs(lk)
  }
  const disableAcs = (lk: string) => {
    const g = (window as unknown as { google?: GMaps }).google
    const entry = acsDataRef.current[lk]
    if (!entry) return
    entry.data.setMap(null)
    if (entry.listener && g) g.maps.event.removeListener(entry.listener)
    delete acsDataRef.current[lk]
  }

  const toggleLayer = (lk: string) => {
    const g = (window as unknown as { google?: GMaps }).google
    if (!g || !mapRef.current) return
    const def = LAYERS.find((l) => l.key === lk)!
    const on = !active[lk]
    if (def.kind === 'feature') {
      setActive((a) => ({ ...a, [lk]: on }))
      if (lk === 'permits') { if (on) enablePermits(); else disablePermits() }
      else if (on) enableParcels(); else disableParcels()
      return
    }
    if (def.kind === 'acs') {
      setActive((a) => ({ ...a, [lk]: on }))
      if (on) { enableAcs(lk); frameLayer(def, 'toggle') } else disableAcs(lk)
      return
    }
    setActive((a) => ({ ...a, [lk]: on }))
    if (on) {
      const ov = makeOverlay(g, def)
      overlaysRef.current[lk] = ov
      // opaque basemaps go to the bottom; transparent data overlays stack on top.
      if (def.opacity >= 1) mapRef.current.overlayMapTypes.insertAt(0, ov)
      else mapRef.current.overlayMapTypes.push(ov)
      frameLayer(def, 'toggle')
    } else {
      const idx = mapRef.current.overlayMapTypes.getArray().indexOf(overlaysRef.current[lk])
      if (idx >= 0) mapRef.current.overlayMapTypes.removeAt(idx)
      delete overlaysRef.current[lk]
    }
  }

  // Turn a layer on if it isn't already (used by the AI command). Returns the
  // layer label when it newly enabled one, else ''.
  const enableLayer = (lk: string, frame: 'auto' | 'none' = 'auto'): string => {
    if (active[lk]) return ''
    const g = (window as unknown as { google?: GMaps }).google
    if (!g || !mapRef.current) return ''
    const def = LAYERS.find((l) => l.key === lk)
    if (!def) return ''
    if (def.kind === 'feature') { setActive((a) => ({ ...a, [lk]: true })); if (lk === 'permits') enablePermits(); else enableParcels(); return def.label }
    if (def.kind === 'acs') { setActive((a) => ({ ...a, [lk]: true })); enableAcs(lk); frameLayer(def, frame); return def.label }
    const ov = makeOverlay(g, def)
    overlaysRef.current[lk] = ov
    if (def.opacity >= 1) mapRef.current.overlayMapTypes.insertAt(0, ov)
    else mapRef.current.overlayMapTypes.push(ov)
    frameLayer(def, frame)
    setActive((a) => ({ ...a, [lk]: true }))
    return def.label
  }
  // Pan + zoom the map to a coverage location (the idle listener then loads data).
  const jumpTo = (lat: number, lng: number, zoom = 15) => {
    if (!mapRef.current) return
    mapRef.current.panTo({ lat, lng }); mapRef.current.setZoom(zoom)
  }
  // ---- Property parcels: live public-records overlay (geometry + attributes) ----
  const loadParcels = () => {
    const g = (window as unknown as { google?: GMaps }).google
    const map = mapRef.current
    const data = parcelDataRef.current
    if (!g || !map || !data) return
    const b = map.getBounds(); if (!b) return
    const sw = b.getSouthWest(), ne = b.getNorthEast(), c = b.getCenter()
    const svc = parcelSvcFor(c.lng(), c.lat())
    // coverage check FIRST, so an uncovered view shows the jump banner immediately
    if (!svc) { data.forEach((f: GMaps) => data.remove(f)); setParcelMsg(`Parcels are live in ${PARCEL_SVCS.length} states`); setCoverageJump(PARCEL_JUMPS); return }
    setCoverageJump(null)
    if (map.getZoom() < 15) { data.forEach((f: GMaps) => data.remove(f)); setParcelMsg(`Zoom in closer to load ${svc.name} parcels`); return }
    const id = ++parcelLoadRef.current
    setParcelMsg(`Loading ${svc.name} parcels…`)
    const qs = new URLSearchParams({
      where: '1=1', geometry: `${sw.lng()},${sw.lat()},${ne.lng()},${ne.lat()}`,
      geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: '*', resultRecordCount: '700',
      returnGeometry: 'true', f: 'geojson',
    })
    fetch(`${svc.url}/query?${qs}`)
      .then((r) => r.json())
      .then((gj) => {
        if (id !== parcelLoadRef.current || !parcelDataRef.current) return
        data.forEach((f: GMaps) => data.remove(f))
        const n = (gj.features || []).length
        if (n) { try { data.addGeoJson(gj) } catch { /* skip bad geometry */ } }
        setParcelMsg(n ? `${svc.name}: ${n} parcels — click one for owner & assessment` : `No parcels in view (${svc.name})`)
      })
      .catch(() => { if (id === parcelLoadRef.current) setParcelMsg(`${svc.name} parcel service is busy — pan to retry`) })
  }
  const enableParcels = () => {
    const g = (window as unknown as { google?: GMaps }).google
    if (!g || !mapRef.current) return
    if (!parcelDataRef.current) {
      const data = new g.maps.Data({ map: mapRef.current })
      data.setStyle({ strokeColor: GOLD, strokeWeight: 1.1, fillColor: GOLD, fillOpacity: 0.05 })
      data.addListener('click', (e: { feature: GMaps; latLng: GMaps }) => {
        const props: Record<string, unknown> = {}
        e.feature.forEachProperty((v: unknown, k: string) => { props[k] = v })
        const facts = parcelFacts(props)
        const rows = facts.length
          ? facts.map((f) => `<div style="font-size:11px;margin-top:2px"><span style="color:#888">${f.label}:</span> <b>${f.value}</b></div>`).join('')
          : '<div style="font-size:11px;color:#888">No public attributes on this parcel</div>'
        infoRef.current.setContent(`<div style="font-family:Inter,sans-serif;max-width:250px;color:#111"><div style="font-weight:600;font-size:12px;margin-bottom:3px">Parcel</div>${rows}</div>`)
        infoRef.current.setPosition(e.latLng); infoRef.current.open(mapRef.current)
      })
      parcelDataRef.current = data
    }
    if (!parcelIdleRef.current) parcelIdleRef.current = mapRef.current.addListener('idle', loadParcels)
    loadParcels()
  }
  const disableParcels = () => {
    const g = (window as unknown as { google?: GMaps }).google
    if (parcelIdleRef.current && g) { g.maps.event.removeListener(parcelIdleRef.current); parcelIdleRef.current = null }
    if (parcelDataRef.current) {
      parcelDataRef.current.forEach((f: GMaps) => parcelDataRef.current.remove(f))
      parcelDataRef.current.setMap(null); parcelDataRef.current = null
    }
    setParcelMsg(''); setCoverageJump(null)
  }

  // ---- Building permits: live city open-data filings (pre-design → construction) ----
  const clearPermitMarkers = () => { permitMarkersRef.current.forEach((m) => m.setMap(null)); permitMarkersRef.current = [] }
  const loadPermits = async () => {
    const g = (window as unknown as { google?: GMaps }).google
    const map = mapRef.current
    if (!g || !map) return
    const c = map.getBounds()?.getCenter(); if (!c) return
    // coverage check FIRST → uncovered view shows the jump banner immediately
    if (!permitSvcFor(c.lng(), c.lat())) { clearPermitMarkers(); setPermitMsg(`Permits are live in ${permitCities()}`); setCoverageJump(PERMIT_JUMPS); return }
    setCoverageJump(null)
    if (map.getZoom() < 13) { clearPermitMarkers(); setPermitMsg('Zoom in closer to load permits'); return }
    const id = ++permitLoadRef.current
    setPermitMsg('Loading permits…')
    const res = await queryPermitsNear(c.lat(), c.lng(), 60)
    if (id !== permitLoadRef.current) return
    clearPermitMarkers()
    if (res.error) { setPermitMsg(res.error); return }
    let n = 0
    for (const p of res.permits || []) {
      if (p.lat == null || p.lng == null) continue
      n++
      const mk = new g.maps.Marker({
        position: { lat: p.lat, lng: p.lng }, map,
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 5, fillColor: '#5b9bff', fillOpacity: 0.95, strokeColor: '#0b1320', strokeWeight: 1 },
      })
      mk.addListener('click', () => {
        const rows = p.facts.map((f) => `<div style="font-size:11px;margin-top:2px"><span style="color:#888">${f.label}:</span> <b>${f.value}</b></div>`).join('')
        infoRef.current.setContent(`<div style="font-family:Inter,sans-serif;max-width:250px;color:#111"><div style="font-weight:600;font-size:12px;margin-bottom:3px">${p.title}</div>${rows}</div>`)
        infoRef.current.setPosition({ lat: p.lat, lng: p.lng }); infoRef.current.open(map)
      })
      permitMarkersRef.current.push(mk)
    }
    setPermitMsg(`${res.city}: ${n} recent permits — click one for details`)
  }
  const enablePermits = () => {
    const map = mapRef.current
    if (!map) return
    if (!permitIdleRef.current) permitIdleRef.current = map.addListener('idle', loadPermits)
    void loadPermits()
  }
  const disablePermits = () => {
    const g = (window as unknown as { google?: GMaps }).google
    if (permitIdleRef.current && g) { g.maps.event.removeListener(permitIdleRef.current); permitIdleRef.current = null }
    clearPermitMarkers()
    setPermitMsg(''); setCoverageJump(null)
  }

  // Turn every active layer off (panel "Clear" action).
  const clearLayers = () => {
    if (!mapRef.current) return
    LAYERS.forEach((l) => {
      // ACS choropleths are google.maps.Data layers, not overlayMapTypes — tear
      // those down through their own disable path so they actually disappear.
      if (l.kind === 'acs') { if (active[l.key]) disableAcs(l.key); return }
      const ov = overlaysRef.current[l.key]
      if (!ov) return
      const idx = mapRef.current.overlayMapTypes.getArray().indexOf(ov)
      if (idx >= 0) mapRef.current.overlayMapTypes.removeAt(idx)
      delete overlaysRef.current[l.key]
    })
    disableParcels()
    disablePermits()
    setActive({})
  }

  const focus = (p: Place) => {
    if (!mapRef.current || p.lat == null || p.lng == null) return
    mapRef.current.panTo({ lat: p.lat, lng: p.lng }); mapRef.current.setZoom(15); setSel(p.placeId)
    infoRef.current?.setContent(`<div style="font-family:Inter,sans-serif;max-width:240px;color:#111"><div style="font-weight:600;font-size:13px">${p.name}</div><div style="font-size:11px;color:#555;margin-top:2px">${p.address}</div>${p.rating ? `<div style="font-size:11px;color:#b8860b;margin-top:3px">★ ${p.rating} (${p.userRatings || 0})</div>` : ''}</div>`)
    const mk = markersRef.current.find((m) => m.__id === p.placeId)
    if (mk) infoRef.current?.open({ map: mapRef.current, anchor: mk })
  }
  // color search markers by category (AI/Places type) — a quick "categorize".
  const typeColor = (types: string[]) => {
    const t = (types || []).join(' ')
    if (/real_estate|premise|lodging|home/.test(t)) return '#34d399'
    if (/store|shopping|restaurant|food|cafe|bar/.test(t)) return '#5b9bff'
    if (/school|hospital|government|police/.test(t)) return '#c084fc'
    if (/park|natural|campground/.test(t)) return '#86efac'
    return GOLD
  }
  const plot = (res: Place[], fit = true) => {
    const g = (window as unknown as { google: GMaps }).google
    markersRef.current.forEach((m) => m.setMap(null)); markersRef.current = []
    if (!mapRef.current || !res.length) return
    const bounds = new g.maps.LatLngBounds()
    res.forEach((p, i) => {
      if (p.lat == null || p.lng == null) return
      const mk = new g.maps.Marker({
        position: { lat: p.lat, lng: p.lng }, map: mapRef.current,
        label: { text: String(i + 1), color: '#15170f', fontSize: '11px', fontWeight: '700' },
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 11, fillColor: typeColor(p.types), fillOpacity: 1, strokeColor: '#15170f', strokeWeight: 1.5 },
      })
      mk.__id = p.placeId; mk.addListener('click', () => focus(p)); markersRef.current.push(mk)
      bounds.extend({ lat: p.lat, lng: p.lng })
    })
    if (fit) mapRef.current.fitBounds(bounds, 60)
  }

  // Draw a category-colored zone polygon (convex hull) around a result cluster
  // and persist it — this is the AI "categorize using polygons" step.
  const drawZone = (res: Place[], catKey: string) => {
    const g = (window as unknown as { google?: GMaps }).google
    if (!g || !mapRef.current) return
    const hull = convexHull(res.map((p) => ({ lat: p.lat as number, lng: p.lng as number })))
    if (hull.length < 3) return
    const color = CATEGORIES.find((c) => c.key === catKey)?.color || GOLD
    const poly = new g.maps.Polygon({ paths: hull, map: mapRef.current, fillColor: color, strokeColor: color, fillOpacity: 0.14, strokeWeight: 2 })
    poly.__cat = catKey
    shapesRef.current.push(poly)
    saveShapes()
  }

  // Shapes the map AI returns — it draws these itself (no manual toolbar).
  type AIShape = {
    type: 'polygon' | 'polyline' | 'circle' | 'marker'
    category?: string; label?: string
    points?: { lat: number; lng: number }[]
    center?: { lat: number; lng: number }; radiusM?: number
    point?: { lat: number; lng: number }
  }
  // Draw the AI's shapes with category colors, persist them, and return their
  // combined bounds so the caller can frame the view.
  // Remove ONLY the shapes the previous AI answer drew (leave the user's saved
  // drawings untouched).
  const clearAIShapes = () => {
    for (const ov of aiShapesRef.current) {
      ov.setMap?.(null)
      const i = shapesRef.current.indexOf(ov)
      if (i >= 0) shapesRef.current.splice(i, 1)
    }
    aiShapesRef.current = []
  }
  const drawAIShapes = (shapes: AIShape[]): GMaps | null => {
    const g = (window as unknown as { google?: GMaps }).google
    const map = mapRef.current
    clearAIShapes() // a new answer replaces the last answer's shapes
    if (!g || !map || !shapes.length) return null
    const startIdx = shapesRef.current.length
    const bounds = new g.maps.LatLngBounds()
    let any = false
    for (const s of shapes) {
      const color = CATEGORIES.find((c) => c.key === s.category)?.color || GOLD
      const opt = { fillColor: color, strokeColor: color, fillOpacity: 0.16, strokeWeight: 2.5, map }
      let ov: GMaps = null
      let at: { lat: number; lng: number } | null = null
      if (s.type === 'polygon' && s.points && s.points.length >= 3) {
        ov = new g.maps.Polygon({ ...opt, paths: s.points })
        s.points.forEach((p) => bounds.extend(p)); at = s.points[0]; any = true
      } else if (s.type === 'polyline' && s.points && s.points.length >= 2) {
        ov = new g.maps.Polyline({ ...opt, path: s.points, fillOpacity: 0 })
        s.points.forEach((p) => bounds.extend(p)); at = s.points[0]; any = true
      } else if (s.type === 'circle' && s.center && s.radiusM) {
        ov = new g.maps.Circle({ ...opt, center: s.center, radius: s.radiusM })
        try { bounds.union(ov.getBounds()) } catch { bounds.extend(s.center) }
        at = s.center; any = true
      } else if (s.type === 'marker' && s.point) {
        ov = new g.maps.Marker({ position: s.point, map, title: s.label || '' })
        bounds.extend(s.point); at = s.point; any = true
      }
      if (!ov) continue
      ov.__cat = s.category || 'area'
      if (s.label) {
        const label = s.label
        const pos = at
        ov.addListener('click', (e: { latLng?: GMaps }) => {
          infoRef.current?.setContent(`<div style="font-family:Inter,sans-serif;max-width:240px;color:#111;font-size:12px;font-weight:600">${label}</div>`)
          infoRef.current?.setPosition(e?.latLng || pos)
          infoRef.current?.open(map)
        })
      }
      shapesRef.current.push(ov)
    }
    aiShapesRef.current = shapesRef.current.slice(startIdx) // this answer's shapes
    saveShapes()
    return any ? bounds : null
  }

  // Places lookup (Google Places → free OSM fallback server-side); plots pins.
  const runPlaces = async (q: string, fit: boolean, biasAt?: { lat: number; lng: number } | null): Promise<Place[]> => {
    // Bias the search to WHERE THE QUESTION IS ABOUT (the AI's center), not the
    // stale current view — otherwise "korean food in Orlando" searches the old spot.
    const c = mapRef.current?.getCenter?.()
    const bias = biasAt && typeof biasAt.lat === 'number' ? biasAt : (c ? { lat: c.lat(), lng: c.lng() } : {})
    const r = await fetch('/api/web', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'places', query: q, ...bias }) })
    const d = (await r.json()) as { results?: Place[]; error?: string }
    const res = (d.results || []).filter((p) => p.lat != null && p.lng != null)
    setResults(res); plot(res, fit)
    return res
  }

  // Legacy flow (also the no-AI fallback): keyword layer enabling + Places pins
  // + convex-hull zone when the prompt uses a draw verb.
  const legacySearch = async (q: string, preEnabled: string[]) => {
    const catKey = CAT_KEYWORDS.find((c) => c.re.test(q))?.key || 'area'
    const wantsZone = DRAW_VERB.test(q)
    const res = await runPlaces(q, true)
    if (wantsZone && res.length >= 3) drawZone(res, catKey)
    const notes: string[] = []
    if (preEnabled.length) notes.push(`Enabled ${preEnabled.join(' + ')}`)
    if (wantsZone && res.length >= 3) notes.push(`drew a ${CATEGORIES.find((c) => c.key === catKey)?.label.toLowerCase()} zone`)
    if (notes.length) setErr(notes.join(' · '))
    else if (!res.length) setErr('No results — try "waterfront homes in Miami".')
  }

  // The map search bar answers ANY question on the map: the AI returns an
  // answer + layers to enable + shapes it draws itself + a viewport, with an
  // optional live places search. Falls back to keyword matching + Places if
  // the AI engine is unavailable.
  // Geocode a place and zoom to it. Uses the result's viewport (Google's own
  // suggested bounds) so a city, neighborhood or address each land at the right
  // zoom automatically. Returns true if it moved the map.
  const geocodeTo = (place: string): Promise<boolean> =>
    new Promise((resolve) => {
      const g = (window as unknown as { google?: GMaps }).google
      const map = mapRef.current
      if (!g?.maps?.Geocoder || !map || !place.trim()) return resolve(false)
      try {
        new g.maps.Geocoder().geocode({ address: place }, (results: GMaps, status: string) => {
          if (status === 'OK' && results?.[0]?.geometry) {
            const geo = results[0].geometry
            if (geo.viewport) map.fitBounds(geo.viewport, 40)
            else if (geo.location) { map.panTo(geo.location); map.setZoom(14) }
            resolve(true)
          } else resolve(false)
        })
      } catch { resolve(false) }
    })

  // Cancel / reset — clear the current answer so you can ask something new.
  const clearSearch = () => {
    setQuery('')
    setAnswer('')
    setComparison(null)
    setResults([])
    setSel(null)
    setErr('')
    clearAIShapes()
    saveShapes()
  }

  const runSearch = async (q: string, aiMode = true) => {
    if (!q || loading) return
    setLoading(true); setErr(''); setAnswer('')
    // keyword fast-path: obviously-referenced data layers turn on immediately
    setComparison(null)
    const kwKeys = LAYER_KEYWORDS.filter((l) => l.re.test(q)).map((l) => l.key)
    try {
      if (!aiMode) {
        const pre = kwKeys.map((k) => enableLayer(k, 'auto')).filter(Boolean)
        await legacySearch(q, pre)
        return
      }
      const c = mapRef.current?.getCenter?.()
      const view = c ? { lat: c.lat(), lng: c.lng(), zoom: mapRef.current?.getZoom?.() ?? 6 } : {}
      const r = await fetch('/api/web', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mapai', query: q, ...view,
          catalog: LAYERS.map((l) => ({ key: l.key, label: l.label, desc: l.desc.slice(0, 90) })),
          categories: CATEGORIES.map((x) => x.key),
        }),
      })
      const d = (await r.json()) as {
        answer?: string; layers?: string[]; search?: string | null
        shapes?: AIShape[]; center?: { lat: number; lng: number } | null; zoom?: number | null; error?: string
        comparison?: { title: string; criteria: string[]; places: Array<{ name: string; lat: number; lng: number; scores: Record<string, number>; note?: string }>; winner?: string } | null
      }
      const gotPlan = d && !d.error && (d.answer || d.shapes?.length || d.layers?.length || d.search)
      if (!gotPlan) {
        // AI engine missing/failed — keyword + Places still answer the command.
        const pre = kwKeys.map((k) => enableLayer(k, 'auto')).filter(Boolean)
        await legacySearch(q, pre)
        return
      }
      const hasView = !!d.center
      // enable AI-chosen + keyword layers (without yanking the view when the AI framed it)
      const enabled = [...new Set([...(d.layers || []), ...kwKeys])]
        .map((k) => enableLayer(k, hasView ? 'none' : 'auto')).filter(Boolean)
      if (d.answer) setAnswer(d.answer)
      setComparison(d.comparison || null)
      // every compared place gets a pin even if the model drew none
      const compareMarkers: AIShape[] = (d.comparison?.places || []).map((pl) => ({ type: 'marker', category: 'area', label: pl.name, point: { lat: pl.lat, lng: pl.lng } }))
      const allShapes = [...(d.shapes || []), ...compareMarkers.filter((m) => !(d.shapes || []).some((sh) => sh.type === 'marker' && sh.label === m.label))]
      const shapeBounds = allShapes.length ? drawAIShapes(allShapes) : null
      if (d.search) await runPlaces(d.search, !hasView && !shapeBounds, d.center)
      else setResults([])
      // ALWAYS frame the view on where they're asking about: AI's explicit
      // center wins, then the drawn shapes, then a live geocode of the place —
      // so the map never just sits on the old view.
      let framed = false
      if (d.center && mapRef.current) {
        mapRef.current.panTo(d.center)
        let z = d.zoom ?? 12
        // never land below the drawing floor of a single just-enabled layer
        const defs = (d.layers || []).map((k) => LAYERS.find((l) => l.key === k)).filter(Boolean) as LayerDef[]
        const need = defs.length ? Math.min(...defs.map((l) => l.minZoom)) : 0
        if (need > z && need - z <= 3) z = need
        mapRef.current.setZoom(z)
        framed = true
      } else if (shapeBounds && mapRef.current) {
        mapRef.current.fitBounds(shapeBounds, 70)
        framed = true
      }
      // Fallback: geocode the place so we ALWAYS zoom to the asked-about location.
      if (!framed) framed = await geocodeTo(d.search || q)
      const notes: string[] = []
      if (enabled.length) notes.push(`Enabled ${enabled.join(' + ')}`)
      if (d.shapes?.length) notes.push(`drew ${d.shapes.length} shape${d.shapes.length > 1 ? 's' : ''}`)
      setErr(notes.join(' · '))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Search failed')
    } finally { setLoading(false) }
  }
  const search = () => void runSearch(query.trim())
  // One-tap category search — straight to Places (no AI round-trip needed).
  const searchCategory = (term: string) => { setQuery(term); void runSearch(term, false) }

  const activeCount = LAYERS.filter((l) => active[l.key]).length
  const lq = layerQuery.trim().toLowerCase()
  const visibleLayers = lq ? LAYERS.filter((l) => l.label.toLowerCase().includes(lq) || l.desc.toLowerCase().includes(lq)) : LAYERS

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left: search + results (overlay on mobile, in-flow on desktop) */}
      <div className={`${panelOpen ? 'flex' : 'hidden'} absolute inset-y-0 left-0 z-30 w-[min(20rem,86vw)] shrink-0 flex-col border-r border-glass/[0.12] bg-panel/75 backdrop-blur-2xl md:relative md:z-auto`}>
        <div className="border-b border-glass/[0.08] p-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-gold"><MapPin size={13} /></span>
            <span className="text-sm font-medium text-ink">Map search</span>
            <button onClick={() => setPanelOpen(false)} title="Hide panel" className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-dim hover:bg-glass/10 hover:text-ink"><X size={14} /></button>
          </div>
          <p className="mb-2 text-[11px] text-dim">Ask anything about anywhere — Nalu answers on the map: it enables the right data layers, draws its own polygons, lines and pins, and frames the view. Try "outline the flood-prone parts of New Orleans" or "best coffee neighborhoods in Portland".</p>
          <div className="flex items-center gap-1.5 rounded-xl border border-glass/[0.12] bg-glass/[0.04] px-2.5 py-2 focus-within:border-glass/25">
            <Search size={14} className="text-dim" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search() }}
              placeholder="Ask any map question…" className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-dim" />
            {(query || answer || comparison) && (
              <button onClick={clearSearch} disabled={loading} title="Clear — ask something else"
                className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full text-dim hover:bg-glass/15 hover:text-ink disabled:opacity-50">
                <X size={13} />
              </button>
            )}
            <button onClick={() => void search()} disabled={loading} className="shrink-0 text-accent disabled:opacity-50">
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {CATEGORY_CHIPS.map((c) => (
              <button key={c.term} onClick={() => searchCategory(c.term)} disabled={loading}
                className="rounded-full border border-glass/10 bg-glass/[0.05] px-2 py-0.5 text-[10px] text-ink hover:border-accent/50 hover:bg-accent/15 hover:text-[#e0c489] disabled:opacity-50">
                {c.label}
              </button>
            ))}
          </div>
          {err && <div className="mt-2 text-[11px] text-amber-300/90">{err}</div>}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {comparison && (
            <div className="mb-2 overflow-hidden rounded-xl border border-accent/30 bg-accent/[0.06]">
              <div className="border-b border-glass/10 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-gold">{comparison.title}</div>
              <div className="overflow-x-auto p-1.5">
                <table className="w-full border-collapse text-[10.5px]">
                  <thead>
                    <tr>
                      <th className="px-1.5 py-1 text-left font-medium text-dim">Place</th>
                      {comparison.criteria.map((c) => (
                        <th key={c} className="px-1 py-1 text-center font-medium capitalize text-dim">{c.slice(0, 12)}</th>
                      ))}
                      <th className="px-1 py-1 text-center font-medium text-dim">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.places
                      .map((pl) => ({ ...pl, total: comparison.criteria.reduce((t, c) => t + (pl.scores[c] || 0), 0) }))
                      .sort((a, b) => b.total - a.total)
                      .map((pl) => {
                        const isWinner = pl.name === comparison.winner
                        return (
                          <tr key={pl.name} className={isWinner ? 'bg-accent/15' : ''}>
                            <td className="max-w-[7rem] truncate px-1.5 py-1 font-medium text-ink" title={pl.note || pl.name}>
                              {isWinner ? '★ ' : ''}{pl.name}
                            </td>
                            {comparison.criteria.map((c) => {
                              const v = pl.scores[c] || 0
                              return (
                                <td key={c} className="px-1 py-1 text-center tabular-nums" style={{ color: v >= 8 ? '#4ade80' : v >= 5 ? undefined : '#f87171' }}>
                                  {v || '–'}
                                </td>
                              )
                            })}
                            <td className="px-1 py-1 text-center font-semibold tabular-nums text-gold">{pl.total}</td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {answer && (
            <div className="mb-2 rounded-xl border border-accent/30 bg-accent/[0.07] p-2.5">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-gold"><Sparkles size={11} /> Nalu</div>
              <p className="text-[12px] leading-relaxed text-ink">{answer}</p>
            </div>
          )}
          {results.map((p, i) => (
            <button key={p.placeId || i} onClick={() => focus(p)}
              className={`mb-1.5 flex w-full gap-2.5 rounded-xl border p-2 text-left transition-colors ${sel === p.placeId ? 'border-accent/50 bg-accent/[0.08]' : 'border-glass/[0.07] hover:bg-glass/[0.04]'}`}>
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-[#15170f]" style={{ background: typeColor(p.types) }}>{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{p.name}</span>
                <span className="mt-0.5 block truncate text-[11px] text-dim">{p.address}</span>
                <span className="mt-1 flex items-center gap-2 text-[10px] text-dim">
                  {p.rating != null && <span className="flex items-center gap-0.5 text-gold"><Star size={9} fill="currentColor" /> {p.rating}</span>}
                  {p.priceLevel != null && <span>{priceStr(p.priceLevel)}</span>}
                  {p.types[0] && <span className="capitalize">{p.types[0].replace(/_/g, ' ')}</span>}
                </span>
              </span>
              <a href={`https://www.google.com/maps/place/?q=place_id:${p.placeId}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="mt-0.5 shrink-0 text-dim hover:text-ink"><ExternalLink size={12} /></a>
            </button>
          ))}
          {!results.length && !answer && !loading && !err && <div className="px-2 py-6 text-center text-[11px] text-dim">Ask a question to see the answer on the map.</div>}
        </div>
      </div>

      {/* Map + controls */}
      <div className="relative flex-1">
        <div ref={mapEl} className="h-full w-full bg-[#1c2230]" />

        {ready && (
          // The map controls are dark frosted-glass overlays in BOTH themes, so we
          // scope them to dark tokens — otherwise `text-ink`/`bg-glass` flip to dark
          // text in light mode and the toolbar icons vanish into the panel.
          <div className="dark contents">
            {/* No drawing toolbar — Nalu draws shapes itself. Just panel-restore. */}
            {!panelOpen && (
              <button onClick={() => setPanelOpen(true)} title="Show search panel" className="absolute left-2 top-2 flex h-9 w-9 items-center justify-center rounded-xl border border-glass/[0.12] bg-black/60 text-gold backdrop-blur hover:bg-black/70"><PanelLeftOpen size={15} /></button>
            )}

            {/* Coverage jump banner — shown when parcels/permits are on but this view has no data */}
            {coverageJump && (active.parcels || active.permits) && (
              <div className="absolute left-1/2 top-3 z-20 flex max-w-[92vw] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-xl border border-accent/45 bg-black/80 px-3 py-2 text-[11px] text-ink shadow-lg backdrop-blur">
                <span className="mr-0.5 font-medium">No {active.permits && !active.parcels ? 'building permits' : active.parcels && !active.permits ? 'parcels' : 'data'} here yet — jump to live coverage:</span>
                {coverageJump.map((j) => (
                  <button key={j.label} onClick={() => jumpTo(j.lat, j.lng)} className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-[#15170f] hover:bg-gold">{j.label}</button>
                ))}
              </div>
            )}

            {/* Base maps + clear AI drawings */}
            <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-xl border border-glass/[0.12] bg-black/60 p-1 backdrop-blur">
              {BASES.map((b) => (
                <button key={b.key} onClick={() => setBase(b.key)} className={`rounded-lg px-2.5 py-1 text-[11px] ${base === b.key ? 'bg-accent text-[#15170f]' : 'text-ink hover:bg-glass/10'}`}>{b.label}</button>
              ))}
              <span className="mx-0.5 h-5 w-px bg-glass/15" />
              <button onClick={clearMap} title="Clear everything — turn off all layers and drawings" className="flex h-7 w-7 items-center justify-center rounded-lg text-ink hover:bg-red-500/30 hover:text-red-200"><Trash2 size={13} /></button>
            </div>

            {/* Layers — searchable, sectioned by type, scrollable, mobile-safe */}
            <div className="absolute right-2 top-2 z-20 flex flex-col items-end">
              <button onClick={() => setShowLayers((v) => !v)} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-glass/[0.12] bg-black/60 px-2.5 py-2 text-[12px] text-ink backdrop-blur hover:bg-black/70">
                <Layers size={14} className="text-gold" /> Layers
                {activeCount > 0 && <span className="ml-0.5 rounded-full bg-accent px-1.5 text-[10px] font-bold text-[#15170f]">{activeCount}</span>}
              </button>
              {showLayers && (
                <div className="mt-1.5 flex max-h-[min(72vh,34rem)] w-[min(18rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border border-glass/[0.12] bg-black/80 backdrop-blur">
                  <div className="flex items-center gap-2 border-b border-glass/10 px-2.5 py-2">
                    <Search size={13} className="text-dim" />
                    <input value={layerQuery} onChange={(e) => setLayerQuery(e.target.value)} placeholder={`Search ${LAYERS.length} layers…`} className="w-full bg-transparent text-[12px] text-ink outline-none placeholder:text-dim" />
                    {activeCount > 0 && <button onClick={clearLayers} title="Turn all off" className="shrink-0 text-[10px] text-gold hover:text-ink">Clear</button>}
                  </div>
                  <div className="flex-1 overflow-y-auto px-2 py-1.5">
                    {LAYER_CATS.map((c) => {
                      const items = visibleLayers.filter((l) => l.cat === c.key)
                      if (!items.length) return null
                      return (
                        <div key={c.key} className="mb-1.5">
                          <div className="px-1.5 py-1 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-gold">{c.label}</div>
                          {items.map((l) => (
                            <button key={l.key} onClick={() => toggleLayer(l.key)} className="flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-glass/[0.06]">
                              <span className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${active[l.key] ? 'border-accent bg-accent' : 'border-glass/30'}`}>{active[l.key] && <span className="h-1.5 w-1.5 rounded-sm bg-[#15170f]" />}</span>
                              <span className="min-w-0"><span className="block text-[12px] font-medium text-ink">{l.label}</span><span className="block text-[10px] leading-snug text-dim">{l.desc}</span></span>
                            </button>
                          ))}
                        </div>
                      )
                    })}
                    {!visibleLayers.length && <div className="px-2 py-4 text-center text-[11px] text-dim">No layers match "{layerQuery}".</div>}
                  </div>
                  <div className="border-t border-glass/10 px-2.5 py-1.5 text-[9px] leading-snug text-dim">{LAYERS.length} free public layers. Parcels (owner + assessment) live in {PARCEL_SVCS.length} states: {PARCEL_SVCS.map((s) => s.name).join(', ')}. Permits live in {permitCities()}. Queried live — always current.</div>
                </div>
              )}
            </div>
            <div className="pointer-events-none absolute bottom-3 right-3 max-w-[60vw] rounded-md bg-black/55 px-2 py-1 text-right text-[10px] text-dim backdrop-blur">
              {active.parcels && parcelMsg
                ? parcelMsg
                : active.permits && permitMsg
                  ? permitMsg
                  : activeCount > 0
                    ? `${activeCount} data layer${activeCount > 1 ? 's' : ''} on`
                    : 'Ask a question — Nalu draws the answer on the map'}
            </div>
          </div>
        )}

        {authErr && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-canvas/95 p-6">
            <div className="max-w-md text-[13px] leading-relaxed text-ink">
              <div className="mb-2 text-sm font-medium text-amber-300">Google rejected the Maps key</div>
              In the Cloud Console for this project, make sure: <b>billing is enabled</b>, <b>Maps JavaScript API</b> is enabled, and the key allows the Maps JavaScript API + referrers <b>n4lu.ai</b> / <b>n4lu.com</b>. Then reload.
            </div>
          </div>
        )}
        {!ready && !err && !authErr && <div className="absolute inset-0 flex items-center justify-center text-sm text-dim"><Loader2 size={18} className="mr-2 animate-spin" /> Loading map…</div>}
        {err && !ready && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-amber-300/90">{err}</div>}
      </div>
    </div>
  )
}
