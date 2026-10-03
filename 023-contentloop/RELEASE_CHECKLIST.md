# RELEASE_CHECKLIST（販売前チェック）

凡例: [x] 済（このリポジトリで検証）／[ ] 人間の作業・承認が必要

## 自動テスト
- [x] `npm run typecheck`
- [x] `npm test` 必須テスト 1–34 + 追加
- [x] `npm run test:e2e` E2E-1〜9 + レスポンシブ（Chromium エミュレーション）
- [x] `SCALE=1 npm run perf`（TEST_REPORT.md）
- [ ] `npm audit` の確認と依存更新

## 人間の確認・承認が必要（自動で実施していないもの）
- [ ] **名称/商標**: 「ContentLoop」類似名称あり（SOURCE_NOTES §7）。商標データベース調査・法務判断。問題があれば候補名を人間が決定
- [ ] **実機確認**: iPhone（Safari / ホーム画面追加）、Android（Chrome / 共有ターゲット）、iPad、PC（Chrome/Edge/Safari/Firefox）
- [ ] **実SNS Connector**: 各Platformの開発者登録・App Review/audit・scope申請・料金確認 → 実アカウントでの接続・投稿・削除テスト（実投稿は人間承認のうえで）
- [ ] **WordPress adapter** を実サイトで検証
- [ ] **外部AI**: APIキー設定・実呼び出しでの品質/コスト確認（本ビルドはフェイクproviderでのみ検証）
- [ ] **文字起こし provider** の実API検証
- [ ] Platform Profile の文字数・仕様を各公式docsで再確認（PLATFORM_PROFILES.md `verifiedAt`）
- [ ] SOURCE_NOTES.md の [S]（検索抜粋）項目を全文で再確認
- [ ] 本番デプロイ先の選定・契約（有料契約は人間が判断）、TLS、ドメイン
- [ ] `CONTENTLOOP_SECRET_KEY` 生成・保管、`CONTENTLOOP_SANDBOX=0`、`CONTENTLOOP_SEED_DEMO=0`
- [ ] バックアップ（DB + objects）の定期実行と復元訓練
- [ ] 利用規約・プライバシーポリシー（外部AIへの送信、保存期間、削除手順）を法務確認
- [ ] 第三者ライセンス表記（docs/buyer/THIRD_PARTY_NOTICES.txt）の最終確認
- [ ] 価格表・販売ページの表現確認（成果保証表現がないこと）

## 機能の最終確認（手動）
- [ ] サンプルWorkspaceで「素材→Pack→レビュー→承認→手動投稿→反応記録→再利用」を一周
- [ ] AI OFF で全画面が動作し外部送信がないこと（設定 → AI）
- [ ] オフライン: Quick Capture / Draft編集 → 再接続で同期、競合時は上書きされないこと
- [ ] Claim 更新で古い値の Content が再レビューになること
