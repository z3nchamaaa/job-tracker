using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Windows.Security.Credentials.UI;

namespace JobTracker.Host
{
    internal static class Program
    {
        private static readonly byte[] DpapiEntropy = Encoding.UTF8.GetBytes("jp.jobtracker.app.auth.v1");

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Contains("--protect"))
            {
                return RunDpapiProtect();
            }
            if (args.Contains("--unprotect"))
            {
                return RunDpapiUnprotect();
            }

            if (args.Contains("--app-auth-available") || args.Contains("--authenticate-app"))
            {
                ApplicationConfiguration.Initialize();
                return RunAppAuthentication(args.Contains("--app-auth-available"));
            }

            ApplicationConfiguration.Initialize();
            using var mainForm = new MainWindow(args.Contains("--smoke-test"));
            Application.Run(mainForm);
            return 0;
        }

        private static int RunAppAuthentication(bool availabilityOnly)
        {
            int exitCode = 1;
            using var dialog = new Form { Text = "就活トラッカーの認証", ClientSize = new Size(360, 120), StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
            dialog.Controls.Add(new Label { Text = "Windows Helloで本人確認を行います。", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter });
            dialog.Shown += async (_, _) =>
            {
                try
                {
                    var available = await UserConsentVerifier.CheckAvailabilityAsync();
                    if (available != UserConsentVerifierAvailability.Available) return;
                    if (availabilityOnly)
                    {
                        Console.Out.WriteLine("APP_AUTH_AVAILABLE");
                        exitCode = 0;
                    }
                    else
                    {
                        var result = await UserConsentVerifierInterop.RequestVerificationForWindowAsync(dialog.Handle, "就活トラッカーの起動時ロックを確認します");
                        if (result == UserConsentVerificationResult.Verified)
                        {
                            Console.Out.WriteLine("APP_AUTH_OK");
                            exitCode = 0;
                        }
                    }
                }
                catch { exitCode = 1; }
                finally { if (!dialog.IsDisposed) dialog.Close(); }
            };
            // Availability checks must not display an authentication prompt or a visible form.
            if (availabilityOnly) { dialog.Opacity = 0; dialog.ShowInTaskbar = false; }
            Application.Run(dialog);
            return exitCode;
        }

        private static int RunDpapiProtect()
        {
            try
            {
                using var ms = new MemoryStream();
                Console.OpenStandardInput().CopyTo(ms);
                byte[] encrypted = ProtectedData.Protect(ms.ToArray(), DpapiEntropy, DataProtectionScope.CurrentUser);
                Console.Out.Write(Convert.ToBase64String(encrypted));
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.Message);
                return 1;
            }
        }

        private static int RunDpapiUnprotect()
        {
            try
            {
                string input = Console.In.ReadToEnd().Trim();
                byte[] encrypted = Convert.FromBase64String(input);
                byte[] plain = ProtectedData.Unprotect(encrypted, DpapiEntropy, DataProtectionScope.CurrentUser);
                Console.Out.Write(Encoding.UTF8.GetString(plain));
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.Message);
                return 1;
            }
        }
    }

    internal sealed class MainWindow : Form
    {
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
        private readonly WebView2 _webView;
        private readonly ProcessJob _processJob;
        private Process? _backendProcess;
        private Uri? _allowedOriginUri;
        private readonly bool _smokeTest;

        private void ApplyWindowAppearance(string mode)
        {
            bool isDark = mode == "dark";
            BackColor = isDark ? Color.FromArgb(23, 19, 28) : Color.FromArgb(254, 247, 255);
            _webView.DefaultBackgroundColor = BackColor;
            int dark = isDark ? 1 : 0;
            DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
            // Match the web header while keeping native caption buttons, resizing,
            // Snap layouts and the system menu. These colors are supported on Windows 11;
            // older Windows versions retain their standard caption appearance.
            int background = ColorTranslator.ToWin32(BackColor);
            int foreground = ColorTranslator.ToWin32(isDark
                ? Color.FromArgb(238, 231, 241) : Color.FromArgb(29, 27, 32));
            if (SystemInformation.HighContrast) background = foreground = -1; // Use Windows' accessible caption colors.
            DwmSetWindowAttribute(Handle, 35, ref background, sizeof(int)); // DWMWA_CAPTION_COLOR
            DwmSetWindowAttribute(Handle, 36, ref foreground, sizeof(int)); // DWMWA_TEXT_COLOR
        }

        public MainWindow(bool smokeTest)
        {
            _smokeTest = smokeTest;
            _processJob = new ProcessJob();

            Text = "就活トラッカー";
            ClientSize = new Size(1280, 820);
            MinimumSize = new Size(360, 420);
            StartPosition = FormStartPosition.CenterScreen;
            MainMenuStrip = null;
            Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);

            _webView = new WebView2
            {
                Dock = DockStyle.Fill
            };
            Controls.Add(_webView);

            Load += OnFormLoad;
            FormClosing += OnFormClosing;
        }

        internal static bool IsAllowedWebViewNavigation(string? candidateUriString, Uri? allowedOriginUri)
        {
            if (allowedOriginUri == null || string.IsNullOrWhiteSpace(candidateUriString))
            {
                return false;
            }
            if (!Uri.TryCreate(candidateUriString, UriKind.Absolute, out var candidate))
            {
                return false;
            }
            if (!string.IsNullOrEmpty(candidate.UserInfo) || !string.IsNullOrEmpty(allowedOriginUri.UserInfo))
            {
                return false;
            }
            if (!string.Equals(candidate.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(candidate.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
            return string.Equals(candidate.Scheme, allowedOriginUri.Scheme, StringComparison.OrdinalIgnoreCase) &&
                   string.Equals(candidate.Host, allowedOriginUri.Host, StringComparison.OrdinalIgnoreCase) &&
                   candidate.Port == allowedOriginUri.Port &&
                   candidate.Port >= 1 &&
                   candidate.Port <= 65535;
        }

        internal static bool TryGetSafeExternalHttpsUri(string? candidateUriString, out string safeUri)
        {
            safeUri = "";
            if (string.IsNullOrWhiteSpace(candidateUriString))
            {
                return false;
            }
            string trimmed = candidateUriString.Trim();
            if (trimmed.StartsWith("-", StringComparison.Ordinal) ||
                trimmed.Any(c => char.IsControl(c) || char.IsWhiteSpace(c) || c == '"'))
            {
                return false;
            }
            if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
            {
                return false;
            }
            if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
                !string.IsNullOrEmpty(uri.UserInfo) ||
                string.IsNullOrWhiteSpace(uri.Host) ||
                uri.Port < 1 ||
                uri.Port > 65535)
            {
                return false;
            }
            safeUri = uri.AbsoluteUri;
            return true;
        }

        private static void OpenSafeExternalUrl(string? candidateUriString)
        {
            if (TryGetSafeExternalHttpsUri(candidateUriString, out string safeUri))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = safeUri,
                    UseShellExecute = true
                });
            }
        }

        private async void OnFormLoad(object? sender, EventArgs e)
        {
            string baseDir = AppContext.BaseDirectory;
            string cliPath = Path.Combine(baseDir, "app", "src", "backend", "cli.cjs");
            string bridgePath = Path.Combine(baseDir, "app", "platforms", "windows", "bridge.js");

            string nodeExecutable = Path.Combine(baseDir, "app", "runtime", "node.exe");
            if (!File.Exists(nodeExecutable))
            {
                MessageBox.Show("アプリの起動に必要なファイルが見つかりません。アプリを入れ直してください。", "アプリを起動できませんでした", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }
            var psi = new ProcessStartInfo
            {
                FileName = nodeExecutable,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            psi.ArgumentList.Add(cliPath);
            psi.Environment.Remove("NODE_OPTIONS");
            psi.Environment.Remove("NODE_PATH");
            psi.Environment["JOB_TRACKER_HOST_BINARY"] = Environment.ProcessPath ?? "";

            _backendProcess = Process.Start(psi);
            if (_backendProcess == null)
            {
                Close();
                return;
            }
            _processJob.AssignProcess(_backendProcess);

            string? line = await _backendProcess.StandardOutput.ReadLineAsync();
            if (string.IsNullOrWhiteSpace(line))
            {
                MessageBox.Show("OS認証が完了しなかったか、アプリ設定を読み込めませんでした。認証をキャンセルした場合は再起動して認証してください。", "アプリを開けませんでした", MessageBoxButtons.OK, MessageBoxIcon.Information);
                Close();
                return;
            }

            using var doc = JsonDocument.Parse(line);
            string bootstrapUrl = doc.RootElement.GetProperty("url").GetString() ?? "";
            string originStr = doc.RootElement.TryGetProperty("origin", out var originProp)
                ? (originProp.GetString() ?? bootstrapUrl)
                : bootstrapUrl;
            if (Uri.TryCreate(originStr, UriKind.Absolute, out var parsedOrigin) &&
                string.IsNullOrEmpty(parsedOrigin.UserInfo))
            {
                _allowedOriginUri = parsedOrigin;
            }

            await _webView.EnsureCoreWebView2Async();
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _webView.CoreWebView2.Settings.IsNonClientRegionSupportEnabled = true;

            if (File.Exists(bridgePath))
            {
                string bridgeJs = await File.ReadAllTextAsync(bridgePath, Encoding.UTF8);
                await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(bridgeJs);
            }

            _webView.CoreWebView2.NavigationStarting += OnNavigationStarting;
            _webView.CoreWebView2.NewWindowRequested += OnNewWindowRequested;
            _webView.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
            _webView.CoreWebView2.WebMessageReceived += (_, message) =>
            {
                if (!IsAllowedWebViewNavigation(message.Source, _allowedOriginUri)) return;
                try
                {
                    using var appearance = JsonDocument.Parse(message.WebMessageAsJson);
                    if (appearance.RootElement.GetProperty("type").GetString() != "appearance") return;
                    string? mode = appearance.RootElement.GetProperty("mode").GetString();
                    if (mode != "dark" && mode != "light") return;
                    ApplyWindowAppearance(mode);
                }
                catch { /* Ignore malformed appearance messages. */ }
            };
            _webView.CoreWebView2.Navigate(bootstrapUrl);
        }

        private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (!IsAllowedWebViewNavigation(e.Uri, _allowedOriginUri))
            {
                e.Cancel = true;
                OpenSafeExternalUrl(e.Uri);
            }
        }

        private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            OpenSafeExternalUrl(e.Uri);
        }

        private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (_smokeTest)
            {
                Console.Out.WriteLine("SMOKE_TEST_OK");
                Close();
            }
        }

        private void OnFormClosing(object? sender, FormClosingEventArgs e)
        {
            try
            {
                if (_backendProcess != null && !_backendProcess.HasExited)
                {
                    _backendProcess.Kill(true);
                }
            }
            catch
            {
                // Job Object guarantees cleanup
            }
            _processJob.Dispose();
        }
    }
}
