import AppKit
import CryptoKit
import Foundation
import Security
import WebKit
import LocalAuthentication

struct NodeRuntimeUnavailable: LocalizedError {
    var packaged = false
    var errorDescription: String? {
        if packaged { return "アプリの起動に必要なファイルを確認できません。アプリを入れ直してください。" }
        return "開発用のNode.jsが見つかりません。対応版とJOB_TRACKER_NODE_PATHを確認してください。"
    }
}

func resolveSupportedNode(appRoot: String) throws -> String {
    let environment = ProcessInfo.processInfo.environment
    let runtime = (appRoot as NSString).appendingPathComponent("src/backend/runtime.cjs")
    let packaged = Bundle.main.resourcePath.map { appRoot == ($0 as NSString).appendingPathComponent("app") } ?? false
    var candidates: [String] = []
    if packaged {
        // Installed apps use only their own runtime, never the user's shell.
        candidates = [(appRoot as NSString).appendingPathComponent("runtime/node")]
    } else if let explicit = environment["JOB_TRACKER_NODE_PATH"], !explicit.isEmpty {
        // An explicit selection must fail closed rather than silently switching.
        candidates = [explicit]
    } else {
        let asdfRoot = environment["ASDF_DATA_DIR"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".asdf")
        let installs = asdfRoot.appendingPathComponent("installs/nodejs")
        let versions = (try? FileManager.default.contentsOfDirectory(atPath: installs.path)) ?? []
        for version in versions.filter({ $0.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+$"#, options: .regularExpression) != nil })
            .sorted(by: { $0.compare($1, options: .numeric) == .orderedDescending }) {
            // Use actual installations, not shims that depend on shell setup.
            candidates.append(installs.appendingPathComponent(version).appendingPathComponent("bin/node").path)
        }
        candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    }
    for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
        let probe = Process()
        probe.executableURL = URL(fileURLWithPath: candidate)
        // Reuse the backend's security floors before opening any user data.
        probe.arguments = ["-e", "require(process.argv[1]).assertSupportedRuntime();process.stdout.write(process.execPath)", runtime]
        var probeEnvironment = environment
        probeEnvironment.removeValue(forKey: "NODE_OPTIONS")
        probeEnvironment.removeValue(forKey: "NODE_PATH")
        probe.environment = probeEnvironment
        let output = Pipe()
        probe.standardOutput = output
        probe.standardError = FileHandle.nullDevice
        do { try probe.run() } catch { continue }
        let deadline = Date().addingTimeInterval(2)
        while probe.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
        if probe.isRunning { probe.terminate(); continue }
        probe.waitUntilExit()
        guard probe.terminationStatus == 0 else { continue }
        let resolved = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if resolved.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: resolved) { return resolved }
    }
    throw NodeRuntimeUnavailable(packaged: packaged)
}

func runAppAuthentication(availabilityOnly: Bool) -> Never {
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { exit(1) }
    if availabilityOnly {
        FileHandle.standardOutput.write(Data("APP_AUTH_AVAILABLE\n".utf8))
        exit(0)
    }
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    context.localizedCancelTitle = "キャンセル"
    DispatchQueue.main.async {
        application.activate(ignoringOtherApps: true)
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "就活トラッカーの起動時ロックを確認します") { success, _ in
            DispatchQueue.main.async {
                if success { FileHandle.standardOutput.write(Data("APP_AUTH_OK\n".utf8)) }
                exit(success ? 0 : 1)
            }
        }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 115) { context.invalidate(); exit(1) }
    application.run()
    exit(1)
}

private let keychainService = "jp.jobtracker.app.auth"
private let keychainAccount = "aes-gcm-master-key-v1"

enum KeychainCryptoError: Error {
    case keychainFailure(OSStatus)
    case invalidInput
    case encryptionFailure
}

