import type { WebsiteBehaviorContract } from '../shared/websiteBehavior'
import type { WebsiteRequirementInventory, WebsiteInventoryCoverage } from '../shared/websiteRequirements'
import type { WebsiteRuntimeReview } from './_websiteRuntime'
import { summarizeWebsiteInventoryCoverage } from './_websiteRequirements'

export type WebsiteRequirementsReview = {
  scope: 'declared-inventory'
  status: 'unknown' | 'partial' | 'checked'
  inventory: WebsiteInventoryCoverage
  verified: number
  items: { id: string; status: 'verified' | 'unverified' | 'uncovered' | 'unsupported'; verifiedViewports: ('desktop' | 'mobile')[] }[]
}

/** Only executed evidence can verify a mapped requirement. Journey names and
 * a generic browser success cannot stand in for an indexed action/assertion.
 * This does not establish that extraction captured every prose requirement. */
export function reviewWebsiteRequirements(contract: { checks: WebsiteBehaviorContract['checks']; inventory?: WebsiteRequirementInventory } | undefined, runtime: WebsiteRuntimeReview): WebsiteRequirementsReview {
  const inventory = contract?.inventory
  const summary = inventory?.requirements.length ? summarizeWebsiteInventoryCoverage(inventory) : summarizeWebsiteInventoryCoverage()
  const report: WebsiteRequirementsReview = { scope: 'declared-inventory', status: 'unknown', inventory: summary, verified: 0, items: [] }
  if (!inventory?.requirements.length || !contract) return report
  const indexes = new Map(contract.checks.map((check, index) => [check.id, index]))
  for (const requirement of inventory.requirements) {
    const coverage = requirement.coverage
    if (coverage.state !== 'mapped') {
      report.items.push({ id: requirement.id, status: coverage.state, verifiedViewports: [] })
      continue
    }
    const verifiedViewports = requirement.viewports.filter(viewport => coverage.refs.some(ref => {
      const index = indexes.get(ref.checkId)
      if (index === undefined) return false
      const width = viewport === 'desktop' ? 1440 : 390
      const evidence = runtime.checks.filter(check => check.journeyIndex === index && check.width === width)
      // Ambiguous/duplicate evidence is not silently selected by its name.
      if (evidence.length !== 1 || !evidence[0].passed) return false
      if ('step' in ref) {
        const step = contract.checks[index].test.steps[ref.step]
        return !!step && (!step.viewport || step.viewport === viewport) && evidence[0].executedSteps?.includes(ref.step) === true
      }
      return evidence[0].passedAssertions?.includes(ref.assertion) === true
    }))
    const verified = verifiedViewports.length === requirement.viewports.length
    if (verified) report.verified++
    report.items.push({ id: requirement.id, status: verified ? 'verified' : 'unverified', verifiedViewports })
  }
  report.status = report.verified === inventory.requirements.length ? 'checked' : 'partial'
  return report
}

export function applyWebsiteRequirementReview(contract: { checks: WebsiteBehaviorContract['checks']; inventory?: WebsiteRequirementInventory } | undefined, runtime: WebsiteRuntimeReview): void {
  const requirements = reviewWebsiteRequirements(contract, runtime)
  runtime.requirements = requirements
  if (requirements.status !== 'checked' && runtime.status === 'passed') runtime.status = 'partial'
  runtime.limitations.push(requirements.status === 'unknown'
    ? 'Requested-feature coverage is unknown because this saved build has no validated requirement inventory.'
    : `${requirements.verified} of ${requirements.inventory.total} declared requirements have passing execution evidence at every requested viewport. This bounded inventory does not prove that every requirement in the brief was captured.`)
}
