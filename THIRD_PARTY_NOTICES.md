# 依存・ライセンスと公式配布元

確認日：2026-10-19。アプリ独自ソースはLICENSEのMIT。npm依存はありません。システムのランタイムを同梱せず利用します。

| 要素 | 使用・配布範囲 | 公式元・ライセンス |
| --- | --- | --- |
| Node.js（互換24.15.0以上／検証26.11.1） | 別途必要、非同梱。内蔵SQLite・暗号・HTTPを利用 | [nodejs.org](https://nodejs.org/)、MITと同梱第三者通知に従う |
| macOS AppKit/WebKit/Security/CryptoKit/LocalAuthentication | OSシステム機能、非同梱 | Apple SDK/OS利用条件 |
| Microsoft.Web.WebView2 1.0.4258.31 | Windowsのみ、NuGet成果物を利用予定 | [公式NuGet](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31)、3条項BSD型の同梱LICENSE.txtをlicenses/Microsoft.Web.WebView2.txtに保持 |
| System.Security.Cryptography.ProtectedData 10.0.13 | Windowsのみ、DPAPI | [公式NuGet](https://www.nuget.org/packages/System.Security.Cryptography.ProtectedData/10.0.13)、MIT（.NET Runtimeの通知も確認が必要） |
| .NET 10 Desktop Runtime | Windows共有ランタイム、非同梱 | [dotnet.microsoft.com](https://dotnet.microsoft.com/)、MIT等の第三者通知 |
| Microsoft Edge WebView2 Runtime | Windows共有ランタイム、非同梱 | MicrosoftのRuntime利用条件。SDKのライセンスと区別 |
| Python3 / PyGObject / GTK3 / WebKitGTK 4.1 / libsecret | Linuxのシステム依存、非同梱 | 各ディストリビューション公式パッケージ。PythonはPSF、PyGObject/GTK/libsecretはLGPL系、WebKitGTKはLGPL/BSD等の複合。正確な版と全文は配布先パッケージの通知を確認 |
| Lucide由来インラインSVG | UIソースに埋め込み | [公式ライセンス](https://lucide.dev/license)、ISCおよびFeather由来部分MIT。全文はlicenses/Lucide.txt |
| アプリアイコン | このプロジェクトのPNG/ICO/ICNS | 指定された旧ソースの参照対象から引き継いだもの。第三者の権利・再配布許諾は独立に確認できていないため公開前の確認事項 |

NuGet2パッケージの公式取得URL、実ダウンロード容量、SHA-256/SHA-512、フック一覧はdependency-integrity.json。2026-10-20にはMicrosoft公式.NET SDK 10.0.402を公式SHA-512と照合し、一時領域へ展開してWindows x64向けコンパイルを実行しました。WinRT用のWindows SDK投影もビルドに利用し、OS標準のWindows Hello APIへ接続しています。SDKはアプリへ同梱しません。署名の暗号学的検証、全ターゲットの実行監査、全SDK・推移依存の完全なロックとCVE照合は残っています。直接依存のハッシュ記録を、完全なサプライチェーン監査の代わりとはしません。

Linuxパッケージ名は [Debian WebKitGTK](https://packages.debian.org/trixie/gir1.2-webkit2-4.1) と [Fedora WebKitGTK](https://packages.fedoraproject.org/pkgs/webkitgtk/webkit2gtk4.1/) を参照。対応するNode版が標準リポジトリにない環境では、パッケージだけで初回導入を完了できません。共有依存の容量は別計測が必要です。