func getOrCreateMasterKey(allowCreate: Bool = true) throws -> SymmetricKey {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
        kSecAttrAccount as String: keychainAccount,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecSuccess {
        guard let data = item as? Data, data.count == 32 else {
            throw KeychainCryptoError.invalidInput
        }
        return SymmetricKey(data: data)
    }
    guard status == errSecItemNotFound, allowCreate else {
        throw KeychainCryptoError.keychainFailure(status)
    }

    var randomBytes = [UInt8](repeating: 0, count: 32)
    let randStatus = SecRandomCopyBytes(kSecRandomDefault, randomBytes.count, &randomBytes)
    guard randStatus == errSecSuccess else {
        throw KeychainCryptoError.keychainFailure(randStatus)
    }
    let keyData = Data(randomBytes)

    let addQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
        kSecAttrAccount as String: keychainAccount,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        kSecValueData as String: keyData
    ]
    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
        throw KeychainCryptoError.keychainFailure(addStatus)
    }
    return SymmetricKey(data: keyData)
}

func runProtectCli() -> Int32 {
    let inputData = FileHandle.standardInput.readDataToEndOfFile()
    do {
        let key = try getOrCreateMasterKey()
        let sealed = try AES.GCM.seal(inputData, using: key)
        guard let combined = sealed.combined else {
            throw KeychainCryptoError.encryptionFailure
        }
        let encoded = combined.base64EncodedString()
        FileHandle.standardOutput.write(Data(encoded.utf8))
        return 0
    } catch {
        FileHandle.standardError.write(Data("protect error: \(error)\n".utf8))
        return 1
    }
}

func runUnprotectCli() -> Int32 {
    let inputData = FileHandle.standardInput.readDataToEndOfFile()
    guard let b64 = String(data: inputData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
          let combined = Data(base64Encoded: b64) else {
        FileHandle.standardError.write(Data("unprotect error: invalid base64\n".utf8))
        return 1
    }
    do {
        let key = try getOrCreateMasterKey(allowCreate: false)
        let box = try AES.GCM.SealedBox(combined: combined)
        let opened = try AES.GCM.open(box, using: key)
        FileHandle.standardOutput.write(opened)
        return 0
    } catch {
        FileHandle.standardError.write(Data("unprotect error: \(error)\n".utf8))
        return 1
    }
}

struct NormalizedOrigin: Equatable {
    let scheme: String
    let host: String
    let port: Int
}

func parseNormalizedOrigin(_ url: URL) -> NormalizedOrigin? {
    guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
        return nil
    }
    if comps.user != nil || comps.password != nil {
        return nil
    }
    let scheme = (comps.scheme ?? "").lowercased()
    let host = (comps.host ?? "").lowercased()
    guard (scheme == "http" || scheme == "https"), !host.isEmpty else {
        return nil
    }
    let port = comps.port ?? (scheme == "https" ? 443 : 80)
    guard (1...65535).contains(port) else {
        return nil
    }
    return NormalizedOrigin(scheme: scheme, host: host, port: port)
}

func isAllowedWebViewNavigationURL(_ url: URL, allowedOrigin: NormalizedOrigin?, isInitialBlankAllowed: Bool = false) -> Bool {
    if isInitialBlankAllowed && url.absoluteString == "about:blank" {
        return true
    }
    guard let allowed = allowedOrigin, let candidate = parseNormalizedOrigin(url) else {
        return false
    }
    return candidate == allowed
}

func isSafeExternalHttpsURL(_ url: URL) -> Bool {
    let raw = url.absoluteString
    if raw.isEmpty || raw.hasPrefix("-") {
        return false
    }
    if raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || CharacterSet.whitespacesAndNewlines.contains($0) || $0 == "\"" }) {
        return false
    }
    guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
        return false
    }
    guard comps.scheme?.lowercased() == "https",
          comps.user == nil,
          comps.password == nil,
          let host = comps.host,
          !host.isEmpty else {
        return false
    }
    let port = comps.port ?? 443
    return (1...65535).contains(port)
}

