import { chromium } from 'playwright'

const url = process.argv[2] || 'http://127.0.0.1:4188/'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()

const client = await context.newCDPSession(page)
await client.send('Performance.enable')

await page.addInitScript(() => {
  window.__longTasks = []
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) window.__longTasks.push({ d: e.duration, s: e.startTime })
    }).observe({ entryTypes: ['longtask'] })
  } catch {
    /* longtask 不被支持时忽略 */
  }
})

const t0 = Date.now()
let navErr = null
try {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 })
} catch (error) {
  navErr = String(error?.message || error)
}
await page.waitForTimeout(6000)

const nav = await page.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0]
  const paints = performance.getEntriesByType('paint')
  const res = performance.getEntriesByType('resource')
  const js = res.filter(r => r.name.includes('.js'))
  const sum = (arr, f) => arr.reduce((a, b) => a + (f(b) || 0), 0)
  return {
    dcl: n?.domContentLoadedEventEnd,
    load: n?.loadEventEnd,
    responseEnd: n?.responseEnd,
    fcp: paints.find(p => p.name === 'first-contentful-paint')?.startTime,
    jsCount: js.length,
    jsTransferKB: +(sum(js, r => r.transferSize) / 1024).toFixed(1),
    jsDecodedKB: +(sum(js, r => r.decodedBodySize) / 1024).toFixed(1),
    totalTransferKB: +(sum(res, r => r.transferSize) / 1024).toFixed(1),
    topJs: js
      .slice()
      .sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))
      .slice(0, 15)
      .map(r => ({ name: r.name.replace(/^.*\//, ''), kb: +((r.transferSize || 0) / 1024).toFixed(1) })),
    longTasks: window.__longTasks || [],
  }
})

const metrics = await client.send('Performance.getMetrics')
const m = Object.fromEntries(metrics.metrics.map(x => [x.name, x.value]))
const lt = nav.longTasks
const ltTotal = lt.reduce((a, b) => a + (b.d || 0), 0)

console.log(
  JSON.stringify(
    {
      url,
      navErr,
      elapsedMs: Date.now() - t0,
      navigation: { dcl: nav.dcl, load: nav.load, fcp: nav.fcp, responseEnd: nav.responseEnd },
      resources: {
        jsCount: nav.jsCount,
        jsTransferKB: nav.jsTransferKB,
        jsDecodedKB: nav.jsDecodedKB,
        totalTransferKB: nav.totalTransferKB,
        topJs: nav.topJs,
      },
      longTasks: {
        count: lt.length,
        totalMs: +ltTotal.toFixed(1),
        top: lt
          .slice()
          .sort((a, b) => b.d - a.d)
          .slice(0, 10)
          .map(x => ({ d: +x.d.toFixed(1), s: +x.s.toFixed(0) })),
      },
      cdp: {
        JSHeapUsedMB: +((m.JSHeapUsedSize || 0) / 1048576).toFixed(1),
        Nodes: m.Nodes,
        LayoutCount: m.LayoutCount,
        RecalcStyleCount: m.RecalcStyleCount,
        TaskDurationMs: +((m.TaskDuration || 0) * 1000).toFixed(1),
      },
    },
    null,
    2,
  ),
)

await browser.close()
