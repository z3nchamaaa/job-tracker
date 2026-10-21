# 就活トラッカー 2.0

企業、選考、面接記録、予定、待遇比較をローカルで管理するデスクトップアプリです。通常の管理操作はオフラインで使えます。AI通信と更新確認にはネットワークが必要です。

**開発中のソース公開版です。** Windowsの取り込み処理で`fsync EPERM`、macOSのCIでカンバンのアニメーション検査が失敗しています。これらのエラー・ビルド失敗は現在未修正です。安定版アプリや全OSでの動作を保証する公開ではありません。

確認日：2026-10-21。macOS Apple Siliconを検証対象としています。WindowsとLinuxの実機動作、実アカウントでのChatGPT接続は未検証です。仕様書・設計書・詳細な検証記録はローカルの `docs/` に保管し、Gitの管理対象から除外しています。

## 起動

Node.js **24.22.1以降の24系、または26.12.1以降の26系**が必要です。[2026-10-21のセキュリティ修正](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)を基準に、修正前の版・25系・未検証の新しいメジャー版はDBを開く前に起動を停止します。24.22.1と26.12.1で全71テストを検証しています。NodeとOSを保守対象の更新版に保ってください。NodeとElectronは配布物に同梱していません。旧ビルドにはこの起動制限がないため、Node本体の更新とアプリの再ビルド・再起動が必要です。

ローカルビルドの出力先は `dist/mac-arm64/就活トラッカー.app`。成功時はDMGまたはZIPも同じフォルダーに生成します。ビルド済みアプリはリポジトリに含めず、リリース配布もしていません。Apple Silicon専用で、ローカル実行用のアドホック署名です。Developer ID署名・公証は行っていません。

```sh
cd job-tracker
npm ci --ignore-scripts
npm start
```

macOSホストは `/opt/homebrew/bin/node`、`/usr/local/bin/node` 等を探します。別のNodeを指定する場合は `JOB_TRACKER_NODE_PATH` に実行ファイルの絶対パスを指定してください。ソースを編集したら再ビルドが必要です。

ブラウザーだけの開発用起動は次のとおりです。出力されるURLを開き、終了はCtrl+C。URLには一時認証情報が含まれるため共有しないでください。このモードのmacOSでは安全な鍵保管経路がないためChatGPT認証は利用不可です。

```sh
npm run dev -- --server-only
```

## ビルド・検証

Copilot連携に公式 `@github/copilot-sdk` 1.0.23と推移依存を使用します。初回は `npm ci --ignore-scripts` で固定版を導入してください。対象OS・CPU用の公式ランタイムも取得するため、配布物の容量は増えます。既存プロジェクトの依存やログイン情報はコピーしません。

```sh
npm test
npm run security:audit
npm run build
npm run screenshots
```

macOSビルドにはXcode Command Line Tools、撮影とブラウザーテストにはGoogle Chromeが必要です。撮影と自動テストは一時データ領域と専用ブラウザープロファイルを使い、実データを参照しません。静的監査は脆弱性データベースを使う総合監査ではありません。

Windows候補：Windows環境にNode、.NET 10 SDK、共有.NET 10 Desktop Runtime、WebView2 Runtimeを用意し `platforms/windows/build.ps1 -Runtime win-x64`（ARM64はwin-arm64）。NuGetのロックファイルは作成済みですが、署名確認・全依存の完全監査・実機動作は未完了です。Linux候補：`python3 platforms/linux/package.py`。RPM作成にはrpmbuildが必要です。GTK3、WebKitGTK 4.1、PyGObject、libsecret、対応するNodeが必要で、配布先OSでの依存解決と起動は別途検証が必要です。

## 保存と移行

アプリIDは `jp.jobtracker.app`。旧版とは独立しています。

