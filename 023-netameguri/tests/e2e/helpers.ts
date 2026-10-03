import { expect, type APIRequestContext, type Page, type BrowserContext } from '@playwright/test';

export const DEMO = { email: 'demo@sample-build-lab.invalid', password: 'demo-password-123' };

export async function login(page: Page, email = DEMO.email, password = DEMO.password) {
  await page.goto('/login');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL('**/');
  await expect(page.locator('.tiles')).toBeVisible();
}

export async function register(page: Page, email: string, name = 'E2E User', password = 'e2e-password-123') {
  await page.goto('/login');
  await page.getByRole('button', { name: 'アカウントを作成する' }).click();
  await page.fill('input[autocomplete=name]', name);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.getByRole('button', { name: 'アカウント作成' }).click();
  await page.waitForURL('**/');
}

/** API helper bound to the page's cookies + csrf. */
export async function apiFor(page: Page) {
  const me = await (await page.request.get('/api/auth/me')).json();
  const ws: string = await page.evaluate(() => localStorage.getItem('netameguri.ws') ?? '');
  const wsId = ws || me.workspaces[0].id;
  const h = { 'x-csrf-token': me.csrfToken };
  const req: APIRequestContext = page.request;
  const ok = async (r: any) => {
    if (!r.ok()) throw new Error(`${r.status()} ${await r.text()}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
  return {
    me, wsId,
    get: (p: string) => req.get(`/api/w/${wsId}${p}`).then(ok),
    post: (p: string, data: unknown = {}) => req.post(`/api/w/${wsId}${p}`, { data, headers: h }).then(ok),
    patch: (p: string, data: unknown = {}) => req.patch(`/api/w/${wsId}${p}`, { data, headers: h }).then(ok),
    test: (p: string, data: unknown = {}) => req.post(`/api/test/${p}`, { data, headers: h }).then(ok),
    raw: req, headers: h,
  };
}

export const TRANSCRIPT = [
  'AIで個人開発をするときの考え方を話します。',
  '最初に大事なのは、作る前に完成条件を書くことです。',
  '完成条件があると、AIへの指示がぶれなくなります。',
  '次に、テストを先に書いてからAIに実装を頼みます。',
  'テストがあると、AIのコードが正しいかすぐに確認できます。',
  'リリース前にはチェックリストで表示と課金とバックアップを確認します。',
  '小さく作って小さく直すのが、結局いちばん速いです。',
].map((t, i) => `${i + 1}\n00:${String(i * 20 / 60 | 0).padStart(2, '0')}:${String((i * 20) % 60).padStart(2, '0')},000 --> 00:${String(((i + 1) * 20) / 60 | 0).padStart(2, '0')}:${String(((i + 1) * 20) % 60).padStart(2, '0')},000\n${t}`).join('\n\n');

export async function newContext(browserContext: BrowserContext) {
  return browserContext;
}
