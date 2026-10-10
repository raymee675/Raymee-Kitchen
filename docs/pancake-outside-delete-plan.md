# 鉄板外への長押しドラッグ削除とID再採番計画

作成日：2026年10月11日　｜　状態：実装済み。ID分離とCSVの適用範囲は利用者確認済み。

## 目的と確定した要件

- 鉄板上のお好み焼き本体を長押しして鉄板領域の外へドラッグし、外で離すとそのお好み焼きを削除する。2枚の鉄板の隙間を含め、ポインターが両方の鉄板領域外で離れた場合を盤外削除とする。鉄板上で離した場合は移動も削除もせず、保存済み位置へ戻す。
- 直前の削除は「操作を取り消す」で元の楕円として復元できる。
- 削除・Undo・配置Undoのどれでも、利用者に見せるIDに欠番を残さない。削除で後続のお好み焼きの表示IDが詰まり、Undoで戻すと再び並び直す。
- 再採番は盤面と今後書き出すCSVに適用する。すでに端末へダウンロードされたCSVは変更できないため、そのIDは旧値のまま残る。
- 現行の運用対象はPages版。画面と共有モデルの必要な互換性は保つが、PC runtime/APIをサポート構成へ戻さない。

## 実装前に確認した現状

- `cooking-app/app/kitchen.tsx`の各鉄板SVGはPointer Eventsとpointer captureを使う。450msの長押しは通常タップを抑止するだけで、現在はドラッグ削除しない。盤外pointer releaseはキャンセルである。
- `cooking-app/lib/kitchen-model.ts`の`Command`、`parseCommand`、`applySnapshotCommand`が共通状態遷移を持つ。通常の`delete` commandは拒否される一方、保存済み`UndoEntry.delete`の読込と復元分岐は互換のため残っている。盤外破棄記録の`PLATE_DISCARD_REASON`も過去データに存在する。
- 実行記録のvalidatorは`startedAt`と`collectedAt`、連続した温度区間、開始済み記録の`cookCompletedAt === startedAt + 90秒`を必須にする。破棄recordでは`serveTimerStartedAt`・`serveDeadlineAt`・`servedAt`がnull、`unavailableAt`が非null、`unavailableReason === PLATE_DISCARD_REASON`を必須にする。破棄分岐は`unavailableAt >= cookCompletedAt`を要求しないため、調理途中の楕円も破棄時刻でopen区間を閉じて有効な記録にできる。未開始楕円は`startedAt=null`かつ温度区間なしなので実行記録を作れない。
- 現在のM-N IDは、React上のkey、操作対象、完成ボックス・実行記録間の参照、生地タイマーの`placedIds`、CSVのID列を兼ねている。`nextPancakeOrdinal`は採番の高水位であり、通常削除では戻さない。IDの最大数は192 (`1-1`〜`8-24`)。
- 生地タイマーschema 7では、`firstPancakeOrdinal`、連続するM-N `placedIds`、`nextPancakeOrdinal`の整合性を検証する。消費数は配置成功時に確定し、既存セット開始のID境界と192個上限を使う。表示番号を変更しても、この配置・バッチ履歴は変わらないようにする必要がある。
- Pages localStorageは`LOCAL_BOARD_SCHEMA = 7`、JSONバックアップはformatVersion 1でschemaを内包する。保存は`use-kitchen-local.ts`のWeb LocksとmutationQueueで直列化される。CSVは`cooking-app/lib/execution-record-export.ts`が記録IDを出力する。

## IDモデル

お好み焼きの中身と履歴をIDの付け替えに巻き込まないため、保存上の内部IDと利用者向け番号を分離する。

