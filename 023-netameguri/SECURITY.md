# SECURITY

| 項目 | 実装 | 検証 |
|---|---|---|
| 認証 | email + パスワード（scrypt N=16384）。HttpOnly / SameSite=Lax / 本番Secure の session cookie（14日） | E2E全般 |
| CSRF | 非GETは `x-csrf-token`（セッション固有）必須 + SameSite | テスト30 |
| Tenant isolation | 全業務関数が `Ctx.workspaceId` で絞り込み、`getScoped` は他テナントに 404（存在を明かさない） | テスト30 |
| RBAC | owner/admin/editor/reviewer/viewer。外部投稿は owner/admin か個別付与の editor のみ | テスト30 |
| 入力検証 | zod スキーマ（Source/Idea/Brand/Campaign/Claim/Snapshot/Pack/Brief）、上限長 | |
| SQL | 全て bind parameter。動的な列名はコード内定数のみ（`assertIdent`） | |
| XSS | React の自動エスケープ。`dangerouslySetInnerHTML` 不使用。Sandbox OAuth 画面のみサーバーHTML（値はエスケープ） | |
| CSP 他ヘッダ | `default-src 'self'; script-src 'self'; frame-ancestors 'none'` 等、nosniff, Referrer-Policy, X-Frame-Options, Permissions-Policy | |
| Rate limit | ログイン/登録: IP 20/分・email 10/分。書き込み: IP 600/分。Connector: 30/分 token bucket | |
| SSRF | http/https のみ、認証情報付きURL・非標準ポート拒否、localhost/.internal/.local/metadata ホスト拒否、DNS解決後の全IPを検査（private/loopback/link-local/CGNAT/ULA/IPv4-mapped/169.254.169.254）、リダイレクトは手動で各ホップ再検証（最大3）、10秒・2MB・HTML/textのみ、1ページのみ（クロールしない） | テスト27 |
| Upload | マジックバイトで MIME 判定（宣言MIMEを信用しない）、種別ごとのサイズ上限、ストレージキーはサーバー生成、ファイル名はメタデータのみ | |
| Signed URL | HMAC-SHA256（鍵 = SECRET_KEY 派生）+ 15分有効、timingSafeEqual | |
| CSV injection | `= + - @ \t \r` 先頭のセルに `'` を付与 | テスト28, E2E-2 |
| ZIP | 絶対パス・ドライブ文字・`..`・NUL を拒否（展開前に検査）、エントリ数/総サイズ上限（zip bomb） | テスト29 |
| OAuth token | AES-256-GCM 暗号化保存、応答・ログ・バックアップに含めない、revoke 対応 | テスト25, 26 |
| Secrets | API キーは環境変数のみ。本番は `NETAMEGURI_SECRET_KEY` 未設定で起動失敗 | |
| ログ | Fastify logger で cookie/authorization/csrf を redact。本文はログに出さない | |
| 監査 | Brand変更・禁止語変更・承認・公開・予約・Connector・Campaign・Claim verified・設定変更・Backup/Restore・Import | |
| E2E用フック | `/api/test/*` は `NETAMEGURI_TEST_MODE=1` かつ非本番のみ登録 | |

## 既知の制限 / 今後
- パスワードリセット・MFA・SSO は未実装（Pro候補: team SSO）。
- レート制限はプロセス内メモリ（複数インスタンス時は共有ストアが必要）。
- 本番デプロイ時は TLS 終端（reverse proxy）と `trustProxy` 設定の確認が必要。
- 依存パッケージの脆弱性監査（`npm audit`）はリリース前チェックに含める。
