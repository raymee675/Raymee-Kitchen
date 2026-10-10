# 実行記録CSVへの鉄板イベント時刻追加計画

作成日：2026年10月11日　｜　状態：実装済み

## 目的・期待動作

Pages版の実行記録CSVに、お好み焼きごとの「鉄板投入時刻」と「下段から上段への移動時刻」を追加する。値はローカル保存モデルが操作を受理した時刻（Unix epochミリ秒）とし、CSVでは既存日時列と同じ端末ローカル時刻 `YYYY-MM-DD HH:mm:ss` で出力する。

- 「鉄板投入時刻」は `create` が成功した時刻。`create` の拒否、または成功した配置のUndoでは記録されない。
- 「下段→上段移動時刻」は、下段から上段への `move` が全ての既存移動検証を通り、保存される時刻。移動のUndoは移動イベントを取り消して値を空に戻し、その後に再移動した場合は新しい成功時刻を記録する。
- CSVは従来どおり、回収済み・記録済みのお好み焼き1件につき1行。上下段移動をしなかった記録の移動時刻は空欄とする。

## 確認した現状と制約

- 現行の運用対象はPages版。画面の記録CSVは `cooking-app/lib/execution-record-export.ts` が `ExecutionRecord[]` から生成し、1件1行でダウンロードする。列追加後もBOM、CRLF、引用符、Excel向けID、ローカル日時を維持する。
- `cooking-app/lib/kitchen-model.ts` の `applySnapshotCommand(snapshot, command, now)` は、createでは `Pancake` を生成し、moveでは下段限定・同一鉄板・真上の空きマス等を検証してから更新する。現在の `Pancake` と `ExecutionRecord` に投入・上段移動の時刻はない。
- 完了記録は `collectRecord` が `Pancake` から作り、開始済み盤外削除も破棄記録として同じ `ExecutionRecord` にする。したがって2時刻を `Pancake` に保持し、回収・破棄時に `ExecutionRecord` へ引き継ぐ。未開始の盤外削除は現行仕様どおりCSV記録を作らない。
- PagesのlocalStorage schemaは8、JSONバックアップのformatVersionは1。正規化関数が旧形式の項目を読み込み、未知の記録フィールドをそのまま保つ保証はないため、旧データを明示して新しい時刻フィールドを補い、schemaを9へ進める必要がある。
- 既存の進行中楕円にも実際の投入時刻は保存されておらず、既存の実行記録にも移動履歴はない。開始時刻・温度区間・回収時刻から推定せず、取得不能の過去値は `null` としてCSV空欄にする。旧バックアップ形式自体は維持し、schema 1〜8を読み込めるようにする。

## 影響ファイルと担当

- **GPT-6 Luna実装worker（モデル・Pages保存・CSV・説明を一括担当）**：
  - `cooking-app/lib/kitchen-model.ts` — `Pancake` と `ExecutionRecord` の時刻フィールド、旧値の正規化、create/move時の記録、回収・破棄記録への引継ぎ、move Undo時の巻き戻し。
  - `cooking-app/lib/local-kitchen-storage.ts` — localStorage schemaを8から9へ移行し、旧保存値とformatVersion 1バックアップの互換性を維持。
  - `cooking-app/lib/execution-record-export.ts` — 2列と値を追加。既存CSV列は維持し、新列の位置と名称を固定する。
  - `cooking-app/app/kitchen.tsx`、`cooking-app/README.md`、`docs/execution-record-export-plan.md` — 操作説明、列一覧、過去値が空欄になる仕様を同期する。
  - `docs/README.md` — 本計画へのリンクを追加する。
- **Sol coordinator**：計画と差分の整合、非テスト検証結果、Pages-onlyの運用範囲を確認する。
- 独立コードレビューは行わない（AGENTS.mdのユーザー方針に従う）。

## 実装手順

