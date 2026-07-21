import Foundation
import SafariServices
import os.log

private let downloadsBookmarkDefaultsKey = "lexpack.downloads-folder.bookmark"

private struct LexPackNativeError: LocalizedError {
    let code: String
    let message: String

    var errorDescription: String? { message }
}

private struct DownloadEntry: Codable, Equatable {
    let size: Int
    let modifiedAt: TimeInterval
    let isDirectory: Bool
    let isSymbolicLink: Bool

    var stabilityKey: String {
        "\(size):\(modifiedAt):\(isDirectory):\(isSymbolicLink)"
    }
}

private struct DownloadWatch: Codable {
    let token: String
    let folder: String
    let expectedFilename: String
    let expectedExtension: String
    let startedAt: TimeInterval
    let expiresAt: TimeInterval
    let baseline: [String: DownloadEntry]
    var stableCandidate: String?
    var stableKey: String?
    var stableObservations: Int
}

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let fileManager = FileManager.default
    private let logger = Logger(subsystem: "ru.dmbulanov.lexpack.safari", category: "NativeFiles")
    private let watchPrefix = "lexpack.download-watch."
    private let maximumTextBytes = 32 * 1024 * 1024
    private let allowedTextMimes: Set<String> = [
        "text/plain;charset=utf-8",
        "text/html;charset=utf-8",
        "application/json;charset=utf-8",
    ]
    private let allowedExtensions: Set<String> = ["docx", "pdf", "rtf", "txt", "html", "json"]

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]

        let payload: [String: Any]
        do {
            guard let message else {
                throw LexPackNativeError(code: "INVALID_MESSAGE", message: "Пустой запрос LexPack Safari")
            }
            try rememberDownloadsBookmark(from: message)
            let type = message["type"] as? String ?? ""
            logger.debug("Native request: \(type, privacy: .public)")
            payload = try handle(message: message, type: type)
        } catch let error as LexPackNativeError {
            logger.error("Native request failed: \(error.code, privacy: .public)")
            payload = ["ok": false, "code": error.code, "error": error.message]
        } catch {
            logger.error("Native request failed: \(error.localizedDescription, privacy: .public)")
            payload = [
                "ok": false,
                "code": "NATIVE_FILE_ERROR",
                "error": "LexPack Safari не смог обработать файл: \(error.localizedDescription)",
            ]
        }

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    private func handle(message: [String: Any], type: String) throws -> [String: Any] {
        cleanupExpiredWatches()

        switch type {
        case "PING":
            return ["ok": true, "bridgeVersion": 1]
        case "SAVE_TEXT_FILE":
            return try saveTextFile(message)
        case "PREPARE_DOWNLOAD":
            return try prepareDownload(message)
        case "CLAIM_DOWNLOAD":
            return try claimDownload(message)
        case "CANCEL_DOWNLOAD":
            return cancelDownload(message)
        default:
            throw LexPackNativeError(
                code: "UNKNOWN_MESSAGE",
                message: "Неизвестная команда LexPack Safari"
            )
        }
    }

    private func downloadsDirectory() throws -> URL {
        guard let data = UserDefaults.standard.data(forKey: downloadsBookmarkDefaultsKey) else {
            throw LexPackNativeError(
                code: "DOWNLOADS_PERMISSION_REQUIRED",
                message: "Откройте приложение LexPack Safari и выберите папку загрузок Safari"
            )
        }

        do {
            var isStale = false
            let url = try URL(
                resolvingBookmarkData: data,
                options: [.withoutUI],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            ).standardizedFileURL
            let values = try url.resourceValues(
                forKeys: [.isDirectoryKey, .isSymbolicLinkKey]
            )
            guard !isStale, values.isDirectory == true, values.isSymbolicLink != true else {
                throw LexPackNativeError(
                    code: "DOWNLOADS_PERMISSION_REQUIRED",
                    message: "Доступ к папке загрузок устарел. Выберите папку заново в приложении LexPack Safari"
                )
            }
            return url
        } catch let error as LexPackNativeError {
            throw error
        } catch {
            throw LexPackNativeError(
                code: "DOWNLOADS_PERMISSION_REQUIRED",
                message: "Не удалось восстановить доступ к папке загрузок. Выберите папку заново в приложении LexPack Safari"
            )
        }
    }

    private func rememberDownloadsBookmark(from message: [String: Any]) throws {
        guard let encoded = message["downloadsBookmark"] as? String else { return }
        guard encoded.utf8.count <= 1024 * 1024,
              let data = Data(base64Encoded: encoded) else {
            throw LexPackNativeError(
                code: "INVALID_DOWNLOADS_BOOKMARK",
                message: "Safari передал некорректный доступ к папке загрузок"
            )
        }
        UserDefaults.standard.set(data, forKey: downloadsBookmarkDefaultsKey)
    }

    private func sanitizedSegment(_ raw: String) -> String {
        let forbidden = CharacterSet(charactersIn: "<>:\"|?*/\\")
        let mapped = raw.unicodeScalars.map { scalar -> String in
            if scalar.value < 32 || scalar.value == 127 || forbidden.contains(scalar) {
                return "_"
            }
            return String(scalar)
        }.joined()
        var value = mapped.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.last == "." || value.last == " " { value.removeLast() }
        if value == "." || value == ".." { return "" }
        return value
    }

    private func prefix(_ value: String, maximumUTF8Bytes: Int) -> String {
        var result = ""
        var byteCount = 0
        for character in value {
            let bytes = String(character).utf8.count
            if byteCount + bytes > maximumUTF8Bytes { break }
            result.append(character)
            byteCount += bytes
        }
        return result
    }

    private func sanitizedFolder(_ raw: String) -> String {
        let segments = raw
            .replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/")
            .prefix(5)
            .map { prefix(sanitizedSegment(String($0)), maximumUTF8Bytes: 120) }
            .filter { !$0.isEmpty }
        return segments.isEmpty ? "LexPack" : segments.joined(separator: "/")
    }

    private func validatedFilename(_ raw: String) throws -> String {
        let clean = sanitizedSegment(raw)
        guard !clean.isEmpty, clean == raw, URL(fileURLWithPath: clean).lastPathComponent == clean else {
            throw LexPackNativeError(code: "INVALID_FILENAME", message: "Некорректное имя файла")
        }
        let fileExtension = URL(fileURLWithPath: clean).pathExtension.lowercased()
        guard allowedExtensions.contains(fileExtension) else {
            throw LexPackNativeError(code: "INVALID_FILE_TYPE", message: "Неподдерживаемый тип файла")
        }
        let suffix = ".\(fileExtension)"
        let stem = String(clean.dropLast(suffix.count))
        let shortenedStem = prefix(stem, maximumUTF8Bytes: 240 - suffix.utf8.count)
        guard !shortenedStem.isEmpty else {
            throw LexPackNativeError(code: "INVALID_FILENAME", message: "Некорректное имя файла")
        }
        return shortenedStem + suffix
    }

    private func destinationDirectory(folder: String) throws -> URL {
        let downloads = try downloadsDirectory()
        var destination = downloads
        for segment in sanitizedFolder(folder).split(separator: "/") {
            destination.appendPathComponent(String(segment), isDirectory: true)
            if fileManager.fileExists(atPath: destination.path) {
                let values = try destination.resourceValues(
                    forKeys: [.isDirectoryKey, .isSymbolicLinkKey]
                )
                guard values.isDirectory == true, values.isSymbolicLink != true else {
                    throw LexPackNativeError(
                        code: "INVALID_FOLDER",
                        message: "Папка сохранения недоступна"
                    )
                }
            } else {
                try fileManager.createDirectory(
                    at: destination,
                    withIntermediateDirectories: false
                )
            }
        }
        destination = destination.standardizedFileURL
        guard destination.path.hasPrefix(downloads.path + "/") else {
            throw LexPackNativeError(code: "INVALID_FOLDER", message: "Некорректная папка сохранения")
        }
        return destination
    }

    private func uniqueDestination(directory: URL, filename: String) throws -> URL {
        let original = URL(fileURLWithPath: filename)
        let stem = original.deletingPathExtension().lastPathComponent
        let fileExtension = original.pathExtension
        var candidate = directory.appendingPathComponent(filename, isDirectory: false)
        if !fileManager.fileExists(atPath: candidate.path) { return candidate }

        for index in 2...999 {
            let suffix = fileExtension.isEmpty ? "" : ".\(fileExtension)"
            candidate = directory.appendingPathComponent("\(stem) (\(index))\(suffix)")
            if !fileManager.fileExists(atPath: candidate.path) { return candidate }
        }
        throw LexPackNativeError(
            code: "TOO_MANY_CONFLICTS",
            message: "Слишком много файлов с одинаковым именем"
        )
    }

    private func saveTextFile(_ message: [String: Any]) throws -> [String: Any] {
        let folder = sanitizedFolder(message["folder"] as? String ?? "LexPack")
        let filename = try validatedFilename(message["filename"] as? String ?? "")
        let mime = (message["mime"] as? String ?? "").lowercased()
        guard allowedTextMimes.contains(mime) else {
            throw LexPackNativeError(code: "INVALID_MIME", message: "Неподдерживаемый формат текста")
        }
        let content = message["content"] as? String ?? ""
        guard let data = content.data(using: .utf8), data.count <= maximumTextBytes else {
            throw LexPackNativeError(code: "FILE_TOO_LARGE", message: "Файл превышает лимит 32 МБ")
        }

        let directory = try destinationDirectory(folder: folder)
        let target = try uniqueDestination(directory: directory, filename: filename)
        try data.write(to: target, options: .atomic)
        return ["ok": true, "status": "complete", "filename": target.lastPathComponent]
    }

    private func downloadEntries() throws -> [String: DownloadEntry] {
        let keys: Set<URLResourceKey> = [
            .contentModificationDateKey,
            .creationDateKey,
            .fileSizeKey,
            .isDirectoryKey,
            .isSymbolicLinkKey,
        ]
        let urls = try fileManager.contentsOfDirectory(
            at: downloadsDirectory(),
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles]
        )
        var result: [String: DownloadEntry] = [:]
        for url in urls {
            let values = try? url.resourceValues(forKeys: keys)
            let modified = values?.contentModificationDate ?? values?.creationDate ?? .distantPast
            result[url.lastPathComponent] = DownloadEntry(
                size: values?.fileSize ?? 0,
                modifiedAt: modified.timeIntervalSince1970,
                isDirectory: values?.isDirectory ?? false,
                isSymbolicLink: values?.isSymbolicLink ?? false
            )
        }
        return result
    }

    private func prepareDownload(_ message: [String: Any]) throws -> [String: Any] {
        let folder = sanitizedFolder(message["folder"] as? String ?? "LexPack")
        let filename = try validatedFilename(message["filename"] as? String ?? "")
        let fileExtension = URL(fileURLWithPath: filename).pathExtension.lowercased()
        let now = Date().timeIntervalSince1970
        let watch = DownloadWatch(
            token: UUID().uuidString,
            folder: folder,
            expectedFilename: filename,
            expectedExtension: fileExtension,
            startedAt: now,
            expiresAt: now + 180,
            baseline: try downloadEntries(),
            stableCandidate: nil,
            stableKey: nil,
            stableObservations: 0
        )
        try store(watch)
        return ["ok": true, "status": "prepared", "token": watch.token]
    }

    private func claimDownload(_ message: [String: Any]) throws -> [String: Any] {
        let token = message["token"] as? String ?? ""
        var watch = try loadWatch(token: token)
        let entries = try downloadEntries()
        let threshold = watch.startedAt - 3

        func isNewOrChanged(name: String, entry: DownloadEntry) -> Bool {
            entry.modifiedAt >= threshold && watch.baseline[name] != entry
        }

        let inProgress = entries.contains { name, entry in
            name.lowercased().hasSuffix(".download") && isNewOrChanged(name: name, entry: entry)
        }
        let candidates = entries.filter { name, entry in
            URL(fileURLWithPath: name).pathExtension.lowercased() == watch.expectedExtension &&
                !entry.isDirectory &&
                !entry.isSymbolicLink &&
                isNewOrChanged(name: name, entry: entry)
        }

        if candidates.count > 1 {
            return [
                "ok": true,
                "status": "ambiguous",
                "error": "Safari создал несколько файлов подходящего типа; перемещение отменено",
            ]
        }
        guard !inProgress, let candidate = candidates.first else {
            return ["ok": true, "status": "pending"]
        }

        let name = candidate.key
        let stabilityKey = candidate.value.stabilityKey
        if watch.stableCandidate == name && watch.stableKey == stabilityKey {
            watch.stableObservations += 1
        } else {
            watch.stableCandidate = name
            watch.stableKey = stabilityKey
            watch.stableObservations = 1
        }
        if watch.stableObservations < 2 {
            try store(watch)
            return ["ok": true, "status": "pending"]
        }

        let source = try downloadsDirectory().appendingPathComponent(name).standardizedFileURL
        let directory = try destinationDirectory(folder: watch.folder)
        let target = try uniqueDestination(directory: directory, filename: watch.expectedFilename)
        try fileManager.moveItem(at: source, to: target)
        removeWatch(token: token)
        return ["ok": true, "status": "complete", "filename": target.lastPathComponent]
    }

    private func cancelDownload(_ message: [String: Any]) -> [String: Any] {
        let token = message["token"] as? String ?? ""
        removeWatch(token: token)
        return ["ok": true, "status": "cancelled"]
    }

    private func watchKey(_ token: String) -> String { watchPrefix + token }

    private func store(_ watch: DownloadWatch) throws {
        let data = try JSONEncoder().encode(watch)
        UserDefaults.standard.set(data, forKey: watchKey(watch.token))
    }

    private func loadWatch(token: String) throws -> DownloadWatch {
        guard token.count <= 64,
              let data = UserDefaults.standard.data(forKey: watchKey(token)),
              let watch = try? JSONDecoder().decode(DownloadWatch.self, from: data),
              watch.expiresAt >= Date().timeIntervalSince1970 else {
            removeWatch(token: token)
            throw LexPackNativeError(
                code: "DOWNLOAD_WATCH_EXPIRED",
                message: "Наблюдение за загрузкой завершилось; повторите документ"
            )
        }
        return watch
    }

    private func removeWatch(token: String) {
        guard !token.isEmpty else { return }
        UserDefaults.standard.removeObject(forKey: watchKey(token))
    }

    private func cleanupExpiredWatches() {
        let now = Date().timeIntervalSince1970
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix(watchPrefix) {
            guard let data = UserDefaults.standard.data(forKey: key),
                  let watch = try? JSONDecoder().decode(DownloadWatch.self, from: data),
                  watch.expiresAt >= now else {
                UserDefaults.standard.removeObject(forKey: key)
                continue
            }
        }
    }
}
