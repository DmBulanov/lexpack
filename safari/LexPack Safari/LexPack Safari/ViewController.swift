//
//  ViewController.swift
//  LexPack Safari
//
//  Created by Dima on 20.07.2026.
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = "ru.dmbulanov.lexpack.safari.Extension"
let downloadsBookmarkMessageName = "LEXPACK_DOWNLOADS_BOOKMARK"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show(\(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show(\(state.isEnabled), false)")
                }
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let command = message.body as? String else { return }

        switch command {
        case "check-downloads":
            checkDownloadsAccess()
        case "open-preferences":
            SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in
                DispatchQueue.main.async {
                    NSApplication.shared.terminate(nil)
                }
            }
        default:
            return
        }
    }

    private func checkDownloadsAccess() {
        guard let window = view.window else {
            showDownloadsStatus(
                ok: false,
                message: "Не удалось открыть выбор папки. Перезапустите LexPack Safari."
            )
            return
        }

        let panel = NSOpenPanel()
        panel.title = "Выберите папку загрузок Safari"
        panel.message = "Выберите ту же папку, которая указана в Safari → Настройки → Основные → Папка для загрузки файлов."
        panel.prompt = "Выбрать"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.directoryURL = FileManager.default.urls(
            for: .downloadsDirectory,
            in: .userDomainMask
        ).first

        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let selectedDirectory = panel.url else { return }
            self?.storeDownloadsAccess(for: selectedDirectory)
        }
    }

    private func storeDownloadsAccess(for downloads: URL) {
        let fileManager = FileManager.default
        do {
            let values = try downloads.resourceValues(
                forKeys: [.isDirectoryKey, .isSymbolicLinkKey]
            )
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                throw CocoaError(.fileReadUnsupportedScheme)
            }

            let directory = downloads.appendingPathComponent("LexPack", isDirectory: true)
            try fileManager.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            let probe = directory.appendingPathComponent(
                ".lexpack-access-check-\(UUID().uuidString).tmp",
                isDirectory: false
            )
            try Data("LexPack".utf8).write(to: probe, options: .atomic)
            try fileManager.removeItem(at: probe)

            // An implicit security-scoped bookmark transfers the user-granted
            // sandbox extension to the native extension through Safari messaging.
            let bookmark = try downloads.bookmarkData(
                options: [],
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            let messageInfo: [String: Any] = [
                "type": downloadsBookmarkMessageName,
                "bookmark": bookmark.base64EncodedString(),
            ]
            SFSafariApplication.dispatchMessage(
                withName: downloadsBookmarkMessageName,
                toExtensionWithIdentifier: extensionBundleIdentifier,
                userInfo: messageInfo
            ) { [weak self] error in
                DispatchQueue.main.async {
                    if let error {
                        self?.showDownloadsStatus(
                            ok: false,
                            message: "Safari не принял выбранную папку: \(error.localizedDescription). Убедитесь, что расширение LexPack включено, и повторите выбор."
                        )
                    } else {
                        self?.showDownloadsStatus(
                            ok: true,
                            message: "Папка загрузок Safari выбрана: «\(downloads.lastPathComponent)». LexPack сохраняет документы в её подпапку «LexPack»."
                        )
                    }
                }
            }
        } catch {
            showDownloadsStatus(
                ok: false,
                message: "Не удалось сохранить доступ к выбранной папке: \(error.localizedDescription)"
            )
        }
    }

    private func showDownloadsStatus(ok: Bool, message: String) {
        guard let data = try? JSONEncoder().encode(message),
              let quotedMessage = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("showDownloadsStatus(\(ok), \(quotedMessage))")
    }

}
