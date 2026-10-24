# 依存・ライセンスと公式配布元

確認日：2026-10-24。アプリ独自ソースはLICENSEのMIT。Copilot連携の公式SDKと対象OS用ランタイムは、任意の追加機能として取得します。Node.js 26.12.1の対象OS・CPU用実行ファイルと全文ライセンスを同梱します。システムWebViewは非同梱です。

| 要素 | 使用・配布範囲 | 公式元・ライセンス |
| --- | --- | --- |
| Node.js 26.12.1 | 公式実行ファイルを対象OS・CPU別に同梱。公式アーカイブ・実行ファイル・ライセンスのSHA-256をnode-runtime-lock.jsonに固定。npmや開発用ヘッダーは非同梱 | [公式配布](https://nodejs.org/dist/v26.12.1/)、Node本体はMIT、内蔵第三者コードは各通知に従う。全文は[licenses/Node.js.txt](licenses/Node.js.txt)と配布物のruntime/LICENSE.txt |
| @github/copilot-sdk 1.0.23 | Copilot OAuth・モデル一覧・利用枠・生成。公式npm固定版 | [公式SDK](https://github.com/github/copilot-sdk)、MIT。全文はlicenses/Copilot-SDK-MIT.txt |
| 内包Copilot CLI 1.0.100（OS別SDK runtime 1.0.23） | 任意のCopilot追加機能として、必要時に対象OSの公式バイナリを未改変で取得 | [固定版のGitHub Copilot CLI License](https://github.com/github/copilot-cli/blob/v1.0.100/LICENSE.md)。全文はlicenses/Copilot-CLI.txt。SDKのMITとは別条件で、CLIをアプリ独自のMITで再許諾しない。CLIは再署名・entitlement変更を行わず、元の通知を保持する。内蔵推移コンポーネントの完全監査を主張しない |
| koffi 3.2.1／@koromix/koffiの対象OS版3.2.1 | Copilot追加機能の直接依存。アプリは分離したstdio実行を選択 | MIT、同梱packageのLICENSE.txt。installスクリプトは無効にし、公式prebuilt optional packageを使用 |
| vscode-jsonrpc 8.2.1 | SDKの通信依存 | MIT、同梱License.txt／thirdpartynotices.txt |
| zod 4.6.6 | SDKの型検証依存 | MIT、同梱LICENSE |
| macOS AppKit/WebKit/Security/CryptoKit/LocalAuthentication | OSシステム機能、非同梱 | Apple SDK/OS利用条件 |
| Microsoft.Web.WebView2 1.0.4258.31 | Windowsのみ、NuGet成果物を利用 | [公式NuGet](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31)、3条項BSD型の同梱LICENSE.txtをlicenses/Microsoft.Web.WebView2.txtに保持 |
| System.Security.Cryptography.ProtectedData 10.0.13 | Windowsのみ、DPAPI | [公式NuGet](https://www.nuget.org/packages/System.Security.Cryptography.ProtectedData/10.0.13)、MIT（.NET Runtimeの通知も確認が必要） |
| .NET 10 Desktop Runtime | Windows共有ランタイム、非同梱 | [dotnet.microsoft.com](https://dotnet.microsoft.com/)、MIT等の第三者通知 |
| Microsoft Edge WebView2 Runtime | Windows共有ランタイム、非同梱 | MicrosoftのRuntime利用条件。SDKのライセンスと区別 |
| Python3 / PyGObject / GTK3 / WebKitGTK 4.1 / libsecret | Linuxのシステム依存、非同梱 | 各ディストリビューション公式パッケージ。PythonはPSF、PyGObject/GTK/libsecretはLGPL系、WebKitGTKはLGPL/BSD等の複合。正確な版と全文は配布先パッケージの通知を確認 |
| Lucide由来インラインSVG | UIソースに埋め込み | [公式ライセンス](https://lucide.dev/license)、ISCおよびFeather由来部分MIT。全文はlicenses/Lucide.txt |
| アプリアイコン | このプロジェクトのPNG/ICO/ICNS | 旧アプリ向けにAI生成したものを引き継いだと、プロジェクト所有者が2026-10-21に確認。プロジェクトの素材としてMITで提供 |

NuGet2パッケージの公式取得URL、実ダウンロード容量、SHA-256/SHA-512、フック一覧はdependency-integrity.json。2026-10-20にはMicrosoft公式.NET SDK 10.0.402を公式SHA-512と照合し、一時領域へ展開してWindows x64向けコンパイルを実行しました。WinRT用のWindows SDK投影もビルドに利用し、OS標準のWindows Hello APIへ接続しています。SDKはアプリへ同梱しません。署名の暗号学的検証、全ターゲットの実行監査、全SDK・推移依存の完全なロックとCVE照合は残っています。直接依存のハッシュ記録を、完全なサプライチェーン監査の代わりとはしません。

Linuxパッケージ名は [Debian WebKitGTK](https://packages.debian.org/trixie/gir1.2-webkit2-4.1) と [Fedora WebKitGTK](https://packages.fedoraproject.org/pkgs/webkitgtk/webkit2gtk4.1/) を参照。Node.jsはパッケージ内の実行ファイルを使用するため、Nodeパッケージの別途インストールは不要です。共有依存の容量は別計測が必要です。

アプリ独自コードのMITはLICENSE、第三者コード・素材の全文はlicenses/と各同梱パッケージの通知を参照してください。CLIの利用資格・課金はGitHubのアカウント契約に従います。アプリのOSSライセンスからCopilotの利用権を付与するものではありません。

Copilot関連のnpm依存は本体配布物へ含めず、利用者が追加機能を選んだ場合のみ取得します。src/backend/copilot-pack-lock.jsonで公式URL・バージョン・SHA-512 SRIを固定しています。追加機能には上流パッケージのライセンス・第三者通知を保持します。Node.jsは本体に同梱したままです。