| フィールド | 意味と用途 |
| --- | --- |
| `entityKey` | 新規entityではUUIDを使う不変の内部識別子。React key、盤面・実行記録・完成ボックス・Undoの関連付けに使う。削除・再採番では変更しない。外部の操作コマンドには公開IDを渡し、現行の`expectedGeneration`と`expectedVersion`を検証した後、モデル内で対象のentityKeyへ原子的に解決する。 |
| `creationOrdinal` | entityごとに一度だけ割り当てる不変の作成順。密な表示IDの並べ替えと履歴のentity対応に使う。 |
| `nextCreationOrdinal` | `creationOrdinal`用の単調な割当高水位。通常の削除・削除Undo・表示IDの詰め直しでは変えない。新規createで進める。安全な最新create Undoだけは、対象entityと後続参照を完全に除去できる時に限り一つ戻せる。 |
| `nextPancakeOrdinal` | 既存M-N配置順と生地タイマーの24個区切りに使う互換用高水位。表示IDとは独立する。削除・削除Undoでは変えず、成功した配置と既存条件を満たす最新create Undoだけが進退させる。 |
| `id` | `1-1`〜`8-24`形式の利用者向け表示・CSV ID。現在保存されている対象エンティティを`creationOrdinal`順に並べて密な番号へ割り当て、削除やUndo後に再計算する。 |

`items`、`completionItems`、`records`は同一のお好み焼きをentityKeyで共有する。表示IDを再計算する集合は、これらに現存する一意なエンティティの和集合とし、一つのエンティティは1つの番号だけを占める。これにより盤面と将来のCSVが同じ現在番号を使い、記録のID関連も保てる。削除で楕円も破棄記録も残らないエンティティは番号集合から外れ、後続表示番号が詰まる。削除時に既存の盤外破棄記録を残すケースは同じentityKeyの記録が番号集合に残り、CSVでも追跡できる。

`doughBatch`はUIの表示IDでなくentityKeyを配置履歴に保存する。配置成功時に`placedEntityKeys`末尾へ追加し、表示IDの再計算ではこの配列を変更しない。削除済みの配置済みentityが他の保存領域に残らなくても、そのキーは消費履歴のtombstoneとして保持し、配置数とバッチ検証を維持する。既に配置した生地を後から盤面から削除しても、衛生タイマーの消費数は戻さない。削除Undoも消費数を変えない。create Undoの成功時だけ、対象が最新配置で生地`placedEntityKeys`の末尾でもある場合、楕円・そのundo entry・最後の生地キーを同時に戻す。削除・削除Undo・表示再採番は`firstPancakeOrdinal`、バッチ開始時刻、期限、配置済み数、両方の高水位を変えない。

削除recordは既存validatorに合わせる。`startedAt !== null`なら調理中・焼き上がり後のどちらも、温度区間を全て保持し、最後のopen区間を`discardAt = max(now, open.startedAt)`で閉じた`ExecutionRecord`を作る。validatorは`collectedAt >= startedAt`、温度区間が開始から回収時刻まで隙間なく連続すること、`cookCompletedAt === startedAt + 90秒`、および破棄時の`serveTimerStartedAt`・`serveDeadlineAt`・`servedAt`がnull、`unavailableAt`が非null、`unavailableReason === PLATE_DISCARD_REASON`を検証する。破棄分岐では`unavailableAt >= cookCompletedAt`を要求しないため、調理途中の破棄記録も既存schemaで有効であり、未完了の調理payload/温度履歴を捨てずに記録として残す。未開始楕円は`startedAt=null`かつ温度区間なしなので実行記録を作らず、UndoEntry内にpayloadを保持する。削除Undoは対象entityKeyの破棄recordだけを除去し、元の`Pancake` payloadを復元する。これは既存record validatorで実現できる範囲に基づく方針で、新しいdiscard status/schemaは追加しない。

## Pages保存データ移行

localStorage schemaを7から8へ上げる。formatVersion 1のJSONバックアップ形式は維持し、内包するschema 1〜7をschema 8へ移行して読み込む。

