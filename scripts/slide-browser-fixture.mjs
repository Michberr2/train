// Shared illustrative pitch fixture; no real claims or provider requests.
const logo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="220" height="40" viewBox="0 0 220 40"><path fill="#14392E" d="M2 32 20 1 38 32Z"/><text x="48" y="29" font-family="Arial" font-size="25" font-weight="700" fill="#14392E">CEDAR GRID</text></svg>')
export const deck = {
  title: 'Cedar Grid: Infrastructure for distributed energy', subtitle: 'Seed investor presentation · Illustrative fixture only', cover: 'solar panels on a modern commercial roof at dawn',
  design: { fonts: { display: 'Arial', body: 'Arial' }, radius: 12, motif: 'technical grid' },
  slides: [
    { title: 'A fragmented market leaves capacity unused', layout: 'stat', stat: { value: '38%', label: 'Illustrative idle capacity', sub: 'A fictional baseline for testing the pitch story.' }, notes: 'Fixture speaker note: distinguish the illustrative figure from measured customer evidence.' },
    { title: 'Traction compounds as sites join the network', layout: 'kpis', kpis: [{ value: '24', label: 'Pilot sites', delta: 'Fixture data' }, { value: '$1.2M', label: 'Annualized revenue', delta: 'Illustrative only' }, { value: '92%', label: 'Retention', delta: 'Example cohort' }] },
    { title: 'One connected operating system', layout: 'columns', columns: [{ heading: 'Connect', items: ['Integrate hardware already on site', 'Normalize operating data'] }, { heading: 'Optimize', accent: true, items: ['Dispatch within customer constraints', 'Measure realized savings'] }, { heading: 'Grow', items: ['Expand across a property portfolio', 'Share a consistent reporting view'] }] },
    { title: 'A credible route to positive contribution', layout: 'chart', chart: { type: 'bar', title: 'Illustrative contribution by quarter', unit: '$', labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Contribution', values: [-120000, -60000, 30000, 180000] }], takeaway: 'Fixture data moves from investment toward positive contribution.' } },
    { title: 'Customers need evidence they can act on', layout: 'quote', quote: { text: 'Give my team a reliable view of performance, without another operating dashboard to maintain.', attribution: 'Illustrative customer voice, not a testimonial' } },
    { title: 'Deployment economics improve with scale', layout: 'table', table: { headers: ['Metric', 'Pilot', 'Scaled case'], rows: [['Sites', '24', '120'], ['Deployment days', '14', '7'], ['Gross margin', '48%', '66%']], highlightCol: 2 } },
    { title: 'A focused seed round funds the next milestones', bullets: ['Product: validate operating integrations with existing pilot partners.', 'Commercial: prove a repeatable portfolio expansion motion.', 'Operations: improve deployment speed while preserving service quality.', 'Capital plan: all numbers in this fixture are illustrative.'], notes: 'Fixture speaker note: close with the agreed next step, not an invented funding commitment.' },
  ],
}
export const brand = { name: 'Cedar Grid', primary: '14392E', accent: '23664D', dark: '102B24', text: '182A22', onDark: 'FFFFFF', subtle: 'B5D5C4', headingFont: 'Arial', bodyFont: 'Arial', logo }
