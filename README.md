# 就活トラッカー 2.0

企業、選考、面接記録、予定、待遇比較をローカルで管理するデスクトップアプリです。通常の管理操作はオフラインで使えます。AI通信と更新確認にはネットワークが必要です。

確認日：2026-10-20。macOS Apple Siliconを検証対象としています。WindowsとLinuxの実機動作、実アカウントでのChatGPT接続は未検証です。仕様書・設計書・詳細な検証記録はローカルの `docs/` に保管し、Gitの管理対象から除外しています。

## 起動

Node.js **24.15.0以上**が必要です。実際に検証した版は26.11.1です。最低版はAPI互換条件であり、安全な最新版を示すものではありません。NodeとOSを保守対象の更新版に保ってください。Nodeは配布物に同梱していません。

macOSのビルド済みアプリは `dist/mac-arm64/就活トラッカー.app`。DMGまたはZIPも同じフォルダーにあります。Apple Silicon専用で、ローカル実行用のアドホック署名です。Developer ID署名・公証は行っていません。

```sh
cd job-tracker
npm start
```

macOSホストは `/opt/homebrew/bin/node`、`/usr/local/bin/node` 等を探します。別のNodeを指定する場合は `JOB_TRACKER_NODE_PATH` に実行ファイルの絶対パスを指定してください。ソースを編集したら再ビルドが必要です。

ブラウザーだけの開発用起動は次のとおりです。出力されるURLを開き、終了はCtrl+C。URLには一時認証情報が含まれるため共有しないでください。このモードのmacOSでは安全な鍵保管経路がないためChatGPT認証は利用不可です。

```sh
npm run dev -- --server-only
```

## ビルド・検証

npm依存は0件で、npm installは不要です。外部ブラウザーやSDKを既存プロジェクトからコピーしません。

```sh
npm test
npm run security:audit
npm run build
npm run screenshots
```

macOSビルドにはXcode Command Line Tools、撮影とブラウザーテストにはGoogle Chromeが必要です。撮影と自動テストは一時データ領域と専用ブラウザープロファイルを使い、実データを参照しません。静的監査は脆弱性データベースを使う総合監査ではありません。

Windows候補：Windows環境にNode、.NET 10 SDK、共有.NET 10 Desktop Runtime、WebView2 Runtimeを用意し `platforms/windows/build.ps1 -Runtime win-x64`（ARM64はwin-arm64）。全依存のロックファイル生成・署名確認・脆弱性監査結果・実機動作は未完了です。Linux候補：`python3 platforms/linux/package.py`。RPM作成にはrpmbuildが必要です。GTK3、WebKitGTK 4.1、PyGObject、libsecret、対応するNodeが必要で、配布先OSでの依存解決と起動は別途検証が必要です。

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

登録だけでは通信せず、元の画面で接続先を選び「このプロンプトを送信して生成」を押すと、表示中の共通プロンプト（就活プロフィールを含む）がその提供元へ送信されます。生成結果はプレビューを確認してから保存します。PerplexityのみWeb検索を指定し、他の接続は既知情報の整理用です。通常APIはチャットの月額契約とは別枠で、MiniMax M Planだけ専用Subscription Keyに対応します。Z.AI Coding Plan・Kimi Codeの利用枠、Copilot SDK、Nousのローカル中継、Qwenの地域別接続、新規OAuthは今回未対応。API応答処理は模擬通信で検証済みで、実キーによる疎通・課金・全モデルの動作は未検証です。

更新画面は起動時／手動確認、通知、明示ダウンロード、ハッシュ検証、確認後の起動に対応します。正式な配布リポジトリが未確定なので既定では無効です。公開・リリースは行っていません。

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
