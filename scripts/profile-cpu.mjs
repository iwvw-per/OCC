import { chromium } from 'playwright'

const url = process.argv[2] || 'http://127.0.0.1:4188/'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()
const client = await context.newCDPSession(page)

await client.send('Profiler.enable')
await client.send('Profiler.setSamplingInterval', { interval: 200 })
await client.send('Profiler.start')

await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {})
await page.waitForTimeout(6000)

const { profile } = await client.send('Profiler.stop')

const hitById = new Map()
for (const n of profile.nodes) hitById.set(n.id, n)

const byFn = new Map()
for (const n of profile.nodes) {
  const cf = n.callFrame
  const key = `${cf.functionName || '(anonymous)'} @ ${String(cf.url).replace(/^.*\//, '')}:${cf.lineNumber + 1}`
  byFn.set(key, (byFn.get(key) || 0) + (n.hitCount || 0))
}

const sampleMs = 0.2
const top = [...byFn.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25)
  .map(([fn, hits]) => ({ fn, selfMs: +(hits * sampleMs).toFixed(1) }))

const totalHits = [...byFn.values()].reduce((a, b) => a + b, 0)
console.log(JSON.stringify({ url, profileSamples: profile.nodes.length, totalSampledMs: +(totalHits * sampleMs).toFixed(1), top }, null, 2))

await browser.close()
