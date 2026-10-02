// Structural regression fixture from the live online.consultant.ru layout
// inspected on 2026-10-02. Body text is synthetic; no session IDs or case data.
const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const summary = `<div class="page esse"><h2>Справка к документу</h2><p>Источник публикации</p></div>
  <div class="page aiBrief"><p>Подготовлено с использованием искусственного интеллекта</p><h2>Краткий пересказ</h2><p>SUMMARY_ONLY_SENTINEL</p></div>
  <div class="page editions">Отметьте 2 редакции, чтобы сравнить их</div>`;

function documentShell(title, frameUrl) {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${escapeHtml(title)}</title>
  <div class="contextToolbar"><button class="word" onclick="location.href='?native=docx'">Word</button><button class="dots" onclick="location.href='?native=pdf'">Menu</button></div>
  <div class="pageContainer x-page-document-content">${summary}</div>
  <div class="textContainer x-page-document-content visible"><iframe src="${escapeHtml(frameUrl)}"></iframe></div></html>`;
}

function documentFrame(paragraphs, { empty = false, incomplete = false } = {}) {
  return `<!doctype html><html lang="ru"><meta charset="utf-8">
  <div class="rightPanel top">Панель документа</div><div class="scrollbar x-page-document-content">
  <script id="docAccessTemplate" type="text/template">Служебный шаблон</script>
  <div class="document title"><div class="document documentTitle">Аннотация — не текст акта</div><div class="document connectionLost" style="display:none">Нет связи</div></div>
  <div class="document content flat"><div class="zone" id="z0" zone="0" rendered="1">
  ${empty ? "" : paragraphs.map((text, index) => `<div class="U" id="p${index}" parnum="${index}">${escapeHtml(text)}</div>`).join("")}
  <div id="seeAlso" class="U fake">См. также: <a>Краткий пересказ</a></div></div>
  ${incomplete ? '<div class="zone" id="z1" zone="1" rendered="0"></div>' : ""}
  <div class="document banners">BANNER_SENTINEL</div></div>
  <div class="documentLoader" style="display:none"></div><div class="documentConnectionLostContainer"></div></div></html>`;
}

module.exports = { documentShell, documentFrame, summary };
