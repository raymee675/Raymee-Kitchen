# リセット機能 計画

作成日：2026年10月4日　｜　状態：実装・独立レビュー済み。型確認、PC/Pagesビルド、差分チェック成功。テスト未実行。オフライン用アプリキャッシュは保持（ユーザー確認済み）

## 目的・期待動作

調理データを明示確認のあと初期状態へ戻す。上部操作欄に「リセット」ボタンを置き、1回目の押下で「初期化を確定」と「キャンセル」を表示する。確定前に対象データを説明し、キャンセルすれば保存状態を変更しない。確定後は盤面・完成ボックス・実行記録・取り消し履歴を空にし、次のお好み焼きIDを1-1から割り当てる。

- PC版は共有SQLite上の盤面を初期化し、接続中の全画面に反映する。
- Pages版はそのブラウザーの調理データ保存キーを空の初期盤面で置き換える。
- 初期化は一つの保存操作として反映する。PC版ではSQLiteトランザクションに含め、同じ操作IDの再送で二重に初期化しない。
- 古い画面やリセット前に送信待ちになった操作が、ID再利用後の新しいお好み焼きを誤操作しないよう、盤面generationを導入してリセット前後を区別する。
- PagesのService Worker CacheStorageは画面ファイルをオフライン用に保持しており、調理データを保存しない。初期化後もオフライン起動できるよう保持する。初期化対象と確認文でいう「キャッシュ」は調理状態の保存領域を指す。

2026-10-04にユーザーは「調理データのみ（推奨）」を選択。PagesのService Worker CacheStorageは削除対象に含めない。

## コード調査で確認した現状・制約

- 共通UIは **cooking-app/app/kitchen.tsx** のKitchenView。PC版・Pages版のどちらもここに書き出し・Undo等の上部操作があり、現在リセットUIはない。二段階確認は同じ画面上の明示ボタンとキャンセルで実装できる。
- PC版は **cooking-app/server/storage.mjs** のboards.state JSONにitems、records、completionItems、nextPancakeOrdinal、undoHistoryを保存する。revisionは別列で管理される。変更はBEGIN IMMEDIATEのSQLiteトランザクション内で適用され、operationIdのreceiptによって再送を一度だけにする。
- **cooking-app/server/index.mjs** の/api/boardは登録済み端末またはlocalhostだけを許可し、POSTは同一OriginとJSONを要求する。盤面リセットもこの認証・Origin確認を通す。端末、登録コード、操作receipt等の管理テーブルは盤面とは別である。
- PC画面は/api/boardを約700ms間隔で再取得する。API応答と変更の競合を守るには、リセットも通常盤面変更同様にrevisionを増やし、即時応答の空Snapshotをフロントへ返す必要がある。
- Pages版は **cooking-app/lib/local-kitchen-storage.ts** のteppan-timer:<path segment>:single-phone-board:v1に調理状態を保存し、現在schemaVersion 5。共有SQLite/APIは使わない。同一キー由来のWeb Locksで複数画面の同時編集を止め、操作は直列キューで実行する。
- Pagesのオフライン画面は **cooking-app/vite.pages.config.ts** が生成するService Workerで管理され、teppan-shell-<scope hash>-<build hash>のCacheStorageへアプリファイルを保存する。**cooking-app/lib/use-kitchen-local.ts** はそのworkerを登録する。これは盤面データとは別物であり、消すと次回のオフライン起動を壊す可能性がある。
- PC版に盤面用localStorageやService Workerはなく、ブラウザーのJS/CSS HTTPキャッシュとサーバーSQLiteは別物。HTMLはno-store、静的アセットは最大1時間キャッシュされる。汎用ブラウザーキャッシュを消すと他サイト・ログイン等にも影響し、今回の調理データ初期化には不要。
- 既存の連番IDはnextPancakeOrdinalから払い出され、作成後に高水位を更新する。初期化時にこの値を初期値へ戻すとIDを再利用することになる。PCは複数端末から共有するため、revisionだけでは同じID・versionへ届く古い操作を判別できない。

