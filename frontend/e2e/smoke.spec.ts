import { expect, test } from '@playwright/test'

// Full simulated race in the browser: connect, 3-lap race, leaderboard, chart, commentary,
// history, Italian UI, and no console errors anywhere along the way.
test('simulated 3-lap race runs end to end without console errors', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

  // The start sequence is short at 20x simulator speed, so polling could miss it: record
  // every time the start lights are rendered instead.
  await page.addInitScript(() => {
    ;(window as unknown as { __lights: Set<string> }).__lights = new Set()
    const scan = () => {
      document.querySelectorAll('[data-testid="start-lights"]').forEach((el) => {
        ;(window as unknown as { __lights: Set<string> }).__lights.add(el.getAttribute('data-light') ?? '')
      })
    }
    new MutationObserver(scan).observe(document, { subtree: true, childList: true, attributes: true })
  })

  await page.goto('/')
  await expect(page.getByTestId('backend-offline')).toHaveCount(0)

  // The simulator auto-connects at startup; connect through the UI if it did not.
  const pill = page.getByTestId('connection-pill')
  if (!(await pill.innerText()).match(/^connected$/i)) {
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
  }
  await expect(pill).toHaveText(/^connected$/i)

  // LAPS mode, 3 laps.
  const controls = page.getByRole('region', { name: 'Race controls' })
  await controls.locator('select').selectOption('laps')
  await controls.locator('input[type="number"]').fill('3')
  await page.getByRole('button', { name: 'Start', exact: true }).click()

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __lights: Set<string> }).__lights.size))
    .toBeGreaterThan(0)

  // Leaderboard rows with lap times (m:ss.mmm or s.mmm).
  const rows = page.getByTestId('leaderboard-row')
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('last-lap').first()).toHaveText(/\d+\.\d{3}/, { timeout: 30_000 })

  // Lap chart rendered with at least one plotted series.
  await expect(page.getByTestId('lap-chart').locator('svg').first()).toBeVisible()
  await expect(page.getByTestId('lap-chart').locator('path.recharts-line-curve').first()).toBeAttached({
    timeout: 30_000,
  })

  // Commentary (text only without ElevenLabs keys).
  await expect(page.getByTestId('commentary-line').first()).toBeVisible({ timeout: 30_000 })

  // Race finishes.
  await expect(page.getByTestId('phase-badge')).toHaveText(/finished/i, { timeout: 45_000 })
  await expect(page.getByTestId('event-line').filter({ hasText: /Race finished/ })).toHaveCount(1)

  // History lists the race.
  await page.getByRole('link', { name: 'History', exact: true }).click()
  await expect(page.getByTestId('history-table').locator('tbody tr').first()).toBeVisible()

  // Switch the UI to Italian and check a known label.
  await page.getByLabel('Interface language').selectOption('it')
  await expect(page.getByRole('heading', { name: 'Storico gare' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Impostazioni' })).toBeVisible()

  expect(errors, errors.join('\n')).toEqual([])
})
