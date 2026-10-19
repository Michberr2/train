import type { WebsiteTestExpectation, WebsiteTestStep, WebsiteTestTarget } from './websiteBehavior'

/** Private planning metadata. Mapping an inventory does not establish that the
 * inventory captured the whole brief, or that its checks have actually run. */
export type WebsiteRequirementGoal =
  | { kind: 'control'; action: WebsiteTestStep['action']; target: WebsiteTestTarget; value?: string }
  | { kind: 'result'; expectation: WebsiteTestExpectation }
  | { kind: 'state'; expectation: WebsiteTestExpectation }
  | { kind: 'capability'; description: string }

export type WebsiteRequirementReference =
  | { checkId: string; step: number }
  | { checkId: string; assertion: number }

export type WebsiteRequirement = {
  id: string
  quote: string
  viewports: ('desktop' | 'mobile')[]
  goal: WebsiteRequirementGoal
  coverage:
    | { state: 'mapped'; refs: WebsiteRequirementReference[] }
    | { state: 'unsupported' | 'uncovered'; reason: string }
}

/** This is the inventory schema version, independent of behavior-contract
 * versions. Legacy behavior contracts have no inventory and unknown coverage. */
export type WebsiteRequirementInventory = { version: 1; requirements: WebsiteRequirement[] }

export type WebsiteInventoryCoverage = {
  /** `mapped` means every declared item has compatible executable references,
   * not that the references ran, passed, or cover every requirement in prose. */
  status: 'unknown' | 'mapped' | 'partial'
  total: number
  mapped: number
  unsupported: number
  uncovered: number
}
