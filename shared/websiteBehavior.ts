/** Private artifact metadata; never embedded in downloadable or shared HTML. */
import type { WebsiteRequirementInventory } from './websiteRequirements'

export type WebsiteTestTarget = { label?: string; role?: string; name?: string; selector?: string }
export type WebsiteTestStep = { action: 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press'; target: WebsiteTestTarget; value?: string; viewport?: 'mobile' | 'desktop' }
export type WebsiteJsonValue = null | boolean | number | string | WebsiteJsonValue[] | { [key: string]: WebsiteJsonValue }
export type WebsiteDownloadContent =
  | { format: 'text'; equals: string }
  | { format: 'json'; equals: WebsiteJsonValue }
  | { format: 'csv'; equals: string[][] }
export type WebsiteTestExpectation = { type: 'text' | 'value' | 'visible' | 'hidden' | 'count' | 'checked' | 'hash' | 'download'; target?: WebsiteTestTarget; value?: string | number | boolean; content?: WebsiteDownloadContent }
export type WebsiteRuntimeTest = { name: string; steps: WebsiteTestStep[]; expect: WebsiteTestExpectation[] }
export type WebsiteBehaviorChange = { id: string; action: 'update' | 'remove' | 'add'; reason: string }
export type WebsiteBehaviorContractV1 = {
  version: 1
  checks: { id: string; test: WebsiteRuntimeTest }[]
  lastChanges?: WebsiteBehaviorChange[]
}
export type WebsiteRequirementSource = { requestHash: string; quote: string }
export type WebsiteBehaviorContractV2 = {
  version: 2
  checks: WebsiteBehaviorContractV1['checks']
  inventory: WebsiteRequirementInventory
  /** Source hashes identify provenance; they are not client-authenticity proof. */
  /** Definition provenance; mapping-only authorization remains in the change trace. */
  evidence: { id: string; origin: WebsiteRequirementSource; current?: WebsiteRequirementSource }[]
  /** Only an explicit removal of every declared requirement creates this. */
  requirementsRetired?: true
  lastChanges?: WebsiteBehaviorChange[]
  lastRequirementChanges?: (WebsiteBehaviorChange & { requestHash: string; requestQuote: string })[]
}
export type WebsiteBehaviorContract = WebsiteBehaviorContractV1 | WebsiteBehaviorContractV2
