# MCP_PLUGIN — ChatGPT / Claude / Codex 連携の土台

実装: `server/src/mcp/tools.ts`（transport非依存）、`server/src/mcp/stdio.ts`（stdio）。SDK: `@modelcontextprotocol/sdk` 1.x。
仕様状況（SOURCE_NOTES.md §4, 2026-10-02）: MCP 最新仕様 2026-07-28（stateless化）。ChatGPT の full MCP（write系）は Business/Enterprise/Edu で beta、Pro は read/fetch のみ、Web のみ。**ChatGPT への公開・ディレクトリ掲載条件は未確認**。本ビルドは stdio のみで、Remote（HTTP）transport と OAuth は未実装（NEXT_STEPS）。

## セットアップ（Claude Code / Codex 等の stdio 対応クライアント）
```bash
claude mcp add netameguri \
  -e NETAMEGURI_DATA_DIR=/path/to/data \
  -e NETAMEGURI_MCP_USER=you@example.com \
  -e NETAMEGURI_MCP_WORKSPACE=ws_xxxxxxxx \
  -- npx tsx /path/to/023-netameguri/server/src/mcp/stdio.ts
```
MCPサーバーは指定ユーザーとして、そのユーザーの RBAC 権限で動作します（`via=mcp` として監査ログに記録）。

## Tools
| tool | 種別 | 内容 |
|---|---|---|
| capture_source | write | テキスト/URLをSource化（URLは1ページのみ・SSRF対策） |
| create_content_pack | write | Pack作成（投稿しない） |
| find_unused_ideas | read | 未使用/再利用可能Idea（platform指定可）+ 最近使用 |
| check_idea_similarity | read | 類似候補（断定しない） |
| draft_for_platform | write | Draft作成 + チェック結果 |
| get_campaign | read | Campaign + Guard |
| review_draft | read | Draft + チェック結果 |
| get_recycling_candidates | read | 再利用候補 |
| search_content | read | 横断検索（citation付き） |
| get_performance_summary | read | Platform別要約（合算なし）+ 傾向 |
| prepare_publish | read | プレビュー・チェック・Capability・blockers。条件を満たす時だけ確認コードを発行 |
| confirm_publish | destructive | 確認コード + `userApproved: true` + 設定許可 + Approved + 外部投稿権限 + 本文ハッシュ一致 で投稿 |

## 外部publishの安全設計（テスト34, E2E-7）
1. `prepare_publish` は投稿しない。Approved でない／block あり／Capability に PUBLISH がない／Workspace設定「MCPからの投稿を許可」がOFF／権限なし → 確認コードを出さず、handoff（コピー用テキスト・SNSのURL）を返す。
2. 確認コードは1回限り・10分・作成時の版と本文ハッシュに束縛。
3. `confirm_publish` は `userApproved: true`（リテラル）必須。クライアント側でユーザーに本文を見せて明示承認を取る想定（tool description に明記）。
4. Claim の verified 化は MCP から不可。

## 例（仕様 §40）
User「今日Threadsに何か投稿したい」→ `find_unused_ideas{platform:"threads",limit:3}` → 3案提示 → User「2番」→ `draft_for_platform` → チェック結果を提示 → `prepare_publish` → PUBLISH 可能なら確認後 `confirm_publish`、不可なら handoff テキストで手動投稿。