1. モデル上の値を `griddlePlacedAt: number | null` と `movedToUpperAt: number | null` として保持する。create成功時のみ前者へ `now` を設定し、moveは検証完了後に下段→上段の成功時刻を後者へ設定する。既存の進行中楕円は両方を `null` で補う。
2. 通常回収と開始済み盤外破棄の `ExecutionRecord` に2値を引き継ぐ。新しいレコードのnull許可条件と型検証を追加する。既存レコードでフィールドが欠けていれば両方を `null` とする。
3. 最新moveのUndoでは当該移動時刻をクリアし、UndoEntryと既存履歴の正規化・保存に互換性を持たせる。delete Undoは元 `Pancake` の時刻を維持する。
4. localStorage schemaを9へ上げる。schema 1〜8を読み込んで新フィールドを補い、schema 9は正規化後の新shapeとして保存する。JSONバックアップformatVersion 1は変えず、旧schemaを含むバックアップの読み込みを保つ。
5. CSVへ「鉄板投入時刻」「下段→上段移動時刻」を追加し、両方とも取得できる時刻だけ既存 `localTimestamp` で出力する。既存列の順序と値、対象行数、CSV形式は保つ。画面ヘルプ、README、書き出し計画、docs索引を更新する。
6. typecheck、Pages build、`git diff --check`を実施し、変更範囲がPages保存・モデル・CSV・その利用者向け説明に収まることを確認する。

## 受け入れ条件・検証

- 新規配置を受理した時刻が楕円に保存され、通常回収と開始済み盤外破棄のCSV行へ引き継がれる。
- 失敗した配置・失敗した移動で時刻が作られない。成功した下段→上段移動の時刻だけが保存され、移動せず回収した場合はCSVを空欄にする。
- move Undoでは移動時刻が消え、再度成功したmoveでは新しい時刻になる。削除Undoでは投入・移動時刻が保持される。
- schema 1〜8のlocalStorageおよび既存formatVersion 1 JSONバックアップがデータを失わず読み込める。既存の進行中楕円・既存ExecutionRecordで取得不能な時刻はnullのままになる。
- CSVは既存1記録1行と各既存列の意味を維持し、新2列の値と空欄が正しく出る。すでに利用者がダウンロードしたCSVは変更されない。
- ユーザー方針に従い、新規テストの追加・テストスイート実行は行わない。型確認、Pages build、差分の空白確認のみを実施し、実施した検証を報告する。

## リスク・未決事項

- 旧データにはイベント時刻の根拠がない。推測値を出すと実測の記録と誤認されるため、空欄にする。このため同一CSV内に時刻あり・空欄の行が併存する。
- moveはUndo可能な操作であるため、Undo後にも移動時刻を残すと現状態と記録が食い違う。本計画ではUndoを移動イベントの取消しとして扱い、時刻をクリアする。
- 予定する見出しは「鉄板投入時刻」「下段→上段移動時刻」。列位置は既存の「タイマー開始時刻」の前に2列を追加し、他の既存列を右へずらす。既存ヘッダー文字列・データ意味は変えない。

## 実装記録（2026年10月11日）

- `Pancake`に2時刻を保持し、配置と検証済みの下段→上段移動の成功時刻を保存する。移動Undoでは移動時刻を消し、通常回収・開始済み盤外破棄の実行記録へ2時刻を引き継ぐ。
- localStorage schemaを9へ更新した。schema 1〜8とJSONバックアップformatVersion 1を引き続き読み込み、旧データで判定できない時刻はnullとして扱う。
- CSVに「鉄板投入時刻」「下段→上段移動時刻」をタイマー開始時刻の前へ追加した。利用者向けヘルプとREADME、および旧書き出し計画の現行Pages版補足も更新した。
- `pnpm run typecheck`、`pnpm run build:pages`、`git diff --check`は成功。AGENTS.mdの方針に従ってテストは追加・実行していない。独立コードレビューも実施していない。