func runOriginPolicySelfTest() -> Int32 {
    guard let baseUrl = URL(string: "http://127.0.0.1:4321"),
          let allowed = parseNormalizedOrigin(baseUrl) else {
        FileHandle.standardError.write(Data("Failed to parse base origin\n".utf8))
        return 1
    }
    let mustAllow = [
        "http://127.0.0.1:4321/",
        "http://127.0.0.1:4321/api/companies?foo=bar"
    ]
    for s in mustAllow {
        guard let u = URL(string: s), isAllowedWebViewNavigationURL(u, allowedOrigin: allowed) else {
            FileHandle.standardError.write(Data("Expected allow failed for \(s)\n".utf8))
            return 1
        }
    }
    let mustRejectNavigation = [
        "http://127.0.0.1:43210/",
        "http://127.0.0.1:80/",
        "http://127.0.0.1/",
        "http://127.0.0.1:4321@evil.example.com/",
        "http://user:pass@127.0.0.1:4321/",
        "https://127.0.0.1:4321/",
        "https://example.com/",
        "file:///etc/passwd",
        "javascript:alert(1)"
    ]
    for s in mustRejectNavigation {
        if let u = URL(string: s), isAllowedWebViewNavigationURL(u, allowedOrigin: allowed) {
            FileHandle.standardError.write(Data("Expected reject passed for \(s)\n".utf8))
            return 1
        }
    }
    guard let validExt = URL(string: "https://example.com/careers?id=1"), isSafeExternalHttpsURL(validExt) else {
        FileHandle.standardError.write(Data("Expected valid external https to pass\n".utf8))
        return 1
    }
    let invalidExternals = [
        "http://example.com/",
        "https://user:pass@example.com/",
        "https://127.0.0.1:4321@example.com/",
        "file:///Applications/Calculator.app",
        "javascript:alert(1)",
        "about:blank"
    ]
    for s in invalidExternals {
        if let u = URL(string: s), isSafeExternalHttpsURL(u) {
            FileHandle.standardError.write(Data("Expected external reject passed for \(s)\n".utf8))
            return 1
        }
    }
    FileHandle.standardOutput.write(Data("ORIGIN_POLICY_SELF_TEST_OK\n".utf8))
    return 0
}