- 旧IDからentityKeyを決定的に割り当てる。旧IDを正規化・検証した後、全領域の`oldId -> entityKey`写像を先に構築する。`legacy:<encoded-old-id>`の名前空間値を使い、同じ旧IDを持つitems・records・completion・Undo内のpancake/参照・生地配置履歴には同じkeyを割り当てる。生地配置履歴だけに残る旧IDは削除済みentityのtombstoneとして同じ決定的keyへ写すが、表示ID採番対象や`creationOrdinal`対象にはしない。`legacy:`接頭辞は新規UUIDと重ならない。異なる旧IDのkey衝突や同一領域内の重複entityはマージせず、保存を変更しないエラーにする。新規entityは既存key集合との衝突を確認したUUIDを割り当てる。
- 既存M-N IDは序数を`creationOrdinal`と初期表示IDに写す。配置順が不明な旧UUID履歴は真の順を推測せず、旧M-Nの後ろに既存records配列順（同一記録列内は元配列indexをtie-breaker）で連続する`creationOrdinal`を割り当てる。この決定的な順を`nextCreationOrdinal`と共に保存し、次回読込で変えない。`nextPancakeOrdinal`は従来の値をそのまま保つ。
- `DoughBatchState.placedIds`を`placedEntityKeys`に移し、全旧IDから作ったkey mapで解決する。参照先が盤面・記録から削除済みでも、消費済みキーとして生地状態に残し、配置数を保つ。件数・バッチ境界・開始時刻・期限・完了状態を保つ。現行schema 7検証の「配置済みIDが当時の連続序数と合う」条件は、表示IDではなく保存済みの配置順/tombstone履歴を検証するschema 8の条件へ置き換える。
- schema 8のバックアップはentityKeyの重複、番号の重複・非連続、欠落した関連先、生地配置履歴と序数の不整合を検証する。不正な保存データやbackupで現在の盤面を上書きしない。
- migration中は一時的な`oldId -> entityKey`写像を先に構築して全fieldへ適用し、その後に別の`entityKey -> dense public id`写像を作る。片方の写像で他方を上書きしない。移行全体と再番号付けは保存前にSnapshot全体で検証し、一括書込みにする。
- 移行後に表示IDを詰めても過去に書き出したCSVは変わらない。新規書き出しは更新済みレコードIDを使う。CSVの列構成は維持する。

## 変更範囲と所有

- **Luna worker A — モデル・Pages保存・CSV**：`cooking-app/lib/kitchen-model.ts`、`cooking-app/lib/local-kitchen-storage.ts`、`cooking-app/lib/use-kitchen-local.ts`、`cooking-app/lib/execution-record-export.ts`を担当する。entityKey参照、creationOrdinal/nextCreationOrdinalと既存nextPancakeOrdinal/表示IDの分離、削除・Undo・create Undoの原子的遷移、schema 8/backup移行、今後のCSV番号更新を実装する。共有`use-kitchen.ts`やサーバー transport の`Command.id`は広くentityKeyへ変更しない。
- **Luna worker B — Pages UIと説明**：`cooking-app/app/kitchen.tsx`、`cooking-app/app/globals.css`、`cooking-app/README.md`を担当する。長押しドラッグアウト、盤外判定、プレビューとアクセシブルな説明、表示IDのレンダリングを実装する。モデル担当とファイル所有を重ねない。
- **Sol coordinator**：作業を調整し、共有型のlegacy互換とこのPages-only方針を確認する。生地タイマー計画と実装に影響する境界を統合する。
- **別のGPT-6 Luna reviewer**：実装者と分け、ID参照移行、削除とUndo、CSV出力、生地タイマー整合、pointer境界を独立レビューする。

## 実装手順

