# GitHub Pages デプロイ修復計画・2026-10-03記録

> **2026-10-10追記：この文書の本文は2026年10月3日時点のデプロイ修復・公開確認の記録です。** 当時は画面内のWeb Locks API実行時エラーが報告されていましたが、修正commit `67de70e` が後日mainに反映されました。2026年10月9日のActions run 13と10月10日のrun 16は成功し、公開URLおよびHTMLが参照するJavaScript・CSS資産のHTTP 200を確認しています。固定スマートフォンでの実操作は未確認です。現行運用の範囲と最新状況は[GitHub Pages構成の正本](single-phone-github-pages-architecture.md)を参照してください。以下の計画・手順・状態は2026年10月3日時点の履歴です。

作成日：2026年10月3日

改訂日：2026年10月3日（公開元設定と公開画面の実行時エラーを反映）

計画担当：GPT-6 Luna

対象：外側のプロジェクトリポジトリ `raymee675/Raymee-Kitchen`、`main` ブランチ

## 目的と期待する動作

Pages用のCSSビルドで不足している `tw-animate-css` を追加し、既存のGitHub Actionsから調理管理アプリをGitHub Pagesへ公開できるようにする。固定のスマートフォン1台で公開URLを開き、既存の端末内JavaScript版を使う構成を維持する。

## 確認済みの事実と制約

- GitHub Actions実行 `37020520133`（コミット `1f814e9fd6efc7bd104b26e6eb8f155a2ea0f1c8`）は依存関係のインストールとTypeScriptチェックを通過し、静的アプリのビルドで失敗した。記録された原因は `Unable to resolve @import "tw-animate-css"` と同モジュールを開く際の `ENOENT`。
- `cooking-app/app/globals.css` は `tw-animate-css` をインポートする。UIでは `animate-in`、`animate-out`、accordion、caret-blinkのアニメーションクラスを使うため、CSSのインポートを削除せず依存関係を追加する。
- Tailwind CSSは `4.2.1`、Viteは `8.0.13`。追加する依存は `tw-animate-css@1.4.0` とし、`package.json` で完全一致のバージョンを指定する。
- デプロイworkflow `.github/workflows/deploy-pages.yml` は `ubuntu-latest` とNode.js `24.19.0` を使い、`npm ci`、`npm run typecheck`、`npm run build:pages` の順に実行してからPages artifactをデプロイする。
- 変更の基準はワークスペース外側のプロジェクトroot。現在のローカルHEADは `f1235c4`（`origin/main` より1コミット先行）、親コミットと `origin/main` は `1f814e9`。`f1235c4` には依存追加、npmが再生成したlockfile、計画書が既にコミットされている。コミットをpushする前にlockfileを修復する。
- `cooking-app` ディレクトリ内には別の古いGitメタデータがあり、`git -C cooking-app` はHEAD `dd7190d` の旧スターターとの巨大な差分を表示する。今回の差分確認・復元には使わず、外側のプロジェクトrootから操作する。
- 現在のnpm生成lockは新しいパッケージのroot宣言とレコードを追加する一方、34個の既存packageレコードも削除している。削除には26個の `@esbuild/*` OS/CPU別レコード（Ubuntu CIで使う `@esbuild/linux-x64` を含む）および `esbuild`、`tsx`、`terser` と関連レコードが含まれる。今回の依存追加には不要な差分であり、Linux CIへの影響を排除できないため、そのまま保持しない。
- ローカルの直接 `npm` コマンドはPATH上にない。`pnpm dlx npm@11` でnpm `11.21.0` を起動でき、依存追加コマンドは成功した。ただし、続けて開始した `pnpm dlx npm@11 ci` は完了前に中断された。`npm ci`、型チェック、Pagesビルドの成功は未確認である。
- `f1235c4` のlockfileは `1f814e9` から34個の既存package recordを削除している。履歴は書き換えず、`1f814e9` にあった既存recordsを復元して不足している `tw-animate-css` recordを残す修正を追加し、その後に検証する。実装担当は計画改訂前に編集や検証を開始していない。
- Pages設定が `Deploy from a branch` のままだったため、GitHubのJekyll用 `pages build and deployment` workflowも実行されていた。実際のPages設定を `GitHub Actions` に切り替えて保存し、既存のカスタムworkflowを再実行した。run attempt 2 は成功し、`https://raymee675.github.io/Raymee-Kitchen/` はHTTP 200で `鉄板タイマー` のHTMLを返す。
- 公開URLをブラウザーで開くと、Pages版の画面内で `navigator.locks.request` が `ifAvailable` と `signal` の同時指定を拒否し、操作が停止することを確認した。該当コードは `cooking-app/lib/use-kitchen-local.ts` の編集ロック要求である。`ifAvailable: true` による多重タブ拒否の動作を保ちつつ、両立しないabort signalオプションを取り除く必要がある。
- W3C Web Locks API仕様では、`signal` と `ifAvailable` の両方が指定されたlock requestは `NotSupportedError` で拒否される。仕様: https://www.w3.org/TR/web-locks/#dom-lockmanager-request

## 変更対象と担当

