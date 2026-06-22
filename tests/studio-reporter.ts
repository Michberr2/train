import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter'

// Categorizes every test by a leading [tag] in its title and prints a single
// human report at the end: what works, scalability signals, security findings,
// and what needs fixing.
type Row = { title: string; file: string; status: string; tag: string; notes: string[]; error?: string }

const TAGS: Record<string, string> = {
  health: 'WORKING — core features',
  ux: 'WORKING — UI / flows',
  mobile: 'WORKING — mobile',
  perf: 'SCALABILITY',
  security: 'SECURITY',
  a11y: 'ACCESSIBILITY',
}
const C = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  c: (s: string) => `\x1b[36m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

export default class StudioReporter implements Reporter {
  private rows: Row[] = []

  onTestEnd(test: TestCase, result: TestResult) {
    const m = test.title.match(/^\[(\w+)\]/)
    const tag = m ? m[1] : 'health'
    const notes = [
      ...result.annotations.filter((a) => a.type === 'metric').map((a) => a.description || ''),
      ...test.annotations.filter((a) => a.type === 'metric').map((a) => a.description || ''),
    ].filter(Boolean) as string[]
    this.rows.push({
      title: test.title.replace(/^\[\w+\]\s*/, ''),
      file: test.location.file.split('/').pop() || '',
      status: result.status,
      tag,
      notes,
      error: result.errors?.[0]?.message?.split('\n')[0],
    })
  }

  onEnd(result: FullResult) {
    const out: string[] = []
    const byTag = (t: string) => this.rows.filter((r) => r.tag === t)
    const pass = (r: Row) => r.status === 'passed'
    const line = (r: Row) => {
      const mark = pass(r) ? C.g('✔') : r.status === 'skipped' ? C.dim('–') : C.r('✗')
      const note = r.notes.length ? C.dim(`  (${r.notes.join('; ')})`) : ''
      const err = !pass(r) && r.error ? C.r(`  → ${r.error}`) : ''
      return `   ${mark} ${r.title}${note}${err}`
    }

    out.push('')
    out.push(C.b(C.c('━━━━━━━━━━━━━━━━━━━━━━━━  NALU TEST STUDIO  ━━━━━━━━━━━━━━━━━━━━━━━━')))
    const total = this.rows.length
    const passed = this.rows.filter(pass).length
    const failed = this.rows.filter((r) => r.status === 'failed' || r.status === 'timedOut').length
    const skipped = this.rows.filter((r) => r.status === 'skipped').length
    out.push(`   ${C.g(passed + ' passed')} · ${failed ? C.r(failed + ' failed') : '0 failed'} · ${C.dim(skipped + ' skipped')} · ${total} total`)

    // WHAT'S WORKING
    const working = ['health', 'ux', 'mobile']
    out.push('')
    out.push(C.b('✅ WHAT IS WORKING'))
    for (const t of working) {
      const rows = byTag(t)
      if (!rows.length) continue
      out.push(C.dim(`  ${TAGS[t]}`))
      rows.forEach((r) => out.push(line(r)))
    }

    // SCALABILITY
    const perf = byTag('perf')
    out.push('')
    out.push(C.b('📈 SCALABILITY'))
    if (!perf.length) out.push(C.dim('   (no perf checks ran)'))
    perf.forEach((r) => out.push(line(r)))

    // SECURITY
    const sec = byTag('security')
    out.push('')
    out.push(C.b('🔐 SECURITY'))
    if (!sec.length) out.push(C.dim('   (no security checks ran)'))
    sec.forEach((r) => out.push(line(r)))
    const secFindings = sec.filter((r) => !pass(r))
    if (secFindings.length) out.push('   ' + C.r(C.b(`${secFindings.length} security finding(s) — see above`)))
    else if (sec.length) out.push('   ' + C.g('No security findings.'))

    // ACCESSIBILITY (ADA / WCAG)
    const a11y = byTag('a11y')
    out.push('')
    out.push(C.b('♿ ACCESSIBILITY (ADA / WCAG 2.1 AA)'))
    if (!a11y.length) out.push(C.dim('   (no accessibility checks ran)'))
    a11y.forEach((r) => out.push(line(r)))
    if (a11y.length && a11y.every(pass)) out.push('   ' + C.g('No serious/critical WCAG violations.'))

    // NEEDS FIXING
    const broken = this.rows.filter((r) => r.status === 'failed' || r.status === 'timedOut')
    out.push('')
    out.push(C.b('🔧 WHAT NEEDS FIXING'))
    if (!broken.length) out.push('   ' + C.g('Nothing — all run checks passed.'))
    broken.forEach((r) => out.push(`   ${C.r('✗')} [${r.tag}] ${r.title}${r.error ? C.r(`  → ${r.error}`) : ''}  ${C.dim(r.file)}`))

    out.push('')
    out.push(C.dim('   HTML report: tests/.report/index.html  ·  re-run: npm run studio'))
    out.push(C.b(C.c('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')))
    out.push('')
    // eslint-disable-next-line no-console
    console.log(out.join('\n'))
    void result
  }
}