1. **内部IDと高水位の分離**：Pancake、ExecutionRecord、CompletionItem、UndoEntryに不変`entityKey`を追加し、作成順を`creationOrdinal`と`nextCreationOrdinal`で持つ。既存`nextPancakeOrdinal`は生地セット/従来割当の高水位として別に維持する。`id`は表示・CSV用に限定し、関連record等の内部参照とReact keyをentityKeyへ切り替える。Pagesの外部操作commandは現行の公開`id`を保ち、`expectedGeneration`と`expectedVersion`を検証してモデルが現在のsnapshot内でentityKeyへ解決する。再採番でid対応が変わる操作はgenerationを進め、古いポインター/commandが別のお好み焼きを指さないようにする。`use-kitchen.ts`とserver transport型は変更対象に含めない。Pages内のpending表示は再採番中に別itemを誤ってbusy扱いしないよう、UIで内部keyへ解決する必要がある場合のみPages経路に閉じて対応する。
2. **schema 8とJSON移行**：旧schema 1〜7と従来backupからcollision-safeなentityKey、creationOrdinal、nextCreationOrdinal、生地配置キーを決定的に構築する。既存`nextPancakeOrdinal`、192個の割当上限、8セット分の生地タイマー動作を保つ。必要な表示ID再計算関数を共通モデルに置き、読込状態も正規化する。
3. **密な表示/CSV番号**：items、completionItems、recordsの和集合をentityKeyごとに統合し、creationOrdinal順で`1-1`から連続採番する。割当てを3領域へ同時に反映する。CSV exporterは同じ`record.id`を列値として出すため、既存列を保ったまま将来の出力へ新しい表示IDを使う。
4. **削除とUndo**：盤外pointerupでのみ使う削除commandをPages経路に追加/再許可し、公開`id`・expectedGeneration・expectedVersionを検証して現在の対象をentityKeyへ解決する。開始済み（調理中を含む）の楕円は温度区間を維持した`PLATE_DISCARD_REASON`recordを作る。未開始楕円は実行recordを作らずUndoEntryへpayloadを保持する。削除後、entityKey/creationOrdinalを保持したまま表示IDを一括再計算する。Undo payload内の古い公開idは権威値にせず、entityKeyから復元後に再採番する。Undoは位置・version・entityKey・関連recordを検証する。generation/version不一致や採番衝突で失敗したときは一切部分更新しない。
5. **create Undo**：履歴末尾がcreateで、対象が最後の割当ordinalかつitems・records・completion・Undo残部・生地placedEntityKeysの全参照を除去できる場合だけ、楕円・create Undo・末尾生地キーを一緒に戻す。従来の安全条件に従って`nextPancakeOrdinal`と`nextCreationOrdinal`を一つ戻し、表示IDも再計算する。IDが再利用可能になるため、成功時は世代も進めて古いポインター操作を無効化する。通常削除Undoではどちらのhigh-waterも戻さず、別entityの番号再利用をしない。ID・記録参照・生地末尾の不整合や世代上限時は全体を変更しない。
6. **長押しドラッグUI**：pointerdown時にentityKey、generation、version、押下元の鉄板矩形を捕捉する。450ms到達後にドラッグ状態と削除予告を表示し、12 CSS px以上の移動があり、pointerupが両方の鉄板矩形外（隙間を含む）ならdeleteを送る。どちらかの鉄板上で離す、pointer cancel/lost capture、世代変更、対象更新中はキャンセルする。ドラッグによる鉄板内移動は追加しない。温度矢印と通常短押しを従来どおりにする。
7. ヘルプ・READMEと関連計画の説明を更新し、独立レビューを行う。既存のPages配信やCSV列仕様は変えない。

## 192 ID・配置順・上限

- 利用者向けの公開番号形式は既存の`M-N`を保ち、現在の一意なentity集合上限を192件とする。削除でrecordも残らないentityが消えれば空いた表示番号は詰めて再利用し、entityKeyとcreationOrdinalは再利用しない。entity集合が192件なら新規作成を拒否して上限理由を示す。
- `creationOrdinal`は各entityの作成順として不変。`nextCreationOrdinal`は通常削除・削除Undo・再採番で戻さず、新規作成でのみ進む。最新create Undoは、そのcreateの全参照が消え、creationOrdinalと従来`nextPancakeOrdinal`の両方が末尾だと確認できた場合だけ、それぞれを一つ戻す。以前の配置ID再利用条件と生地placedEntityKeys末尾条件も維持する。
- `nextPancakeOrdinal`は従来の192個の割当高水位/生地ID範囲上限であり、表示IDではない。表示番号スロットが削除で空いても、生涯高水位は通常削除では戻らず、8セット超へ拡張しない。
- 新規配置のentityKey UUIDとcreationOrdinalは保存側で発行する。表示IDは保存側が既存entity集合から一度だけ算出し、盤面・record・completion・CSVの一意性を検証してから保存する。UI側は旧カウンターから表示IDを推測しない。
- 生地セットの`firstPancakeOrdinal`と配置境界、期限超過後に飛ばすID範囲は従来のcreation sequence上に維持する。UIが利用者向けIDとして古い割当て番号を案内しないよう、飛ばす範囲の表示文言も内部配置順との区別を明確にする。

