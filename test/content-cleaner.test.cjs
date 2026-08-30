const assert = require("node:assert/strict");
const test = require("node:test");

const {
  consAssertConsultantTextClean,
  consIsConsultantNote,
  consRemoveConsultantMentions,
  consSerializeConsultantText,
} = require("../extension/shared/content-cleaner.js");

test("brand mention cleanup covers Russian, English, domains, and separator variants", () => {
  const source =
    "КонсультантПлюс | Консультант + | consultant plus | Consultant\u200bPlus | " +
    "консультант＋ | Консультант-Плюс | Consultant—Plus | " +
    "www.consultant.ru | https://consultant.ru | " +
    "https://online.consultant.ru/document | consultant.ru. | " +
    "evilconsultant.ru | consultant.ru.com";
  const result = consRemoveConsultantMentions(source);

  assert.equal(
    result.text,
    " |  |  |  |  |  |  |  |  | /document | . | evilconsultant.ru | consultant.ru.com"
  );
  assert.equal(result.mentionsRemoved, 11);
  assert.equal(result.protectedNotes, 0);
});

test("detached DOM text serialization keeps inline text and structural boundaries", () => {
  const text = (data) => ({ nodeType: 3, data, parentElement: null });
  const element = (name, children = []) => {
    const value = {
      nodeType: 1,
      tagName: name.toUpperCase(),
      id: "",
      className: "",
      childNodes: children,
      parentElement: null,
      querySelectorAll(selector) {
        const descendants = [];
        const visit = (node) => {
          if (node.nodeType !== 1) return;
          descendants.push(node);
          for (const child of node.childNodes) visit(child);
        };
        for (const child of this.childNodes) visit(child);
        if (selector === "*") return descendants;
        return [];
      },
    };
    Object.defineProperty(value, "textContent", {
      get() {
        return this.childNodes
          .map((child) =>
            child.nodeType === 3 ? child.data : child.textContent || ""
          )
          .join("");
      },
    });
    for (const child of children) child.parentElement = value;
    return value;
  };

  const alpha = text("Alpha ");
  const bold = element("strong", [text("bold")]);
  const root = element("div", [
    element("p", [alpha, bold]),
    text("\n  "),
    element("p", [text("Beta"), element("br"), text("Gamma")]),
  ]);

  assert.equal(consSerializeConsultantText(root), "Alpha bold\n\nBeta\nGamma");
  assert.equal(alpha.data, "Alpha ");
});

test("note recognition is separate from context-free title and attribute cleanup", () => {
  const source =
    "Консультант\u00a0Плюс : примечание. Ссылка на КонсультантПлюс остаётся **как есть**.";
  const result = consRemoveConsultantMentions(source);

  assert.equal(consIsConsultantNote(source), true);
  assert.equal(result.text, " : примечание. Ссылка на  остаётся **как есть**.");
  assert.equal(result.mentionsRemoved, 2);
  assert.equal(result.protectedNotes, 0);
});

test("a note marker in the middle of an ordinary paragraph is not an exception", () => {
  const source = "См. КонсультантПлюс: примечание в процитированном документе";
  const result = consRemoveConsultantMentions(source);

  assert.equal(consIsConsultantNote(source), false);
  assert.equal(result.text, "См. : примечание в процитированном документе");
  assert.equal(result.mentionsRemoved, 1);
});

test("the ordinary Russian word consultant is not removed", () => {
  const source = "Юридический консультант подготовил заключение";
  assert.equal(consRemoveConsultantMentions(source).text, source);
});

test("immutable TXT and Markdown validation permits brands only in a marked note block", () => {
  const clean =
    "# Заголовок\r\n\r\nОбычный текст без бренда.\r\n\r\n" +
    "> КонсультантПлюс: примечание.\r\nВнутри остаются КонсультантПлюс и consultant.ru.\r\n";

  assert.equal(consAssertConsultantTextClean(clean), clean);
  assert.throws(
    () =>
      consAssertConsultantTextClean(
        "Обычный КонсультантПлюс и видимый https://www.consultant.ru"
      ),
    (error) => error.code === "CONTENT_CLEANUP_INCOMPLETE"
  );
  assert.throws(
    () =>
      consAssertConsultantTextClean(
        "КонсультантПлюс: примечание. Разрешено.\n\nОбычный Consultant Plus"
      ),
    (error) => error.code === "CONTENT_CLEANUP_INCOMPLETE"
  );
  assert.throws(
    () =>
      consAssertConsultantTextClean(
        "КонсультантПлюс: примечание. Разрешено.\n# Обычный КонсультантПлюс"
      ),
    (error) => error.code === "CONTENT_CLEANUP_INCOMPLETE"
  );
  assert.throws(
    () =>
      consAssertConsultantTextClean(
        "КонсультантПлюс: примечание. Разрешено.\r\rОбычный Consultant Plus"
      ),
    (error) => error.code === "CONTENT_CLEANUP_INCOMPLETE"
  );
  for (const ordinaryBlock of [
    "<script>Обычный КонсультантПлюс</script>",
    "<!-- Обычный Consultant Plus -->",
    "</div> Обычный online.consultant.ru",
  ]) {
    assert.throws(
      () =>
        consAssertConsultantTextClean(
          `КонсультантПлюс: примечание. Разрешено.\n${ordinaryBlock}`
        ),
      (error) => error.code === "CONTENT_CLEANUP_INCOMPLETE"
    );
  }
  for (const noteContinuation of [
    "<span>КонсультантПлюс</span>",
    "<span>\nКонсультантПлюс\n</span>",
    "< 5% по данным КонсультантПлюс",
  ]) {
    const note = `КонсультантПлюс: примечание. Разрешено.\n${noteContinuation}`;
    assert.equal(consAssertConsultantTextClean(note), note);
  }
});