final class WindowDragArea: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var backendProcess: Process?
    var allowedOrigin: String = ""
    var allowedOriginParts: NormalizedOrigin?
    var smokeTestMode: Bool = false
    var snapshotPath: String?
    var filePanelSmokePassed = false
    var confirmSmokePassed = false
    var initialQuery: String = ""
    var windowWidth: CGFloat = 1280
    var windowHeight: CGFloat = 820
    var terminationApproved = false
    var terminationCheckPending = false

    var shortcutSmokeCase: String? {
        let args = CommandLine.arguments
        guard smokeTestMode, let index = args.firstIndex(of: "--smoke-test-shortcuts"), index + 1 < args.count else { return nil }
        let value = args[index + 1]
        return ["clean-q", "clean-w", "dirty-cancel-q", "dirty-discard-w"].contains(value) ? value : nil
    }

    func shortcutSmokeFail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("Shortcut smoke failed: \(message)\n".utf8))
        stopBackend()
        exit(1)
    }

    func pressSmokeShortcut(_ key: String) {
        guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: 0), NSApp.mainMenu?.performKeyEquivalent(with: event) == true else {
            shortcutSmokeFail("Command-\(key) was not handled")
        }
    }

    func runShortcutSmoke(_ scenario: String) {
        func entries(_ menu: NSMenu) -> [NSMenuItem] {
            menu.items.flatMap { item -> [NSMenuItem] in [item] + (item.submenu.map(entries) ?? []) }
        }
        let menuItems = NSApp.mainMenu.map(entries) ?? []
        for (key, action, modifiers) in [
            ("x", "cut:", NSEvent.ModifierFlags.command), ("c", "copy:", .command),
            ("v", "paste:", .command), ("a", "selectAll:", .command),
            ("z", "undo:", .command), ("z", "redo:", [.command, .shift]),
            ("h", "hide:", .command), ("f", "toggleFullScreen:", [.command, .control])
        ] {
            guard menuItems.contains(where: { $0.keyEquivalent == key && $0.action == Selector(action) && $0.keyEquivalentModifierMask == modifiers }) else {
                shortcutSmokeFail("Missing standard menu: \(action)")
            }
        }
        window.makeFirstResponder(webView)
        webView.evaluateJavaScript("(()=>{const i=document.createElement('input');i.id='shortcut-smoke-input';i.value='abcdef';document.body.append(i);i.focus();i.setSelectionRange(6,6);return true})()") { _, error in
            if error != nil { self.shortcutSmokeFail("Input setup") }
            self.pressSmokeShortcut("a")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                self.webView.evaluateJavaScript("(()=>{const i=document.getElementById('shortcut-smoke-input');return i.selectionStart===0&&i.selectionEnd===6})()") { result, error in
                    guard error == nil, (result as? Bool) == true else { self.shortcutSmokeFail("Command-A did not select text in WKWebView") }
                    FileHandle.standardOutput.write(Data("SHORTCUT_SELECT_ALL_OK\n".utf8))
                    self.pressSmokeShortcut("m")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        guard self.window.isMiniaturized else { self.shortcutSmokeFail("Command-M did not minimize") }
                        FileHandle.standardOutput.write(Data("SHORTCUT_MINIMIZE_OK\n".utf8))
                        self.window.deminiaturize(nil)
                        self.window.makeKeyAndOrderFront(nil)
                        NSApp.activate(ignoringOtherApps: true)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                            let setup = scenario.hasPrefix("dirty")
                                ? "document.getElementById('btn-add-manual').click();const i=document.getElementById('ma-name');i.value='架空の未保存企業';i.dispatchEvent(new Event('input',{bubbles:true}));window.jobTrackerHasUnsavedChanges()"
                                : "!window.jobTrackerHasUnsavedChanges()"
                            self.webView.evaluateJavaScript(setup) { result, error in
                                guard error == nil, (result as? Bool) == true else { self.shortcutSmokeFail("Unsaved state setup") }
                                self.pressSmokeShortcut(scenario.hasSuffix("q") ? "q" : "w")
                            }
                        }
                    }
                }
            }
        }
    }

    func installStandardMenus() {
        let menuBar = NSMenu()
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let menu = NSMenu(title: title)
            item.submenu = menu
            menuBar.addItem(item)
            return menu
        }
        @discardableResult
        func item(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil) -> NSMenuItem {
            let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
            entry.keyEquivalentModifierMask = modifiers
            entry.target = target
            menu.addItem(entry)
            return entry
        }
        let application = submenu("就活トラッカー")
        item(application, "就活トラッカーについて", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), target: NSApp)
        application.addItem(.separator())
        item(application, "就活トラッカーを隠す", #selector(NSApplication.hide(_:)), "h", target: NSApp)
        item(application, "ほかを隠す", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option], target: NSApp)
        item(application, "すべてを表示", #selector(NSApplication.unhideAllApplications(_:)), target: NSApp)
        application.addItem(.separator())
        item(application, "就活トラッカーを終了", #selector(NSApplication.terminate(_:)), "q", target: NSApp)

        let edit = submenu("編集")
        item(edit, "取り消す", Selector(("undo:")), "z")
        item(edit, "やり直す", Selector(("redo:")), "z", [.command, .shift])
        edit.addItem(.separator())
        item(edit, "切り取り", #selector(NSText.cut(_:)), "x")
        item(edit, "コピー", #selector(NSText.copy(_:)), "c")
        item(edit, "ペースト", #selector(NSText.paste(_:)), "v")
        item(edit, "すべてを選択", #selector(NSText.selectAll(_:)), "a")

        let windows = submenu("ウィンドウ")
        item(windows, "閉じる", #selector(NSWindow.performClose(_:)), "w")
        item(windows, "しまう", #selector(NSWindow.performMiniaturize(_:)), "m")
        item(windows, "拡大／縮小", #selector(NSWindow.performZoom(_:)))
        item(windows, "フルスクリーン", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
        NSApp.windowsMenu = windows
        NSApp.mainMenu = menuBar
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminationApproved || webView == nil { return .terminateNow }
        if terminationCheckPending { return .terminateCancel }
        terminationCheckPending = true
        webView.evaluateJavaScript("window.jobTrackerHasUnsavedChanges?.() === true") { result, error in
            let finish: (Bool) -> Void = { approved in
                self.terminationCheckPending = false
                self.terminationApproved = approved
                sender.reply(toApplicationShouldTerminate: approved)
                if !approved, self.shortcutSmokeCase == "dirty-cancel-q" {
                    self.webView.evaluateJavaScript("window.jobTrackerHasUnsavedChanges()") { result, error in
                        guard error == nil, (result as? Bool) == true, self.window.isVisible, self.backendProcess?.isRunning == true else {
                            self.shortcutSmokeFail("Cancellation did not preserve the input, window and backend")
                        }
                        FileHandle.standardOutput.write(Data("SHORTCUT_CANCEL_PRESERVES_INPUT_OK\n".utf8))
                        self.stopBackend()
                        exit(0)
                    }
                }
            }
            if error == nil, (result as? Bool) == false {
                finish(true)
                return
            }
            let alert = NSAlert()
            alert.messageText = error == nil ? "未保存の入力があります" : "入力状態を確認できませんでした"
            alert.informativeText = "保存していない入力を破棄して終了しますか？ 保存済みの企業データは保持されます。"
            alert.addButton(withTitle: "入力を破棄して終了")
            alert.addButton(withTitle: "キャンセル")
            alert.beginSheetModal(for: self.window) { response in
                finish(response == .alertFirstButtonReturn)
            }
            if let scenario = self.shortcutSmokeCase, scenario.hasPrefix("dirty") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    guard alert.window.isVisible, alert.window.sheetParent === self.window else { self.shortcutSmokeFail("Discard confirmation not visible") }
                    FileHandle.standardOutput.write(Data("SHORTCUT_DISCARD_CONFIRM_OK\n".utf8))
                    self.window.endSheet(alert.window, returnCode: scenario == "dirty-cancel-q" ? .alertSecondButtonReturn : .alertFirstButtonReturn)
                }
            }
        }
        return .terminateLater
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if terminationApproved { return true }
        NSApp.terminate(nil)
        return false
    }

    func resolveAppRoot() -> String {
        if let resourcePath = Bundle.main.resourcePath {
            let bundledApp = (resourcePath as NSString).appendingPathComponent("app")
            if FileManager.default.fileExists(atPath: (bundledApp as NSString).appendingPathComponent("src/backend/cli.cjs")) {
                return bundledApp
            }
        }
        return FileManager.default.currentDirectoryPath
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installStandardMenus()
        if smokeTestMode {
            DispatchQueue.main.asyncAfter(deadline: .now() + 15.0) {
                FileHandle.standardError.write(Data("Smoke test timed out after 15s\n".utf8))
                self.stopBackend()
                exit(1)
            }
        }
        let appRoot = resolveAppRoot()
        let cliPath = (appRoot as NSString).appendingPathComponent("src/backend/cli.cjs")
        let bridgePath = (appRoot as NSString).appendingPathComponent("platforms/macos/bridge.js")

        let proc = Process()
        let nodePath: String
        do { nodePath = try resolveSupportedNode(appRoot: appRoot) }
        catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
            if smokeTestMode { exit(1) }
            let alert = NSAlert()
            alert.messageText = "アプリを起動できませんでした"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            NSApplication.shared.terminate(nil)
            return
        }
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [cliPath]

        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "NODE_OPTIONS")
        env.removeValue(forKey: "NODE_PATH")
        env["JOB_TRACKER_HOST_BINARY"] = CommandLine.arguments[0]
        proc.environment = env

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        do {
            try proc.run()
            self.backendProcess = proc
        } catch {
            FileHandle.standardError.write(Data("Failed to launch backend: \(error)\n".utf8))
            NSApplication.shared.terminate(nil)
            return
        }

        // Read single JSON startup line from backend
        var lineBuffer = Data()
        let handle = stdoutPipe.fileHandleForReading
        while true {
            let chunk = handle.availableData
            if chunk.isEmpty { break }
            lineBuffer.append(chunk)
            if lineBuffer.contains(0x0A) { break }
        }

        guard let lineStr = String(data: lineBuffer, encoding: .utf8)?.components(separatedBy: "\n").first,
              let jsonData = lineStr.data(using: .utf8),
              let info = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
              let baseUrl = info["url"] as? String else {
            let errData = stderrPipe.fileHandleForReading.availableData
            let errStr = String(data: errData, encoding: .utf8) ?? "unknown"
            FileHandle.standardError.write(Data("Backend failed to report listening URL: \(errStr)\n".utf8))
            stopBackend()
            if !smokeTestMode {
                let alert = NSAlert()
                alert.messageText = "アプリを開けませんでした"
                alert.informativeText = "OS認証をキャンセルした場合は、もう一度起動して認証してください。設定を読み込めない場合も、安全のため起動を停止します。"
                alert.runModal()
            }
            NSApplication.shared.terminate(nil)
            return
        }

        self.allowedOrigin = (info["origin"] as? String) ?? baseUrl
        if let originUrl = URL(string: self.allowedOrigin) {
            self.allowedOriginParts = parseNormalizedOrigin(originUrl)
        }

        let config = WKWebViewConfiguration()
        if smokeTestMode { config.websiteDataStore = .nonPersistent() }
        let contentController = WKUserContentController()
        contentController.add(self, name: "appearance")
        if let bridgeSource = try? String(contentsOfFile: bridgePath, encoding: .utf8) {
            let userScript = WKUserScript(source: bridgeSource, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            contentController.addUserScript(userScript)
        }
        config.userContentController = contentController

        let rect = NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "就活トラッカー"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.hasShadow = true
        window.backgroundColor = NSColor(srgbRed: 254.0 / 255, green: 247.0 / 255, blue: 1, alpha: 1)
        window.minSize = NSSize(width: 360, height: 420)
        window.center()
        window.delegate = self

        webView = WKWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        let content = NSView(frame: rect)
        content.addSubview(webView)
        let dragArea = WindowDragArea(frame: NSRect(x: 0, y: rect.height - 32, width: rect.width, height: 32))
        dragArea.autoresizingMask = [.width, .minYMargin]
        content.addSubview(dragArea)
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        let cleanQuery = initialQuery.hasPrefix("?") ? String(initialQuery.dropFirst()) : initialQuery
        let separator = baseUrl.contains("?") ? "&" : "?"
        let targetUrlString = cleanQuery.isEmpty ? baseUrl : "\(baseUrl)\(separator)\(cleanQuery)"
        if let url = URL(string: targetUrlString) {
            webView.load(URLRequest(url: url))
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "appearance", message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url,
              isAllowedWebViewNavigationURL(url, allowedOrigin: allowedOriginParts),
              let body = message.body as? [String: String],
              let mode = body["mode"], ["light", "dark"].contains(mode),
              let theme = body["theme"], ["system", "light", "dark"].contains(theme) else { return }
        window.appearance = theme == "system" ? nil : NSAppearance(named: mode == "dark" ? .darkAqua : .aqua)
        window.backgroundColor = mode == "dark"
            ? NSColor(srgbRed: 23.0 / 255, green: 19.0 / 255, blue: 28.0 / 255, alpha: 1)
            : NSColor(srgbRed: 254.0 / 255, green: 247.0 / 255, blue: 1, alpha: 1)
        webView.underPageBackgroundColor = window.backgroundColor
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let allowInitialBlank = (navigationAction.navigationType == .other && navigationAction.request.mainDocumentURL == nil)
        if isAllowedWebViewNavigationURL(url, allowedOrigin: allowedOriginParts, isInitialBlankAllowed: allowInitialBlank) {
            decisionHandler(.allow)
            return
        }
        if isSafeExternalHttpsURL(url) {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, isSafeExternalHttpsURL(url) {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame, let url = frame.request.url,
              isAllowedWebViewNavigationURL(url, allowedOrigin: allowedOriginParts, isInitialBlankAllowed: false) else {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        panel.title = "取り込む旧DB・バックアップを選択"
        panel.prompt = "選択"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        if smokeTestMode && CommandLine.arguments.contains("--smoke-test-file-panel"),
           let testDirectory = ProcessInfo.processInfo.environment["JOB_TRACKER_DATA_DIR"] {
            panel.directoryURL = URL(fileURLWithPath: testDirectory, isDirectory: true)
        }
        // Do not filter by UTType: existing SQLite files may use unregistered extensions.
        // The application validates the selected content before permitting import.
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
        if smokeTestMode && CommandLine.arguments.contains("--smoke-test-file-panel") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                guard panel.isVisible, panel.sheetParent === self.window else {
                    FileHandle.standardError.write(Data("File panel did not appear as a sheet\n".utf8))
                    self.stopBackend()
                    exit(1)
                }
                self.filePanelSmokePassed = true
                panel.cancel(nil)
                FileHandle.standardOutput.write(Data("FILE_PANEL_CANCEL_OK\n".utf8))
                if CommandLine.arguments.contains("--smoke-test-dialogs") {
                    webView.evaluateJavaScript("window.confirm('架空データの確認ダイアログテスト')") { result, error in
                        self.confirmSmokePassed = error == nil && (result as? Bool) == false
                    }
                }
            }
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard frame.isMainFrame, let url = frame.request.url,
              isAllowedWebViewNavigationURL(url, allowedOrigin: allowedOriginParts, isInitialBlankAllowed: false) else {
            completionHandler(false)
            return
        }
        let alert = NSAlert()
        alert.messageText = "確認"
        alert.informativeText = message
        alert.addButton(withTitle: "続ける")
        alert.addButton(withTitle: "キャンセル")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
        if smokeTestMode && CommandLine.arguments.contains("--smoke-test-dialogs") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                guard alert.window.isVisible, alert.window.sheetParent === self.window else {
                    self.stopBackend()
                    exit(1)
                }
                self.window.endSheet(alert.window, returnCode: .alertSecondButtonReturn)
                FileHandle.standardOutput.write(Data("CONFIRM_PANEL_CANCEL_OK\n".utf8))
            }
        }
    }

    func runAppearanceSmoke(_ step: Int = 0) {
        if step == 1 && window.appearance?.name != .aqua { shortcutSmokeFail("Light window appearance did not apply") }
        if step == 2 && window.appearance?.name != .darkAqua { shortcutSmokeFail("Dark window appearance did not apply") }
        if step == 3 {
            guard window.appearance == nil else { shortcutSmokeFail("System appearance remained forced") }
            webView.evaluateJavaScript("document.documentElement.dataset.colorMode === (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')") { result, error in
                guard error == nil, result as? Bool == true else { self.shortcutSmokeFail("System web appearance did not follow OS") }
                FileHandle.standardOutput.write(Data("NATIVE_APPEARANCE_LIGHT_DARK_SYSTEM_OK\n".utf8))
                self.stopBackend(); exit(0)
            }
            return
        }
        let theme = ["light", "dark", "system"][step]
        webView.evaluateJavaScript("window.JobTrackerAppearance.apply('\(theme)')") { _, error in
            guard error == nil else { self.shortcutSmokeFail("Appearance script failed") }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.runAppearanceSmoke(step + 1) }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard smokeTestMode else { return }
        if CommandLine.arguments.contains("--smoke-test-appearance") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.runAppearanceSmoke() }
            return
        }
        if let scenario = shortcutSmokeCase {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { self.runShortcutSmoke(scenario) }
            return
        }
        let testFilePanel = CommandLine.arguments.contains("--smoke-test-file-panel")
        if testFilePanel {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                webView.evaluateJavaScript("document.getElementById('btn-data-manage').click(); document.getElementById('dm-import-file').click();", completionHandler: nil)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + (testFilePanel ? 3.0 : 0.9)) {
            if testFilePanel && !self.filePanelSmokePassed {
                FileHandle.standardError.write(Data("File input did not invoke the native panel\n".utf8))
                self.stopBackend()
                exit(1)
            }
            if CommandLine.arguments.contains("--smoke-test-dialogs") && !self.confirmSmokePassed {
                FileHandle.standardError.write(Data("Confirm panel did not return cancellation\n".utf8))
                self.stopBackend()
                exit(1)
            }
            webView.evaluateJavaScript("JSON.stringify({title: document.title, tabs: document.querySelectorAll('.view-tab').length, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, dialogs: [...document.querySelectorAll('[role=dialog]')].map(e => {const r=e.getBoundingClientRect(); const b=e.querySelector('.modal-body'); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,bodyHeight:b?.clientHeight,bodyOverflow:b ? b.scrollWidth > b.clientWidth + 1 : false};})})") { result, error in
                if let error = error {
                    FileHandle.standardError.write(Data("Smoke test JS error: \(error)\n".utf8))
                    self.stopBackend()
                    exit(1)
                }
                let resStr = (result as? String) ?? ""
                guard resStr.contains("就活トラッカー") else {
                    FileHandle.standardError.write(Data("Unexpected title result: \(resStr)\n".utf8))
                    self.stopBackend()
                    exit(1)
                }

                if let snapPath = self.snapshotPath {
                    let snapConfig = WKSnapshotConfiguration()
                    webView.takeSnapshot(with: snapConfig) { image, snapErr in
                        guard snapErr == nil, let image = image,
                           let tiff = image.tiffRepresentation,
                           let rep = NSBitmapImageRep(data: tiff),
                           let png = rep.representation(using: .png, properties: [:]) else {
                            FileHandle.standardError.write(Data("Smoke test snapshot failed: \(String(describing: snapErr))\n".utf8))
                            self.stopBackend()
                            exit(1)
                        }
                        do {
                            try png.write(to: URL(fileURLWithPath: snapPath), options: .atomic)
                        } catch {
                            FileHandle.standardError.write(Data("Smoke test snapshot write failed: \(error)\n".utf8))
                            self.stopBackend()
                            exit(1)
                        }
                        FileHandle.standardOutput.write(Data("SMOKE_TEST_OK:\(resStr)\n".utf8))
                        self.stopBackend()
                        exit(0)
                    }
                } else {
                    FileHandle.standardOutput.write(Data("SMOKE_TEST_OK:\(resStr)\n".utf8))
                    self.stopBackend()
                    exit(0)
                }
            }
        }
    }

    func windowWillClose(_ notification: Notification) {
        stopBackend()
        NSApplication.shared.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopBackend()
        if shortcutSmokeCase != nil {
            FileHandle.standardOutput.write(Data("SHORTCUT_TERMINATE_AND_BACKEND_STOP_OK\n".utf8))
        }
    }

    func stopBackend() {
        if let proc = backendProcess, proc.isRunning {
            proc.terminate()
            proc.waitUntilExit()
        }
        backendProcess = nil
    }
}

let args = CommandLine.arguments
if args.contains("--app-auth-available") { runAppAuthentication(availabilityOnly: true) }
if args.contains("--authenticate-app") { runAppAuthentication(availabilityOnly: false) }
if args.contains("--protect") {
    exit(runProtectCli())
}
if args.contains("--unprotect") {
    exit(runUnprotectCli())
}
if args.contains("--test-origin-policy") {
    exit(runOriginPolicySelfTest())
}
if args.contains("--test-node-resolution") {
    do {
        print(try resolveSupportedNode(appRoot: AppDelegate().resolveAppRoot()))
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
        exit(1)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()

if args.contains("--smoke-test") {
    delegate.smokeTestMode = true
}
if let snapIdx = args.firstIndex(of: "--snapshot"), snapIdx + 1 < args.count {
    delegate.snapshotPath = args[snapIdx + 1]
}
if let queryIdx = args.firstIndex(of: "--url-query"), queryIdx + 1 < args.count {
    delegate.initialQuery = args[queryIdx + 1]
}
if let sizeIdx = args.firstIndex(of: "--size"), sizeIdx + 1 < args.count {
    let parts = args[sizeIdx + 1].split(separator: "x")
    if parts.count == 2, let w = Double(parts[0]), let h = Double(parts[1]) {
        delegate.windowWidth = CGFloat(w)
        delegate.windowHeight = CGFloat(h)
    }
}

app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
