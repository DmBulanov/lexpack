function show(enabled, useSettingsInsteadOfPreferences) {
    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

function checkDownloads() {
    webkit.messageHandlers.controller.postMessage("check-downloads");
}

function showDownloadsStatus(ok, message) {
    const status = document.querySelector(".downloads-status");
    status.textContent = message;
    status.classList.toggle("status-ok", ok);
    status.classList.toggle("status-warning", !ok);
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
document.querySelector("button.check-downloads").addEventListener("click", checkDownloads);
