import { test, expect, devices } from '@playwright/test';
import { login } from './helpers';

// Device emulation (Chromium) for iPhone / Android / iPad / PC layouts.
// NOTE: emulation only — real-device verification is listed as a pre-sale human check (TEST_REPORT.md).
const DEVICES: [string, any][] = [
  ['iPhone 13', devices['iPhone 13']],
  ['Pixel 7', devices['Pixel 7']],
  ['iPad (gen 7)', devices['iPad (gen 7)']],
  ['iPad landscape', devices['iPad (gen 7) landscape']],
  ['Desktop 1366', { viewport: { width: 1366, height: 860 } }],
];
const PAGES = ['/', '/sources', '/ideas', '/calendar', '/inbox', '/library', '/connectors', '/settings', '/performance'];

for (const [name, d] of DEVICES) {
  test(`responsive: ${name}`, async ({ browser }) => {
    const { defaultBrowserType: _x, ...opts } = d;
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await login(page);
    for (const p of PAGES) {
      await page.goto(p);
      await expect(page.locator('h1').first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name} ${p} horizontal overflow`).toBeLessThanOrEqual(1);
    }
    const w = page.viewportSize()!.width;
    if (w <= 700) await expect(page.locator('.bottom-nav')).toBeVisible();
    else if (w > 960) await expect(page.locator('aside.side')).toBeVisible();
    else await expect(page.getByRole('button', { name: 'メニュー' })).toBeVisible();
    // touch targets in bottom nav are >= 44px tall on phones
    if (w <= 700) {
      const h = await page.locator('.bottom-nav a').first().evaluate((el) => el.getBoundingClientRect().height);
      expect(h).toBeGreaterThanOrEqual(44);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  });
}
