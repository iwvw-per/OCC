import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const svg = readFileSync(resolve(root, 'public/opencode.svg'), 'utf8')

const browser = await chromium.launch()

async function render(size, out) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  await page.setContent(
    `<html><head><style>html,body{margin:0;width:${size}px;height:${size}px;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style></head><body>${svg}</body></html>`,
  )
  await page.screenshot({ path: out, type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
  await page.close()
}

await render(192, resolve(root, 'public/icon-192.png'))
await render(512, resolve(root, 'public/icon-512.png'))
await render(180, resolve(root, 'public/apple-touch-icon.png'))

await browser.close()
console.log('PWA icons generated')
