# MERGED_TOOLS — 単体ツールからの統合機能

単体販売ツール2本の機能を NetaMeguri に統合した記録です（2026-10-07）。名称ルール: 製品名のない統合機能は本体名を付けて **NetaMeguri 納品パック** / **NetaMeguri 表記ゆれチェック** と呼びます。

| 統合機能 | 元ツール（読み取りのみ・変更なし） | 元コミット |
|---|---|---|
| NetaMeguri 納品パック | SNS納品パックメーカー（`hanbai1/sns-nohin-pack-maker/app/export.js`, `zip.js`, `main.js`） | `01aee17` |
| NetaMeguri 表記ゆれチェック | 表記ゆれチェッカー #007（`hanbai7/007-notation-checker/js/core.js`） | `2d2c74d` |

## 1. NetaMeguri 納品パック

選択した投稿 / Content Pack / Campaign を、クライアント納品用ZIPにまとめます。

### ZIP構成（元ツールと同一）
```
SNS納品パック_YYYY-MM-DD/          ← 作成日（Workspaceのタイムゾーン）
  001/                             ← 投稿番号（3桁、並び順から自動採番）
    001_01.jpg … 001_10.png        ← 画像（投稿番号_画像番号2桁.拡張子）元バイナリをそのまま格納
    投稿文.txt                      ← UTF-8 BOM付き / CRLF
  002/ …
  投稿一覧.csv                      ← UTF-8 BOM付き / CRLF / 全セル引用符 / 数式インジェクション対策
  確認用一覧.html                   ← CSSインライン・JSなし・画像は相対パス
```
- 投稿文.txt の書式（投稿番号／投稿日 YYYY/MM/DD／投稿時間／管理タイトル／画像／【投稿本文】）、CSV列、確認用一覧.html（CSS含む）は `export.js` を移植。
- ZIP: 無圧縮（STORE）、ファイル名 UTF-8（汎用フラグ bit11）＋ Info-ZIP Unicode Path（0x7075）。元ツールは自作ライタ、NetaMeguri は既存依存の **fflate** を使用（新規依存なし）。
- 画像: JPG / PNG / WEBP のみ、1投稿10枚まで。拡張子は「元のファイル名の拡張子（小文字化）を維持、中身と食い違う場合だけ中身に合わせる」（`imageExt`）。
- 内部情報の除外: `toDeliveryRecord()` のホワイトリスト（番号・日付・時間・タイトル・本文・画像）だけが出力されます。コメント・レビュー履歴・AI提案・structured・Claim 等は含まれません（テストでZIP全体を検査）。

### NetaMeguri側の対応付け
| 元ツールの項目 | NetaMeguri |
|---|---|
| 投稿日・投稿時間 | `scheduled_at`（なければ `published_at`）を Workspace タイムゾーンで表示。未設定なら「（未設定）」 |
| 管理タイトル | ContentItem の title。空なら「Threads（通常投稿）」のように Platform＋形式 |
| 本文 | ContentItem の body（改行は CRLF 化） |
| 画像 | その ContentItem に紐づく image メディア（`media_assets.content_id`）。順序は mediaRefs → アップロード順 |
| 内部メモ | コメント等（出力しない） |
| 並び順 | 投稿選択: 画面の並び（予定日時順）／ Pack・Campaign: 予定日時順（アーカイブ除外） |

### API / 画面
- `POST /api/w/:wid/delivery-pack/preview`（`contentIds[]` / `packId` / `campaignId` のどれか1つ）→ 投稿ごとの番号・日付・画像数・警告（投稿日未入力／本文未入力／画像未登録／11枚目以降／非対応形式）
- `GET /api/w/:wid/delivery-pack.zip?contentIds=a,b | packId= | campaignId=` → ZIP（`Content-Disposition` に `filename*=UTF-8''SNS納品パック_….zip`）
- `POST /api/w/:wid/content/:id/media/:mid/detach` → 画像を投稿から外す（実体は残す）
- 権限: `export`（owner/admin/editor）。テナント外の ID は 404。監査ログ `delivery_pack.exported`（件数のみ、本文なし）。
- 画面: 左メニュー［納品パック］(`/delivery`)、Content Pack 詳細・キャンペーン詳細の［納品パック］ボタン、投稿編集画面の「画像」カード（追加・外す・この投稿だけZIP）。

## 2. NetaMeguri 表記ゆれチェック

Workspace 共通の表記ゆれ辞書（正しい表記＋別表記）で下書きを検査し、個別置換・一括置換・無視ができます。