| OS | 保存先 |
| --- | --- |
| macOS | `~/Library/Application Support/jp.jobtracker.app` |
| Windows | `%APPDATA%\jp.jobtracker.app` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/jp.jobtracker.app` |

DBはjob-tracker.db、就活軸はcareer-profile.json、認証情報はauth/auth.enc、取り込み前の保存はbackups内に置きます。企業DBとプロフィール・バックアップは平文です。認証情報だけをAES-256-GCMで暗号化し、鍵をmacOS Keychain／Windows DPAPI／Linux Secret Serviceで保護します。鍵保管に失敗したときは認証を利用不可にし、既存鍵を上書きしません。ディスク全体の保護はOSの設定に依存します。

データ管理画面からJSONバックアップ、プレビュー付きの取り込み、直前の取り込みの巻き戻しができます。バックアップは就活軸や企業メモなどの個人情報を含みます。認証トークンは含めません。共有・クラウド保存の前に内容を確認してください。旧SQLiteファイルの取り込みはユーザーが選択した内容のみを扱い、ファイルパスをAPIで指定できません。旧パスワードは取り込みません。

更新はデータ領域を削除しません。アプリを削除してもデータは保持します。完全削除にはバックアップ要否を確認してから上記の専用データ領域を削除してください。OSの認証鍵やWebViewキャッシュは別管理で、アプリ削除だけでは消えない場合があります。`JOB_TRACKER_DATA_DIR` を指定すると保存先を変更できます。

## AIと更新

企業調査のコピペ機能を利用できます。コピーする本文を確認し、外部サービスへ渡す情報を判断してください。AI生成した候補は確認してから保存します。

ChatGPT連携は公式の[オープンソース向けトークン共有](https://developers.openai.com/siwc/token-sharing-open-source)を参照したOAuth PKCEと公式Responses経路です。実アカウントでの動作・利用資格は未検証です。別の認証方式へ自動変更しません。

「AI / プロンプトで追加」→「各種エージェントを登録する」で、提供元・表示名・モデルID・APIキーを登録できます。対象はOpenAI、OpenRouter、Claude、Gemini、Grok、Perplexity Agent API、DeepSeek、Mistral、Z.AI、Kimi、MiniMax（通常API／M Plan）の11社・12方式です。モデルIDは各提供元の管理画面で確認してください。APIキーは `auth/api-agents.enc` にOS保護付きで暗号化し、企業バックアップには含めません。削除はアプリ内の登録解除であり、提供元側のキー失効は管理画面から行います。

登録だけでは通信せず、元の画面で接続先を選び「このプロンプトを送信して生成」を押すと、表示中の共通プロンプト（就活プロフィールを含む）がその提供元へ送信されます。生成結果はプレビューを確認してから保存します。PerplexityのみWeb検索を指定し、他の接続は既知情報の整理用です。通常APIはチャットの月額契約とは別枠で、MiniMax M Planだけ専用Subscription Keyに対応します。Z.AI Coding Plan・Kimi Codeの利用枠、Nousのローカル中継、Qwenの地域別接続は今回未対応。API応答処理は模擬通信で検証済みで、実キーによる疎通・課金・全モデルの動作は未検証です。

### GitHub Copilotの設定

「各種エージェントを登録する」の「GitHub Copilot連携」から設定します。

1. GitHubの Settings → Developer settings → OAuth Apps で、このアプリ専用のOAuth Appを作成し、**Enable Device Flow**を有効にします。Client Secretはアプリへ入力・同梱しません。
2. 公開識別子のClient IDをアプリへ入力し、「Client IDを保存」を押します。
3. 「GitHubでCopilotにログイン」を押し、表示された確認コードを「GitHubで承認する」から入力します。GitHub上のアプリ名・要求権限を確認して承認してください。
4. 「モデル・利用枠を確認」で利用可能なモデルと取得できた残量を確認します。未取得の残量を0や無制限として表示しません。自動選択（auto）も利用できます。
5. 「戻る」から接続先にGitHub Copilotを選び、明示的に生成します。企業DBへはプレビュー確認後に保存します。

認証はGitHubの公式[Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)、生成は公式[Copilot SDKのOAuth連携](https://github.com/github/copilot-sdk/blob/main/docs/setup/github-oauth.md)です。トークンは `auth/copilot.enc` にOS保護付きで暗号化します。既存の`gh`／Copilot CLI認証や環境変数のキーは使わず、一時的な空の作業領域で、ファイル・シェル・MCP・スキル・Web検索・リモートセッションを無効にします。処理終了時にランタイムを停止し、一時領域を削除します。期限切れトークンは再ログインが必要です。連携解除はローカルのトークン削除で、GitHub側の認可取消はGitHubのOAuth App設定で行います。

利用資格・モデル・残量・追加課金はGitHubの契約と組織ポリシーに依存します。[利用枠の公式説明](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing)を参照してください。無料・無制限とは保証しません。実OAuth Appは未作成のため、実アカウントの承認・契約枠での生成は未検証です。SDKとの実通信は認証なしのランタイム起動まで確認しています。モデル呼び出しは模擬APIで検証します。

更新画面は起動時／手動確認、通知、明示ダウンロード、ハッシュ検証、確認後の起動に対応します。ソース用リポジトリは[z3nchamaaa/job-tracker](https://github.com/z3nchamaaa/job-tracker)です。署名済みアプリの配布先・更新用リリースは未設定なので、更新機能は既定で無効です。

[依存とライセンス](THIRD_PARTY_NOTICES.md)。ビルド後の容量実測は `dist/size-report.json` に出力します。`dist/` はGitの管理対象外です。

macOSのファイル選択パネルの回帰確認：`node scripts/test-macos-file-panel.cjs`。専用の架空データ領域から実際のパネルを開き、キャンセルして終了します。

カンバンは通常幅で4列×2行に8ステータスを表示し、企業一覧を列内で上下にスクロールできます。横スクロールはありません。狭い画面は2列／1列に切り替えます。広いウィンドウでは集計を上部に残します。各列の企業一覧はTabキーでフォーカスできます。

列の見出しや余白を選ぶと、その状態の企業一覧がカンバン内で拡大します。拡大中も詳細表示・ステータス変更ができ、「戻る」またはEscapeで元の列へ縮小します。企業一覧ページには移動せず、戻る際は元の列内スクロール位置と見出しへのフォーカスを保ちます。OSの視差効果を減らす設定では拡大・縮小の動きを省略します。

企業カードは全体をクリックして詳細を開けます（通常・拡大表示共通）。Tabで企業名にフォーカスしてEnter／Spaceでも開けます。「前へ・次へ」やマイページのボタンは各操作のみを実行します。

## テーマと起動時ロック

ヘッダーの「設定」から、システム／ライト／ダークのテーマと4種類のアクセント色を保存できます。設定はアプリのデータ領域の `app-settings.json` に保存し、起動直後から適用します。

起動時ロックは初期状態ではオフです。有効化・無効化時と、有効な状態での起動時にOS認証を求めます。macOSは [LocalAuthenticationの標準認証](https://developer.apple.com/documentation/LocalAuthentication/LAPolicy/deviceOwnerAuthentication)（Touch ID、Apple Watch、MacのログインパスワードなどOSが許可する手段）、Windowsは [Windows Helloのデスクトップ向け認証](https://learn.microsoft.com/en-us/windows/apps/develop/ui/display-ui-objects#for-classes-that-implement-iuserconsentverifierinterop)を使います。認証情報をアプリ内で入力・保存することはありません。Linuxと通常のブラウザーではロックを有効化できません。

認証失敗・キャンセル時は起動を停止し、DBと画面を開きません。設定ファイルを読み取れない場合も起動を停止します。これはアプリ起動時のロックであり、DBの暗号化や、同一OSユーザーが設定ファイルを削除・変更することへの防御ではありません。データ領域・OSアカウントは引き続きOS側で保護してください。

macOSはビルド・OS認証API利用可否・実ウィンドウのテーマ連携を確認済み。Windows HelloはWindows向けコンパイル成功（警告0・エラー0）、Windows実機と実際の生体認証／PIN認証成功は未検証です。ロック有効化前にOS側の本人確認手段を設定してください。

## macOSの基本ショートカット

| キー | 操作 |
| --- | --- |
| ⌘Q | アプリを終了 |
| ⌘W | ウィンドウを閉じる（最後のウィンドウではアプリを終了） |
| ⌘M | 最小化 |
| ⌘H / ⌥⌘H | アプリを隠す / ほかのアプリを隠す |
| ⌘X / ⌘C / ⌘V / ⌘A | 入力の切り取り / コピー / 貼り付け / 全選択 |
| ⌘Z / ⇧⌘Z | 入力の取り消し / やり直し |
| ⌃⌘F | フルスクリーンの切り替え |
| Escape | モーダルを閉じる |

標準メニューバーの「編集」「ウィンドウ」からも実行できます。未保存のモーダル入力がある場合、⌘Q・⌘W・ウィンドウの閉じるボタンでは破棄確認を出します。保存済みの企業データは保持します。取り消し／やり直しはテキスト編集用で、企業の削除や取り込みを戻す操作ではありません。

## 開発・保守と公開準備

現在は2.0.0の開発段階で、ソース公開と安定版アプリの配布を分けています。Google Drive同期は未実装です。リポジトリへのpushは行っていますが、アプリの公開リリースはありません。

変更はPull Requestで確認し、`npm ci --ignore-scripts`、`npm test`、`npm run security:audit`、`npm run sbom`を実行してください。UIを変更した場合は該当する`check-*.cjs`の画面確認も行います。個人DB・実プロフィール・認証情報を再現手順やテストデータに入れません。貢献コードには本リポジトリのMITライセンスを適用します。初期保守担当はリポジトリ所有者で、共同保守者の追加・リリース承認は所有者が判断します。非互換変更やデータ形式変更は、変更理由と移行・復旧方法をPRに記載します。

`.github/workflows/ci.yml`はmacOS・Windows・Linuxのテスト、依存監査、SBOM生成を定義しています。ActionsはコミットSHAで固定し、標準権限を読み取りのみにし、チェックアウトに認証情報を残しません。候補パッケージの作成は手動起動です。GitHub上で実行済みで、現時点ではWindows・macOSのチェックが失敗しています。Linuxのチェックは成功しました。失敗を無効化・成功扱いにはしません。Dependabotは週次でnpm・Actions・NuGetの更新PRを作る設定で、自動マージしません。SDK更新時は`dependencies.cjs`の許可バージョンとライセンス・インストール処理も再確認します。

mainは[Protect main](https://github.com/z3nchamaaa/job-tracker/settings/rules/25484958)で保護しています。直接push・削除・force-pushを禁止し、PR、GitHub Actionsの3 OSチェック、最新mainへの追従、レビュー会話の解決を必須にしています。単独運用のため他者承認は0件で、バイパスはありません。`.github/main-ruleset.json`はこの運用に合わせた設定例です。CI失敗中は通常のマージがブロックされます。保守者の2要素認証は各アカウントで管理してください。

### 脆弱性の報告と対応方針

セキュリティ上の問題は、[Security → Advisories](https://github.com/z3nchamaaa/job-tracker/security/advisories)の「Report a vulnerability」から非公開で報告してください。ソース公開時にprivate vulnerability reportingを有効化します。公開Issueにトークン・DB・個人情報や未修正の攻撃手順を投稿しないでください。窓口開設後の目標は、受領確認3営業日、初期評価7日、重大な問題14日・高リスク30日・その他90日以内の修正または対応計画です。これは個人開発の目標であり、保証付きSLAではありません。公開時期は報告者と調整し、修正版とアドバイザリーで対象バージョン・回避策を示します。公開後のサポート対象は最新の安定版系列とし、終了は事前告知します。現在の開発版に継続サポートの保証はありません。

### パッケージ・SBOM・署名

更新側とビルド側は同じ命名関数を使います。例は`job-tracker-2.0.0-mac-arm64.dmg`、`job-tracker-2.0.0-win-x64.exe`、`job-tracker-2.0.0-linux-amd64.deb`、`job-tracker-2.0.0-linux-x86_64.rpm`です。Windowsのportable ZIPは`-portable.zip`で終わります。Windowsの作成は`./platforms/windows/build.ps1 -Runtime win-x64`、Inno Setup導入済み環境では`-BuildInstaller`も指定できます。Windowsの依存は`packages.lock.json`と`--locked-mode`で固定します。

`npm run sbom`はnpm標準のCycloneDX 1.5形式を出力し、各ビルドでも対象OS用のSBOMと`SHA256SUMS`・`release-manifest.json`を同梱します。SBOMの対象はインストール済みnpm依存です。SDK内蔵ランタイムの内部構成、NuGet、OS・共有Node/.NET/WebViewの全構成を網羅するものではありません。それらのライセンスと脆弱性は別途確認が必要です。`SHA256SUMS`は`shasum -a 256 -c SHA256SUMS`などで照合できますが、同じ場所で配るハッシュだけでは配布者を証明できません。更新JSONの署名済みフラグも署名証明として信用しません。

`npm run release:check -- --candidate`は候補のファイル名・ハッシュ・SBOM・対象CPUのCopilotランタイムを確認します。通常の`npm run release:check`はさらに作業ツリー、実際のmacOS署名・公証、リポジトリ設定と運用担当者の確認を要求し、未設定では失敗します。設定先は`.github/release-policy.json`です。運用確認フラグは担当者の申告であり、GitHub設定をサーバーから検証した証拠にはなりません。Windows/Linux候補を調べる場合は`dist/win-x64`や`dist/linux-x64`を引数に渡します。通常モードの公開判定は現状macOS向けで、他OSを公開可と判定しません。

macOSの署名準備は`node scripts/sign-macos.cjs`で確認できます。既定はドライランです。Developer ID、Team ID、設定済みnotarytoolプロファイルを明示し、`--execute`を付けた場合のみ別フォルダへ署名・公証します。既存の署名済みフォルダは上書きしません。アプリ側のコードを内側から署名します。別ライセンスのCopilot CLIには再署名やentitlement変更を行わず、ベンダーのバイナリを未改変のまま保持します。ベンダー署名のまま公証できない場合は、配布方式を見直す必要があります。実証明書による署名、公証後の起動・Copilot生成は未検証です。[Appleの公証手順](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)に従って最終確認してください。

Windowsの`platforms/windows/sign.ps1`も既定はドライランで、`dist/`内のexe/dll・明示した証明書拇印・HTTPSタイムスタンプURLだけを受け付けます。`-Execute`時に署名と発行者照合を行います。自作ホストを署名後にZIP・インストーラーを作り、インストーラーも署名してからハッシュを更新します。Copilot CLIの実行ファイルは再署名・改変せず、ベンダーの状態を保持してください。証明書とWindows実機がないため未検証です。どちらのスクリプトもGitHubへの公開は行いません。

OSPS監査資料の指摘は改善の参考にしていますが、全項目適合やリスクゼロとは判定していません。独自ソースとプロジェクト向け生成アイコンはMIT、第三者コンポーネントは[個別のライセンス](THIRD_PARTY_NOTICES.md)に従います。内包CLIはSDKのMITとは別の[GitHub Copilot CLI License](licenses/Copilot-CLI.txt)であり、各OSのステージングに全文を含めます。署名・公証、内蔵ランタイムの完全な監査、実Copilot認証・生成、Windows/Linux実機での起動確認は、安定版アプリ配布に向けて残る項目です。内部仕様・作業記録は`docs/`に集約し、Gitの対象外です。