| 対象 | 変更内容 | 担当 |
| --- | --- | --- |
| `docs/github-pages-deployment-plan.md` | 現状と履歴を書き換えない復旧手順を追記する | Sol（改訂）、Luna（初版） |
| `cooking-app/package.json` | `f1235c4` に追加済みの `devDependencies.tw-animate-css: "1.4.0"` を保持する | 変更不要 |
| `cooking-app/package-lock.json` | `1f814e9` から削除された既存recordsを復元し、`tw-animate-css@1.4.0` のroot宣言とpackage recordを維持する | Luna worker |
| `cooking-app/lib/use-kitchen-local.ts` | Web Locks APIに互換性のあるoptionのみ渡し、単一タブ編集ロックを取得して調理画面を有効にする | Luna worker |
| 検証と最終差分レビュー | npm ci、型チェック、Pagesビルドを実行し、差分をレビューする | Luna workerが実行、Solがレビュー |
| コミット、push、Actions、Pages公開確認 | 変更を公開し、新規workflow実行とURLを確認する | 親エージェント |

CSS、UI、アプリの保存方式、workflowは今回の修復対象に含めない。検証で別の障害が分かった場合は、ログに基づきSolが計画を改訂してから対応する。

## 実施手順

1. Solは現在のHEADと既存コミットに基づき本計画を改訂した。最小lock方針は、履歴を書き換えず削除されたrecordsを復元する形とする。
2. Luna workerは `1f814e9` の `cooking-app/package-lock.json` を基準に、`f1235c4` にある `packages[""].devDependencies.tw-animate-css` と `packages["node_modules/tw-animate-css"]` のrecord（version、resolved、integrity、dev、license、funding）を移植する。既存recordsはすべて保持し、`package.json` は変更しない。
3. 変更後、外側rootで差分を確認する。`git diff 1f814e9..HEAD -- cooking-app/package-lock.json` に元からあった依存recordsの削除がないこと、特に `@esbuild/linux-x64` と他のoptional package recordsが存在することを確認する。
4. `cooking-app` で `pnpm dlx npm@11 ci` を最後まで実行し、lockから依存を再現できることを確認する。続けて `pnpm dlx npm@11 run typecheck` を実行する。
5. PowerShellで `$env:PAGES_BASE_PATH = '/Raymee-Kitchen/'` を設定し、`pnpm dlx npm@11 run build:pages` を実行する。`dist-pages` が生成されることも確認する。各コマンドの終了コードと最終差分を報告する。
6. `npm ci` が最小lockの不整合を明示して失敗した場合は、エラーを保存し、原因が `tw-animate-css` の完全なロック情報に限られるか調査する。理由が確認できるまでlock全体の再生成や無関係な削除をしない。計画にない変更が必要なら、Solが先に計画を改訂する。
7. Pages設定は `GitHub Actions` に切り替え済み。Solが現在のruntime errorに基づき本計画を改訂し、Luna workerは `use-kitchen-local.ts` の編集ロック要求から互換性のない `signal` 指定を除く。単一タブ制御の `ifAvailable: true` は維持する。
8. Luna workerは型チェックとベースパス付きPages buildを実行する。Solが最終差分を確認してコミット・pushし、そのコミットのActions build、artifact upload、Pages deploy成功を確認する。
9. Solは公開URLを開き、HTML、JS/CSSアセット、調理画面のエラー非表示・編集有効化を確認する。スマートフォンでの実操作はユーザー端末で確認する。

## 検証と受け入れ条件

- `origin/main` (`1f814e9`) からの最終差分では `package.json` に `tw-animate-css: "1.4.0"` が追加され、lockfileにはそのroot宣言とpackage recordが含まれる。元からあったlock entriesは削除されない。
- lockに `tw-animate-css` のversion `1.4.0`、resolved URL、integrityがあり、既存のLinux向け `@esbuild/linux-x64` と全platform optional recordが保持される。
- `pnpm dlx npm@11 ci`、`pnpm dlx npm@11 run typecheck`、ベースパスを設定した `pnpm dlx npm@11 run build:pages` がすべて成功し、`dist-pages` が生成される。
- 新しいGitHub Actions実行（Ubuntu runner）でビルド、artifact upload、Pages deploymentが成功する。
- 公開URLでアプリが表示され、`/Raymee-Kitchen/` 配下からアセットが取得される。
- 公開したアプリがWeb Locks APIの不正なoptions指定で停止せず、ローカルデータを読み込み、単一編集タブのロックを取得できる。
- スマートフォンでの実操作は別途ユーザー端末で確認し、URL到達確認だけをもって全操作の検証済みとはしない。
- GitHub Pagesのサイトはソースリポジトリがprivateでも公開URLから誰でも閲覧できる。Pages版は開いたブラウザーの `localStorage` に調理状態を保存するため、公開先に調理状態を同期・保存しないが、サイト自体へのアクセス制限はない。

## リスクと未確定事項

- Windows上のnpm lock生成でLinux向けoptional package記録が削られることがある。Ubuntu Actionsが最終的なクロスプラットフォーム検証となるため、既存platform recordsを保護し、Actionsの新規実行を必須とする。
- `npm ci` のローカル成功だけではLinuxでのesbuild optional package欠落を除外できない。lockの差分確認とUbuntu workflow成功の両方を受け入れ条件とする。
- PrivateリポジトリのPages利用可否やPages設定はアカウントの契約・設定に依存する。設定エラーが出た場合は内容を確認し、必要な変更のみを判断する。
- `raymee675/Raymee-Kitchen` はprivateである。個人アカウントのGitHub FreeではPagesはpublic repositoryでのみ利用でき、private repositoryからPagesを公開するにはGitHub Pro等の対象プランが必要。公開サイトはソースrepoのvisibilityにかかわらずインターネットから閲覧できるため、ユーザーが選んだ固定スマホ運用ではURL非公開をアクセス制御として扱わず、secretをビルド成果物に含めない。
- 他の未宣言依存があれば、今回のCSS依存を追加した後に別のビルドエラーが現れる可能性がある。ログを根拠に扱い、先回りした広範な更新はしない。
