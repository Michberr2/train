// Actual Studio gallery + SlidesCard with synthetic fixtures. Every API is
// intercepted: no account writes, generation or provider calls. A public frontend
// can be checked only with --allow-public-fixture and an explicitly named target.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { deck as standardDeck, brand } from './slide-browser-fixture.mjs'

const base = process.env.BASE_URL || 'http://127.0.0.1:5180'
const origin = new URL(base).origin
const hostname = new URL(base).hostname
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
assert.ok(local || (process.argv.includes('--allow-public-fixture') && (['n4lu.com', 'n4lu.ai', 'nalu-sigma.vercel.app'].includes(hostname) || hostname.endsWith('-mberry-hillpointecs-projects.vercel.app'))), 'Use a local target or explicitly allow the known public frontend fixture.')
const expanded = process.argv.includes('--expanded')
const deck = structuredClone(standardDeck)
let photo = null
if (expanded) {
  deck.slides[1].kpis.push({ value: '99.8%', label: 'Uptime', delta: 'Illustrative only' }, { value: '7 days', label: 'Deployment', delta: 'Example case' }, { value: '120', label: 'Target sites', delta: 'Scenario' })
  deck.slides[4].image = 'local geometry fixture for quotation image crop'
  const { default: sharp } = await import('sharp')
  photo = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><defs><linearGradient id="g"><stop stop-color="#2B5571"/><stop offset="1" stop-color="#C79E62"/></linearGradient></defs><rect width="960" height="540" fill="url(#g)"/><circle cx="770" cy="110" r="62" fill="#F2D993"/><path d="M0 420L220 230 460 430 700 210 960 420V540H0Z" fill="#1C493E"/><path d="M0 495L390 340 650 480 960 390V540H0Z" fill="#183B32"/><text x="480" y="280" text-anchor="middle" fill="white" font-family="Arial" font-size="30">LOCAL PHOTO FIXTURE</text></svg>')).png().toBuffer()
}
const photoSource = photo ? `data:image/png;base64,${photo.toString('base64')}` : ''
const output = process.env.OUTPUT_DIR || `/tmp/nalu-slide-regressions${expanded ? '-expanded' : ''}${local ? '' : '-' + hostname}`
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const report = []
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport })
    page.setDefaultTimeout(12000)
    const errors = [], blocked = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(({ deck, brand }) => {
      if (localStorage.getItem('slide-fixture-seeded')) return
      localStorage.setItem('slide-fixture-seeded', '1')
      localStorage.setItem('nalu-token', 'offline-slide-audit')
      localStorage.setItem('nalu-data-owner', 'slide-fixture')
      localStorage.setItem('nalu-theme', 'dark')
      localStorage.setItem('nalu-view', 'studio')
      localStorage.setItem('nalu-active-brand', JSON.stringify(brand))
      localStorage.setItem('nalu-chats', JSON.stringify([{ id: 'slide-audit', title: deck.title, createdAt: Date.now(), messages: [{ role: 'user', content: 'Show the saved pitch fixture.' }, { role: 'assistant', content: '', deck }] }]))
    }, { deck, brand })
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) { blocked.push(url.hostname); return route.abort() }
      if (!url.pathname.startsWith('/api/')) return route.continue()
      if (url.pathname === '/api/studio-image') {
        assert.equal(route.request().postDataJSON().action, 'lookup', 'opening a saved deck must not generate images')
        return photo ? route.fulfill({ json: { id: 'fixture-image', requestKey: 'fixture-key', url: photoSource, width: 960, height: 540, mimeType: 'image/png' } }) : route.fulfill({ status: 404, json: { error: 'Image not generated' } })
      }
      if (url.pathname === '/api/auth') return route.fulfill({ json: { ok: true, user: { id: 'slide-fixture', displayName: 'Slide audit' } } })
      if (url.pathname === '/api/data') return route.fulfill({ json: { ok: true, data: {}, activity: [] } })
      if (['/api/chat', '/api/slides', '/api/image', '/api/design'].includes(url.pathname)) { blocked.push(url.pathname); return route.abort() }
      return route.fulfill({ json: { ok: true, outputs: [], items: [], connections: [] } })
    })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    const openDeck = async (title) => {
      if (!await page.locator('.ws-studio-library').isVisible()) await page.getByRole('button', { name: /Your creations/ }).click()
      const gallery = page.getByRole('button').filter({ has: page.getByText(title, { exact: true }) }).last()
      await gallery.waitFor({ timeout: 25000 })
      await gallery.click()
      await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled({ timeout: 25000 })
      await page.evaluate(() => document.fonts.ready)
    }
    await openDeck(deck.title)
    const overlay = page.locator('div.fixed.inset-0.z-50').last()
    const card = overlay.locator('section[aria-label$=" deck"]')
    const main = card.locator('svg[data-slide-artboard][role="img"]')
    await expect(overlay).toHaveAttribute('role', 'dialog')
    await expect(overlay).toHaveAttribute('aria-modal', 'true')
    await expect(overlay.getByRole('button', { name: 'Close preview', exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(overlay.getByRole('button', { name: 'Open in chat', exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    assert.equal(await overlay.evaluate((node) => node.contains(document.activeElement)), true)
    await page.keyboard.press('Tab')
    await expect(overlay.getByRole('button', { name: 'Open in chat', exact: true })).toBeFocused()
    const metrics = async (locator) => locator.evaluateAll((panels, photoSource) => panels.map((panel) => {
      const box = panel.getBoundingClientRect()
      const text = [...panel.querySelectorAll('[data-slide-text]')].map((node) => ({ value: [...node.querySelectorAll('tspan')].map((span) => span.textContent).join(' '), box: node.getBBox() }))
      const outside = text.filter(({ box }) => box.x < -1 || box.y < -1 || box.x + box.width > 961 || box.y + box.height > 541).map((entry) => entry.value)
      const overlaps = []
      text.forEach((a, i) => text.slice(i + 1).forEach((b) => {
        if (Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x) > 1 && Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y) > 1) overlaps.push([a.value, b.value])
      }))
      const images = [...panel.querySelectorAll('image')].map((image) => ({ x: +image.getAttribute('x'), y: +image.getAttribute('y'), width: +image.getAttribute('width'), height: +image.getAttribute('height'), fit: image.getAttribute('preserveAspectRatio'), fixtureBytes: !!photoSource && image.getAttribute('href') === photoSource }))
      return { title: panel.getAttribute('aria-label'), width: box.width, height: box.height, aspect: box.width / box.height, outside, overlaps, images, text: text.map((entry) => entry.value) }
    }), photoSource)
    const screenshot = async (name) => {
      await main.scrollIntoViewIfNeeded()
      await main.screenshot({ path: `${output}/${viewport.width}-${name}.png` })
    }
    await screenshot('cover')
    await card.getByRole('button', { name: 'All slides', exact: true }).click()
    await expect(main).toHaveCount(8)
    const slides = await metrics(main)
    for (const slide of slides) {
      assert.ok(Math.abs(slide.aspect - 16 / 9) < 0.01, `${viewport.width}: incorrect aspect for ${slide.title}`)
      assert.deepEqual(slide.outside, [], `${viewport.width}: text escaped ${slide.title}`)
      assert.deepEqual(slide.overlaps, [], `${viewport.width}: text overlaps in ${slide.title}`)
      for (const image of slide.images) assert.ok(image.x >= 0 && image.y >= 0 && image.x + image.width <= 960 && image.y + image.height <= 540, 'image escapes artboard')
    }
    if (expanded) {
      for (const kpi of deck.slides[1].kpis) for (const text of Object.values(kpi)) assert.ok(slides[2].text.includes(text), `six-metric grid lost ${text}`)
      assert.deepEqual(slides[0].images.filter((image) => image.fixtureBytes), [{ x: 0, y: 0, width: 960, height: 540, fit: 'xMidYMid slice', fixtureBytes: true }])
      assert.deepEqual(slides[5].images.filter((image) => image.fixtureBytes), [{ x: 620, y: 182, width: 280, height: 292, fit: 'xMidYMid slice', fixtureBytes: true }], 'quotation must embed the exact local image with the intended crop')
    }
    await expect(card.getByRole('alert')).toHaveCount(0)
    for (const [i, name] of [[2, 'kpis'], [3, 'columns'], [4, 'chart'], [5, 'quote'], [6, 'table'], [7, 'bullets']]) {
      await main.nth(i).scrollIntoViewIfNeeded()
      await main.nth(i).screenshot({ path: `${output}/${viewport.width}-${name}.png` })
    }
    await card.getByRole('button', { name: 'Focus slide', exact: true }).click()

    // Presentation owns keyboard focus and restores it on exit; navigation does
    // not depend on pointer controls that are awkward on a small screen.
    await card.getByRole('button', { name: 'Present', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Present deck', exact: true })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(dialog.locator('svg[role="img"]')).toHaveAttribute('aria-label', deck.slides[0].title)
    await page.keyboard.press('End')
    await expect(dialog.locator('svg[role="img"]')).toHaveAttribute('aria-label', deck.slides.at(-1).title)
    await page.keyboard.press('Home')
    for (const key of ['Shift+Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab']) {
      await page.keyboard.press(key)
      assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true, `${key} escaped presentation`)
    }
    await page.screenshot({ path: `${output}/${viewport.width}-present.png` })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(overlay).toBeVisible()
    await expect(card.getByRole('button', { name: 'Present', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    await expect(page.getByRole('button').filter({ has: page.getByText(deck.title, { exact: true }) }).last()).toBeFocused()
    await openDeck(deck.title)

    // Cancel is reversible, while Save updates the stored source deck and
    // survives a full app reload with a fresh card instance.
    await card.getByRole('button', { name: `Slide 2: ${deck.slides[0].title}`, exact: true }).click()
    await card.getByRole('button', { name: 'Notes', exact: true }).click()
    await expect(card.getByText(deck.slides[0].notes, { exact: true })).toBeVisible()
    await card.getByRole('button', { name: 'Edit slide', exact: true }).click()
    await card.getByLabel(/^Slide title/).fill('A cancelled title')
    await card.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(main).toHaveAttribute('aria-label', deck.slides[0].title)
    const note = 'Updated fixture note: preserve user wording — Ω, growth +12%, and a concrete next step.'
    await card.getByRole('button', { name: 'Edit slide', exact: true }).click()
    await card.getByLabel(/^Speaker notes/).fill(note)
    await card.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(card.getByText(note, { exact: true })).toBeVisible()
    const longTitle = 'Cedar Grid: Modern infrastructure for distributed energy portfolios, reliable operations, and measurable commercial performance across every connected site'
    await card.getByRole('button', { name: `Slide 1: ${deck.title}`, exact: true }).click()
    await card.getByRole('button', { name: 'Edit slide', exact: true }).click()
    await card.getByLabel(/^Deck title/).fill(longTitle)
    await card.getByRole('button', { name: 'Save changes', exact: true }).click()
    const [longCover] = await metrics(main)
    assert.deepEqual(longCover.outside, [])
    assert.deepEqual(longCover.overlaps, [])
    assert.ok(longCover.text.includes(longTitle), 'long title must remain complete')
    await screenshot('long-title')
    await expect.poll(() => page.evaluate(() => {
      const deck = JSON.parse(localStorage.getItem('nalu-chats')).find((chat) => chat.id === 'slide-audit').messages[1].deck
      return { title: deck.title, note: deck.slides[0].notes }
    })).toEqual({ title: longTitle, note })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openDeck(longTitle)
    await expect(main).toHaveAttribute('aria-label', longTitle)
    await card.getByRole('button', { name: `Slide 2: ${deck.slides[0].title}`, exact: true }).click()
    await card.getByRole('button', { name: 'Notes', exact: true }).click()
    await expect(card.getByText(note, { exact: true })).toBeVisible()

    // A light brand cover must retain a dark, discoverable logo after media prep.
    await card.getByRole('button', { name: `Slide 1: ${longTitle}`, exact: true }).click()
    const logoImage = main.locator('image[height="28"]')
    const darkLogoSource = await logoImage.getAttribute('href')
    await page.evaluate((brand) => {
      localStorage.setItem('nalu-active-brand', JSON.stringify({ ...brand, dark: 'F5F5EF' }))
      window.dispatchEvent(new StorageEvent('storage', { key: 'nalu-active-brand' }))
    }, brand)
    await expect.poll(async () => {
      const source = await logoImage.getAttribute('href').catch(() => null)
      return !!source && source !== darkLogoSource
    }).toBe(true)
    await expect(card.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled()
    await expect(logoImage).toHaveCount(1)
    const lightLogo = await logoImage.evaluate(async (node) => {
      const image = new Image(); image.src = node.getAttribute('href'); await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let total = 0, count = 0
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 100) { total += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3; count++ }
      return { opaquePixels: count, meanBrightness: total / count }
    })
    assert.ok(lightLogo.opaquePixels > 100 && lightLogo.meanBrightness < 140, 'logo disappears against a light cover')
    await screenshot('light-cover-brand')
    assert.deepEqual(errors, [], 'actual UI emitted runtime errors')
    report.push({ viewport, slides, longCover, lightLogo, savedNotes: note, presentation: 'keyboard navigation, focus trap, Escape and focus restoration passed', persistence: 'cancel, save and reload passed', blocked: [...new Set(blocked)], errors })
    await page.close()
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  console.log(`PASS: 8 slides × desktop/mobile, 16:9 and content bounds; presentation keyboard/focus; edit cancel/save/reload; long title; light-brand logo${expanded ? '; six metrics and quotation photo with exact local PNG bytes/crop' : ''}. ${output}`)
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  throw error
} finally { await browser.close() }
