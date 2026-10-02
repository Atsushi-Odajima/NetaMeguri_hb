import { createApp } from '../../server/src/app.js';
import { FixedClock } from '../../server/src/lib/util.js';
import { createUser, createWorkspace, ctxFor } from '../../server/src/domain/workspace.js';
import { createBrand } from '../../server/src/domain/brand.js';
import type { AIProvider, AIRequest } from '../../server/src/ai/gateway.js';
import type { Ctx } from '../../server/src/domain/context.js';

export const ARTICLE = `AIコーディングで個人開発をするときの失敗談を共有します。
最初の失敗は、仕様を決めないままAIにコードを書かせ始めたことです。
AIは指示が曖昧だと、目的とずれたコードを大量に出してきます。
そこで、実装前に一枚のPLANを書くことにしました。
二つ目の失敗は、テストを後回しにしたことです。
日付やタイムゾーンの処理は、テストなしで信じてはいけません。
リリース前のチェックリストを作ると、当日の事故が減りました。
チェックリストには表示確認、課金確認、バックアップ確認を入れています。`;

export class FakeProvider implements AIProvider {
  readonly configured = true;
  calls: AIRequest[] = [];
  constructor(readonly id: string, public reply: (req: AIRequest) => string = (r) => r.instruction.split('\n').slice(1).join('\n') || 'ok') {}
  async complete(req: AIRequest) {
    this.calls.push(req);
    return { text: this.reply(req), tokensIn: 100, tokensOut: 50 };
  }
}

export function makeEnv(opts: { now?: string } = {}) {
  const clock = new FixedClock(new Date(opts.now ?? '2026-10-01T03:00:00.000Z'));
  const app = createApp({ clock });
  const owner = createUser(app.db, 'owner@example.com', 'Owner', 'password-123456', clock.now());
  const ws = createWorkspace(app.db, owner.id, 'WS A', clock.now());
  const ctx: Ctx = ctxFor(app, owner.id, ws);
  const brand = createBrand(ctx, { name: 'Test Brand', bannedTerms: ['絶対儲かる'], bannedCtas: ['今すぐ購入'], emojiPolicy: 'few', maxEmoji: 1, tone: '落ち着いた' });
  return { app, clock, owner, ws, ctx, brand };
}

export function addMember(env: ReturnType<typeof makeEnv>, email: string, role: 'editor' | 'reviewer' | 'viewer' | 'admin', canPublish = false) {
  const u = createUser(env.app.db, email, email.split('@')[0], 'password-123456', env.clock.now());
  env.app.db.run('INSERT INTO memberships(workspace_id,user_id,role,can_publish_external) VALUES (?,?,?,?)', env.ws, u.id, role, canPublish ? 1 : 0);
  return ctxFor(env.app, u.id, env.ws);
}