## 状態リセットと古い画面対策

保存された調理状態にgeneration（盤面世代）を追加する。既存保存データと既存DBには0として補い、リセット成功ごとに1増やす。新しいUIはSnapshotのgenerationを各変更コマンドに含め、モデルとPCサーバーは現在generationと一致する場合だけ操作を適用する。リセット自身も現在generationを照合する。世代が合わない要求はデータ変更なしのconflictとして最新Snapshot取得を促す。

旧クライアントとの互換ではgenerationが未指定でも既存generation 0の間だけ通常操作を受け付ける。最初のリセット後は世代なしの旧画面操作を拒否する。これで機能導入後に開きっぱなしの旧画面がIDを再利用した新盤面を誤操作できない。PagesはWeb Lockとstorage eventにより単一画面制約を保ち、リセット後はrevision・generation付きの空状態を保存し直す。

Pagesの保存schemaVersionは5から6へ更新し、version 1〜5の読込では既存データを保持してgeneration=0を補う。PCの盤面JSONにもgenerationを保存し、旧JSONでは0として読む。operations、devices、enrollment_codes、認証Cookie、ユーザー設定、Service Worker登録・アプリshell cache、SQLiteバックアップはリセット対象にしない。

## 影響ファイルと担当範囲

**GPT-6 Luna実装worker（保存契約・PC経路）**

1. **cooking-app/lib/kitchen-model.ts**：Snapshot/保存データ/Commandにgenerationを追加し、世代一致検証、reset遷移、空状態への正規化、連番初期値への戻しを実装。旧保存形式の既定世代0と旧画面コマンドの受け入れ境界を維持する。
2. **cooking-app/server/storage.mjs**：SQLite盤面JSONへのgeneration保存と旧形式からの移行、revisionを1増やし空状態へ置き換えるトランザクション操作、operationId再送の冪等性を追加する。DB全体や操作receipt表を削除しない。
3. **cooking-app/server/index.mjs**：既存認証・同一Origin保護の/api/board POST経路からresetを受け付ける。新しい未認証・管理者回避経路を設けない。必要な応答はno-storeの空Snapshotとする。
4. **cooking-app/server/restore.mjs**：DBバックアップの盤面状態検査でgenerationも共通正規化へ渡す。古いバックアップでgenerationがない場合は0を補い、不正な世代値は復元前検査で拒否する。

**GPT-6 Luna実装worker（Pages保存・UI）**

5. **cooking-app/lib/local-kitchen-storage.ts**：schemaVersion 6、version 1〜5の互換読込、generationの保存と初期盤面書込を追加する。localStorage全体のclearは使わず、アプリ専用キーだけを更新する。
6. **cooking-app/lib/use-kitchen-local.ts** と **cooking-app/lib/use-kitchen.ts**：新コマンドの送信にSnapshot generationを含める。Pagesのresetを既存直列キューに入れ、revision・generationを進めて空状態を保存・公開する。PCはサーバーのreset応答を通常応答と同様に受理する。古いgenerationのconflictでは自動的に最新Snapshotへ同期する。
7. **cooking-app/app/kitchen.tsx** と **cooking-app/app/globals.css**：1回目のリセット押下で確認ボタンとキャンセルを見せる。確定時は送信中/接続不可の状態を正しく無効化し、実行記録・調理中・完成ボックスを消しIDが1-1から始まること、PC版は全端末の共有データが消えることを明記する。成功時は空盤面を即時表示し、失敗時は確認UIを残して通知する。
8. **cooking-app/README.md**：リセット範囲とPC共有/Pages端末内の違いを説明する。

2担当は共通Command/Snapshot契約のgenerationフィールド名・旧値規則を最初にすり合わせ、model/APIを先に確定してからUIとPagesを接続する。同じファイルを並行編集しない。**Sol coordinator**は既存のID・Undo・完成ボックス・グリッドの未コミット変更を保全し、契約と全体diffを統合確認する。**実装者とは別のGPT-6 Luna reviewer**はデータ消去境界、トランザクション、冪等性、古い画面対策、Pages単一保存、確認UIをレビューする。