### 照合ロジック（`server/src/lib/notation.ts` = `core.js` の忠実な移植）
- **Unicode 正規化は行わない**（NFC/NFKC なし）。全角/半角・異体字は登録文字列とコードポイント一致した場合のみ検出。
- 大文字小文字を区別しない設定は JS 正規表現 `iu`（単純ケースフォールディング）。
- 単語一致: 別表記の先頭/末尾が ASCII 英数字・`_` の側だけ `(?<![A-Za-z0-9_])` / `(?![A-Za-z0-9_])` を付与。日本語・記号・空白は区切り扱い。`\b` は使わない。
- 正しい表記そのもの、および同じ行の正しい表記の出現範囲に含まれる一致は検出しない。
- 重なりは開始位置昇順・長さ降順で貪欲に採用（長い別表記を優先）。同一範囲に複数ルール → 競合。
- 競合（同じ別表記が別の正しい表記へ／別表記が他ルールの正しい表記）は検出するが置換不可。
- 置換は「現在の本文で該当位置が検出時の文字列と一致する場合のみ」。同じ行の後続ヒットは文字数差分だけずらす。
- 辞書JSONは元ツールと同じ schema（`schemaVersion: 1`, `app: "notation-checker"`）。相互に読み書きでき、読み込みは全件検証→成功時のみ置き換え（失敗時は現在の辞書のまま）。

### NetaMeguri側の対応付け
- 辞書は Workspace に1つ（テーブル `notation_dictionaries`、ルール配列をJSONで保持）。バックアップ/復元に含まれます。
- 検査対象は ContentItem の本文（タイトルは対象外）。元ツールの TXT と同じ「行」単位。
- 置換は `updateContent` 経由で **新しい版** として保存（履歴から戻せる）。承認済み・予約済みの投稿を置換すると、既存ルールどおり再レビュー（予約ジョブ取消）になります。`expectedVersion` で同時編集を検出。
- 「無視」は元ツール同様、画面を開いている間だけ保持（キー `行:開始位置:検出文字列` をクライアントが保持し、置換で位置がずれたら API が返す新しい位置で更新）。

### API / 画面
| メソッド | パス | 権限 |
|---|---|---|
| GET | `/notation/dictionary` | read |
| PATCH | `/notation/dictionary`（name） | manage_brand |
| POST / PATCH / DELETE | `/notation/rules`, `/notation/rules/:ruleId` | manage_brand |
| POST | `/notation/import`（`{ json }`） | manage_brand |
| GET | `/notation/export.json` | export |
| GET | `/notation/scan` | read |
| POST | `/notation/check`（任意テキスト） | read |
| POST | `/content/:id/notation/check`（`ignoredKeys`） | read |
| POST | `/content/:id/notation/replace`（`mode: one｜group`, `key` / `matched`+`correct`, `ignoredKeys`, `expectedVersion`） | write |

- 辞書の編集は Brand Voice と同じ `manage_brand`（owner/admin）。表記ルールはブランド方針のため。
- 画面: 左メニュー［表記ゆれチェック］(`/notation`: 辞書・追加・JSON読込/書出・下書きスキャン)、投稿編集画面の［表記ゆれ］タブ（`/content/:id?tab=notation`）。

## 3. 統合しなかったもの（理由）
| 元ツールの機能 | 理由 |
|---|---|
| 納品パック: ブラウザ内 IndexedDB 自動保存・D&D・並べ替えボタン・離脱警告 | NetaMeguri はサーバー保存・版管理があるため不要。投稿の並びは予定日時順（投稿選択時は画面の並び） |
| 納品パック: 画像の並べ替え UI | API は mediaRefs 順に対応済み。UI は「外す→追加し直す」のみ（デザイン調整時に追加予定） |
| 納品パック: HEIC 等の案内ダイアログ | NetaMeguri のアップロード検証（マジックバイト）で拒否済み。GIF は保存できるが納品パックには含めない（元ツールと同じく JPG/PNG/WEBP のみ） |
| 表記ゆれ: TXT/SRT ファイル読込・文字コード判定（Shift_JIS 等）・`_checked` ファイル保存・結果CSV | 統合先の対象は下書き本文（DB内テキスト）。SRT は NetaMeguri の Transcript 機能側で扱う。必要なら `/notation/check` に貼り付けで検査可能（API のみ） |
| 表記ゆれ: サンプル辞書の内蔵 | 一般的な正解辞書と誤解されやすいため同梱しない（元ツールの sample_dictionary.json は［辞書JSONを読み込む］で取り込める） |
| MCP ツール | 今回は Web/API のみ。MCP からの利用は今後の候補 |
