# GitHub Actions・GitHub PagesでPCサーバーを置き換えられるか

> **2026-10-02更新：この評価は複数スマホの共有・認証を残す旧前提です。** 利用スマホを固定1台とし、登録・認証を不要にする新しい前提では、画面と保存をブラウザー内で完結できるため結論が変わります。現行案は[固定1台向けPages構成](single-phone-github-pages-architecture.md)を参照してください。

評価日：2026-10-02  
対象：現在のPC版Node.jsサーバーを止め、複数のスマホで調理画面を共有する構成。

## 結論

**GitHub ActionsとGitHub Pagesだけでは、現在のPCサーバーを置き換えられない。** GitHub Pagesは静的ファイルを配信するホスティングであり、現在の `/api/board`、登録コード認証、端末セッション、共有データ保存を実行するAPIサーバーやデータベースを提供しない。GitHub Actionsはビルド、確認、デプロイの実行環境であり、通常の利用者から来る調理API要求を継続して処理する本番サーバーではない。

PagesはHTML・CSS・JavaScriptの配信には使える。Actionsはソース変更時のビルド、必要な確認、デプロイに使える。**調理APIと永続データには、別のHTTP API実行環境とデータベースが必要。**

## 現在PCが担っている処理

| PC側の処理 | 実装上の役割 | Pages / Actionsのみで代替 |
| --- | --- | --- |
| 画面とHTTPサーバー | Reactの静的ファイル、`/register`、APIルートを同じNode.jsプロセスで提供 | 静的ファイル配信はPagesで可能。動的APIは不可 |
| 調理状態 | `node:sqlite`のSQLiteへ配置・開始時刻・時間・版番号を保存 | 不可。GitHubリポジトリ、Pages成果物、Actionsキャッシュは運用DBにしない |
| 操作API | `GET/POST /api/board`で状態を読取り、競合と操作再送を検証して更新 | 不可。ActionsをAPI代わりに呼ぶ案はジョブ待ち・権限管理・制限があり、画面操作向きでない |
| 端末認証 | 15分の一回限りコード、30日Cookie、個別端末停止 | 不可。サーバー側セッション照合と管理者認証が必要 |
| 状態同期 | 表示中は約700ms間隔で状態を取得 | 不可。動的APIが必要。静的PagesへのGETだけでは他端末の操作を共有できない |
| LAN接続 | Windows PCがホットスポット／Wi-Fi内から到達可能なHTTPサーバーとして動作 | 不要になる。ただしクラウド利用には各スマホのインターネット接続が必要 |

## 候補構成

### A. GitHub Actions + GitHub Pagesだけ

```text
GitHub Actions → 静的成果物 → GitHub Pages → スマホ
```

PCで画面を配信する役目だけなら置換できるが、状態を保存しAPIを動かす場所がないため、複数スマホでの調理共有は成立しない。ボタン操作からActionsのジョブを開始すること自体はできるが、非同期のジョブ開始・実行は短い画面操作へのAPI応答に向かない。利用者ごとのリクエスト応答、SQLite相当の永続状態、短い同期周期を担うサービスではない。

GitHubの公開ランナーはジョブごとにVMを用意し、終了後に破棄する。GitHub-hosted runnerのジョブは最大6時間で終了する制限もある。Actionsはデプロイや確認用に使う。

GitHub Pagesは商用サービスやオンライン事業の運営を主目的とする無料ホスティングとしては利用が認められない場合がある。内部の調理用ツールが条件に当たるかは利用形態とGitHubの現行規約で確認が必要。通常サイトにも月100GBのソフト帯域上限がある。

### B. GitHub Actions + GitHub Pages + 別サービスのAPI・DB

```text
GitHub Actions → GitHub Pages → ブラウザー
                                  ↓ HTTPS API
                       Workers等のAPI → D1等のDB
```

機能上は置き換え可能。PCを停止でき、外出先のスマホもネット接続があれば使える。調理状態、コード、端末セッションはGitHubでなくAPIサービスのDBに保存する。

このアプリは現在同一オリジンの相対URLとHTTP-only Cookieを使う。GitHub Pagesと別ドメインのAPIに分ける場合、API URL、CORS、CookieのSameSite/Secure、Safariなどの第三者Cookie制限を含む認証の再設計が必要になる。Pages側のプレビュー／本番ドメインごとの許可設定も要る。ブラウザーへAPIの管理秘密鍵を置いてはならない。