## 実装手順

1. generationをSnapshot/保存形式/Commandに導入し、既存データの既定値0を確立する。通常コマンドは世代一致を検証するが既存generation 0クライアントとの互換は維持する。
2. 共通モデルにreset遷移を追加する。active items、completionItems、records、undoHistoryを空配列にし、nextPancakeOrdinalを1へ戻し、generationを進める。
3. PCのSQLiteトランザクションにresetコマンドを追加し、revisionとgenerationを同時に進め、operation receiptも同じトランザクションで記録する。端末管理や履歴外のDBテーブルは触らない。
4. DBバックアップ検査で盤面generationを共通正規化へ渡し、generation欠落は旧形式として0にし、不正値は復元前に拒否する。
5. Pages localStorage schemaを6へ上げる。古いschemaを保持移行し、リセットは既存mutationQueue内でアプリ専用キーだけを空の初期Snapshotに置き換える。Service Worker shell cacheは保持する。
6. 共通UIにリセット→確認ボタン→キャンセルの二段階操作を追加し、通信・保存成功後に画面状態を切り替える。
7. READMEとヘルプ/確認文で対象範囲を説明し、実装者と分離したコードレビューを行う。

## 検証と受け入れ条件

- 1回目の押下で確認ボタンとキャンセルが表示され、確定ボタンを押すまで盤面・保存データが変わらない。キャンセルでは状態を一切変えない。
- 確定後、鉄板の全楕円、完成ボックス、全実行記録、Undo履歴が空になり、採番が1-1から始まる。調理中状態が初期化されるので、UIには対象の消去を明示する。
- PC版では初期化が共有SQLiteに一度だけ保存され、revisionが増える。再読込・接続中の他端末でも空盤面が表示される。DBを削除せず、登録済み端末・認証・登録コードは残る。
- バックアップ復元時はgenerationを検証し、旧世代フィールド欠落は0として扱い、不正な世代値のバックアップは適用しない。
- Pages版では当該サイト区画の専用localStorageキーだけを初期Snapshotへ置き換える。version 1〜5データをリセットなしで読み込んだときは既存状態を保持し、generation 0を追加する。
- 同じreset operationId再送は一回の遷移として扱う。異なるoperationIdをもつ二重クリック、古いexpectedGenerationによる遅延操作、旧画面から世代なしで来る操作は、ID再利用後の新規データを変更しない。
- 失敗応答・オフライン・未登録端末では初期化済みと表示せず、最新状態を保ってユーザーに失敗を知らせる。確定操作中に二重送信を防ぐ。
- Service Worker登録とteppan-shellのCacheStorageは残り、Pagesのオフライン起動能力を失わない。PCの一般HTTPアセットキャッシュ・DBバックアップ・認証情報も無関係なまま保たれる。
- 実装後は差分レビュー、git diff --check、TypeScript型確認、PC/Pagesビルド、保存形式とAPI経路の静的確認を行う。ユーザー依頼がないためテストの追加・実行はしない。

## リスク・未確定事項

- PC版ではどの登録済み端末にも同じリセット操作が出る。既存設計では全登録端末が盤面の編集権を持つため、その権限境界を維持する。認証済みユーザー間でリセット権限を絞る要件は現状の端末モデルにない。
- すべての調理記録も消去する。後からCSVを取る必要があれば、確定前に「記録を書き出す」ことを確認文に含める。別履歴に退避・保存はしない。
- リセット後はIDを再利用するためgeneration照合が必須。generationをコマンド全体へ適用しない実装では、複数PC端末の遅延コマンドが新しい同ID品に適用される可能性が残る。
- PagesのService Worker shell cacheは「調理データ」ではないため保持する（ユーザー確認済み）。