## 受け入れ条件と確認

- 3つの未記録の盤上楕円が`1-1`,`1-2`,`1-3`のときに`1-2`を盤外削除すると、`1-1`,`1-2`が表示される。2つ目の楕円のpayload、entityKey、調理状態は3つ目の元データのままで、表示だけが更新される。
- 開始済み楕円を削除すると、最後の温度区間が破棄時刻で閉じたrecordが残り、`cookCompletedAt`は開始時刻+90秒、discard service fieldはvalidatorの既存契約どおりになる。未開始楕円にはrecordを作らない。どちらもUndoで元payloadが戻り、作成したdiscard recordがあれば同じentityKeyのものだけ取り除く。
- 直前の削除Undoで同じentityKeyの楕円が元位置・状態で戻り、3件の公開番号が連続する。Undo以外の古いversion/generation操作は拒否し、部分更新しない。
- create Undoの成功時に最新配置・生地残数・creationOrdinalの既存条件を守り、全参照を消した場合だけ高水位を一つ戻し、表示IDを連続状態へ再計算する。失敗時はID・楕円・生地のどれも部分更新しない。
- 完成ボックス移動後の記録とCSV行はentityKeyに結び付き続ける。削除/Undoによる再番号付け後、今後のCSVは現在の連続IDを出す。既にダウンロード済みCSVは変更されない。CSV列名・列数は維持する。
- `doughBatch.placedEntityKeys`は表示IDの再採番、delete、delete Undoで変わらない。配置後の削除は消費数を戻さず、該当createの安全なUndoだけが末尾の生地キーを戻す。既存の他領域に参照がない配置済みentity keyも消費tombstoneとして許可する。schema 7移行後も完了数・残数・期限・Undoが保たれる。
- schema 1〜7のPages保存値とformatVersion 1の既存backupが読み込め、schema 8として保存・書き出し・復元できる。既存の盤面、record、完成ボックス、Undo、タイマー、生地セットを保つ。不正または重複するentityKey/表示ID/参照を拒否し、現行保存を壊さない。
- 192件表示上限と既存のcreation sequence/8生地セット上限を越えず、削除による表示番号スロット解放と生涯高水位の違いを画面で誤解させない。
- 移行対象に192件を超える異なる記録entityがある場合は、表示IDを重複させたりデータを削ったりしない。読み込みを保護エラーとして停止し、表示番号形式の拡張を別途決定する。
- 通常の短いタップ、温度、移動、完成ボックス、create、pointercancel/lost captureが従来どおり動く。盤外操作は実際のpointerupが両鉄板の外のときだけ削除を確定する。
- 最終差分レビュー、`npm run typecheck`、`npm run build:pages`、`git diff --check`を行う。テストは明示依頼がないため追加・実行しない。

## リスクと計画状態

現在の`id`はモデルの主キーを兼ねるため、文字列を盤面上だけで直接詰め替える実装ではpayload、Undo、実行記録、生地セット参照が別の個体へつながる。entityKeyへの内部関連付けを先に完了し、表示IDは共通の写像関数で更新する。外部commandの公開IDは現行API互換のままgeneration/versionでガードし、モデルで対象を解決する。Pages-onlyの削除UIは`kitchen.tsx`内のPages分岐に閉じ、PC runtime/APIの再サポートは行わない。

現在の`nextPancakeOrdinal`と8生地セット上限は変更しない。削除により表示上の空き番号は再利用可能になるが、配置順の生涯採番高水位は戻らない。これは既存の生地24個セット境界と192個上限を保つ判断である。将来その高水位も削除で回復させたい場合は、別の採番・生地セット設計として計画し直す。

Pagesのproduction変更は未着手。前提として、削除・Undo・create Undo後の表示番号を共通状態モデルで原子的に再計算し、schema 8移行・backup・CSVの後方互換まで確認してから利用者に出す。
