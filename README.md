# NetaMeguri — コンテンツを育て直すSNS運用ツール

動画・記事・音声などの素材から投稿案を整理し、ネタの重複確認、レビュー、運用結果と再利用につなげるツールです。

> **実装ブランチ：`claude/merge-sns-tools`**。この既定ブランチのREADMEは製品の案内です。以下のソース・資料リンクと起動手順は、実装ブランチを参照します。

## できること

- 素材・Brand Voice・Idea・SNS別Content Packの管理
- 投稿案のレビュー・予定・エクスポート・反応の取込と再利用候補
- 統合済みのSNS納品パックと、辞書による表記ゆれチェック

## 現在の範囲・制限

- 外部AI・文字起こし・SNS connectorは設定と対応範囲の確認が必要です。予約管理が全SNSへの実投稿を保証するものではありません。
- 納品パックの並べ替えUI等は仕上げが残っています。スマートフォン実機・実APIの品質とコストは未検証項目があります。

## 実装の見どころ

**構成：** React / TypeScript / Vite、Node.js、SQLite、PWA、MCP。

- [023-netameguri/server/src](https://github.com/Atsushi-Odajima/NetaMeguri_hb/tree/claude%2Fmerge-sns-tools/023-netameguri/server/src)
- [023-netameguri/web/src](https://github.com/Atsushi-Odajima/NetaMeguri_hb/tree/claude%2Fmerge-sns-tools/023-netameguri/web/src)
- [023-netameguri/MERGED_TOOLS.md](https://github.com/Atsushi-Odajima/NetaMeguri_hb/blob/claude%2Fmerge-sns-tools/023-netameguri/MERGED_TOOLS.md)

## ローカルで試す

Node.js 22.13以上。初期サンプルは開発環境用です。実データを使わず専用ディレクトリで試してください。

実装ブランチを取得し、次のディレクトリで作業します。

```sh
git clone --branch claude/merge-sns-tools https://github.com/Atsushi-Odajima/NetaMeguri_hb.git
cd NetaMeguri_hb/023-netameguri
npm install
npm run dev
```

環境設定・初期化の詳細：[セットアップ手順](https://github.com/Atsushi-Odajima/NetaMeguri_hb/blob/claude%2Fmerge-sns-tools/023-netameguri/DEVELOPMENT.md)。

## 検証方法

`023-netameguri/` の `package.json` に定義された主な確認コマンドです。DB・ブラウザ・外部ツールを要するものは、開発手順の事前設定が必要です。

```sh
npm run typecheck
npm run test
npm run test:e2e
npm run build
```

試験の実施環境・結果・未実施項目は、下記の記録を参照してください。画面エミュレーションと実機確認、モックと外部サービスでの確認を区別しています。

## 資料

- [023-netameguri/DEVELOPMENT.md](https://github.com/Atsushi-Odajima/NetaMeguri_hb/blob/claude%2Fmerge-sns-tools/023-netameguri/DEVELOPMENT.md)
- [023-netameguri/NEXT_STEPS.txt](https://github.com/Atsushi-Odajima/NetaMeguri_hb/blob/claude%2Fmerge-sns-tools/023-netameguri/NEXT_STEPS.txt)
- [023-netameguri/README.md](https://github.com/Atsushi-Odajima/NetaMeguri_hb/blob/claude%2Fmerge-sns-tools/023-netameguri/README.md)
- [023-netameguri/TEST_REPORT.md](https://github.com/Atsushi-Odajima/NetaMeguri_hb/blob/claude%2Fmerge-sns-tools/023-netameguri/TEST_REPORT.md)
- [023-netameguri/RELEASE_CHECKLIST.md](https://github.com/Atsushi-Odajima/NetaMeguri_hb/blob/claude%2Fmerge-sns-tools/023-netameguri/RELEASE_CHECKLIST.md)
- [023-netameguri/DATA_MODEL.md](https://github.com/Atsushi-Odajima/NetaMeguri_hb/blob/claude%2Fmerge-sns-tools/023-netameguri/DATA_MODEL.md)
- [023-netameguri/DECISIONS.md](https://github.com/Atsushi-Odajima/NetaMeguri_hb/blob/claude%2Fmerge-sns-tools/023-netameguri/DECISIONS.md)
- [023-netameguri/SECURITY.md](https://github.com/Atsushi-Odajima/NetaMeguri_hb/blob/claude%2Fmerge-sns-tools/023-netameguri/SECURITY.md)
- [023-netameguri/OPERATIONS.md](https://github.com/Atsushi-Odajima/NetaMeguri_hb/blob/claude%2Fmerge-sns-tools/023-netameguri/OPERATIONS.md)
- [画面資料](https://github.com/Atsushi-Odajima/NetaMeguri_hb/tree/claude%2Fmerge-sns-tools/023-netameguri/docs/screenshots)

## 制作・利用条件

制作・管理：**Atsushi Odajima**。実装・資料作成にはAI支援を利用しています。
ソース・同梱ライブラリ・フォント・モデル等の利用条件は、各ライセンスと第三者表記を参照してください。リポジトリの閲覧可能性と、再配布・商用利用の許諾は別です。