### C. GitHub Actions + Cloudflare Pages Functions + D1

```text
GitHub Actions → Cloudflare Pages
                  ├─ React静的画面
                  └─ Pages Functions (/api/*) → D1
```

**PCを止めることが目的なら、この構成を推奨する。** GitHub Actionsはテスト・ビルド・Cloudflareへのデプロイだけを行い、利用者の要求はPages Functionsが処理する。画面とAPIを同じサイト配下に置け、相対URLと同一サイトCookieを維持しやすい。Pages Functionsはサーバー側コードを実行でき、D1をバインドできる。

これは**GitHub PagesではなくCloudflare Pages**を使う案。GitHubはコード保管とActions、Cloudflareは画面・API・DBを担当する。新たなCloudflare契約・API token等の初期設定は必要。

## 既存実装の移植量

- `pc-client`とViteで作る画面は、静的サイトとして再利用しやすい。
- `lib/kitchen-model.ts`のタイマー計算、入力検証、版番号付き操作の多くはNode専用APIを使わず、Workers側へ持ち込みやすい。
- `server/index.mjs`はNode.js HTTP、ネットワークIF列挙、TCP peerによるlocalhost判定を使うため、そのままPages Functionsに載せられない。`/api/*`をFunctionsのルートへ分け、クラウド管理者認証とAPI認証を設計し直す。
- `server/storage.mjs`は`node:sqlite`とPC内ファイルに依存する。D1スキーマ、操作IDの一意性、競合処理、コード照合、端末失効へ移す。
- PC側管理画面がlocalhostからのみ使える設計はクラウドでは使えない。管理者だけが送信先や登録コードを操作できる認証が必要。
- 登録コードと端末は、新たなD1へ一度移行する。PCのSQLiteはそのままクラウドから参照できない。バックアップを取ってから、停止時間を決めてスナップショット移行する。

## 同期間隔と料金面

現行画面は表示中に約700msの待ち時間を置いて状態取得を繰り返す。5台が1日8時間使う場合、通信時間を無視した上限近似で約20.6万API要求／日、30日で約617万要求／月となる。実際の間隔はリクエストの処理時間だけ長くなる。

確認日時点のCloudflare Workers Freeは1日100,000要求。上記の使い方はこの無料上限を超える。Workers Paidは最低月額5米ドルに月1,000万要求が含まれるため、要求数だけならこの仮定の範囲内だが、操作要求・CPU時間・D1利用量は別途測定する必要がある。Pages FunctionsもWorkersとして課金される。

したがって、既存の700msポーリングをそのまま移すならWorkers Paid相当を予算候補として扱う。追加費用を避けることが最優先なら、API呼び出しの間隔を延ばすか、変更時に接続端末だけへ通知するWebSocket方式を別途試作し、実測して決める。

## 推奨する移行手順

1. クラウド利用に切り替える時間と、インターネット接続が必須になる運用を決める。
2. Pages Functions + D1の検証環境を作り、画面からのAPIアクセスとCookie認証を実機で確認する。
3. 純粋なモデル処理を共有し、Node API・`node:sqlite`ストレージをFunctions・D1へ移植する。
4. 管理者認証と端末登録を移植し、テスト端末でコード失効、端末停止、競合、通信断復帰を確認する。
5. Actionsはテスト・ビルド・本番デプロイに限定し、デプロイ用Cloudflare tokenは必要最小限の権限でSecretに保存する。Fork／pull requestのworkflowから秘密情報を読めない設定にする。
6. PC SQLiteのバックアップを保管し、空の検証DBで復元手順を試してから本番の移行時刻を決める。

## 公式資料

- [GitHub Pagesの説明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [GitHub Pagesの制限](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [GitHub Pagesでサーバー側言語を利用できない説明](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [GitHub-hosted runners：ジョブ終了後にVMを破棄](https://docs.github.com/en/actions/how-tos/manage-runners/github-hosted-runners/use-github-hosted-runners)
- [GitHub Actionsの制限](https://docs.github.com/en/enterprise-cloud@latest/actions/reference/limits)
- [Cloudflare Pages Functions](https://developers.cloudflare.com/pages/functions/)
- [Pages FunctionsからD1を利用する設定](https://developers.cloudflare.com/pages/functions/bindings/)
- [Workers / Pages Functions料金](https://developers.cloudflare.com/workers/platform/pricing/)
