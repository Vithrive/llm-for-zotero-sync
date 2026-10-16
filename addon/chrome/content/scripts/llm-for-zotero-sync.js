var LlmForZoteroSync = (() => {
  const PLUGIN_NAME = "LLM for Zotero Sync";
  const PREF_BRANCH = "extensions.llm-for-zotero-sync.";
  // 旧插件名（MinerU Markdown Sync）下的偏好分支：仅作兜底读取，
  // 保证改名后旧版本已配置的 workdirRoot / managedTitle 不会丢失。
  const LEGACY_PREF_BRANCH = "extensions.mineru-markdown-sync.";
  const DEFAULT_WORKDIR_ROOT = "V:\\Zotero\\llm-for-zotero-mineru";
  const DEFAULT_MANAGED_TITLE = "LLM for Zotero Sync（自动维护）";
  const MANAGED_MARKER = 'data-llm-for-zotero-sync="1"';
  // 旧版插件写入笔记的标记：识别旧笔记时仍然接受，避免重复建笔记
  const LEGACY_MANAGED_MARKER = 'data-mineru-markdown-sync="1"';
  const READER_BUTTON_ID = "llm-for-zotero-sync-reader-button";
  const READER_STYLE_ID = "llm-for-zotero-sync-reader-style";
  const ITEM_MENU_ID = "llm-for-zotero-sync-item-menu";
  const TOOLS_MENU_ID = "llm-for-zotero-sync-tools-menu";
  const BUTTON_LABEL = "同步 MinerU";
  const PLUGIN_ID = "llm-for-zotero-sync@cszr";
  const RENDER_TOOLBAR_PROBE_TIMEOUT = 25000;
  const MAX_MARKDOWN_CHARS = 200000;

  const state = {
    windows: new Map(),
    intervalID: null,
    busyKeys: new Set(),
  };

  function log(message, error) {
    if (error) {
      Zotero.debug("[LLM for Zotero Sync] " + message + " :: " + error);
      return;
    }
    Zotero.debug("[LLM for Zotero Sync] " + message);
  }

  function htmlEscape(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function leafName(path) {
    return String(path || "").split(/[\\/]/).pop() || "";
  }

  function removeMarkdownExtension(name) {
    return String(name || "").replace(/\.md$/i, "");
  }

  function getStringPref(name, fallbackValue) {
    // 先读新分支；读不到再回退到旧分支（LEGACY_PREF_BRANCH），避免改名丢配置。
    for (const branch of [PREF_BRANCH, LEGACY_PREF_BRANCH]) {
      try {
        const value = Zotero.Prefs.get(branch + name, true);
        if (typeof value === "string" && value.trim()) {
          return value.trim();
        }
      } catch (error) {
        log("读取偏好设置失败: " + name, error);
      }
    }
    return fallbackValue;
  }

  function getWorkdirRoot() {
    return getStringPref("workdirRoot", DEFAULT_WORKDIR_ROOT);
  }

  function getManagedTitle() {
    return getStringPref("managedTitle", DEFAULT_MANAGED_TITLE);
  }

  function notify(title, lines) {
    const messages = Array.isArray(lines) ? lines : [lines];
    try {
      const progress = new Zotero.ProgressWindow();
      progress.changeHeadline(title);
      for (const line of messages) {
        progress.addDescription(String(line));
      }
      progress.show();
      progress.startCloseTimer(5000);
      return;
    } catch (error) {
      log("ProgressWindow 不可用", error);
    }

    try {
      Zotero.alert(null, title, messages.join("\n"));
    } catch (error) {
      log("Zotero.alert 不可用", error);
    }
  }

  function toFile(path) {
    const file = Components.classes["@mozilla.org/file/local;1"].createInstance(
      Components.interfaces.nsIFile,
    );
    file.initWithPath(path);
    return file;
  }

  function pathExists(path) {
    try {
      return toFile(path).exists();
    } catch (error) {
      return false;
    }
  }

  function isDirectory(path) {
    try {
      const file = toFile(path);
      return file.exists() && file.isDirectory();
    } catch (error) {
      return false;
    }
  }

  function joinPath(basePath, childName) {
    const normalizedBase = String(basePath || "").replace(/[\\/]+$/, "");
    const normalizedChild = String(childName || "").replace(/[\\/]+/g, "\\");
    return normalizedBase + "\\" + normalizedChild;
  }

  function resolveRelativePath(basePath, relativePath) {
    if (!relativePath) {
      return null;
    }
    if (/^[a-zA-Z]:[\\/]/.test(relativePath)) {
      return relativePath.replace(/\//g, "\\");
    }
    return joinPath(basePath, relativePath);
  }

  function getImageMimeType(path) {
    const lowerPath = String(path || "").toLowerCase();
    if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg") || lowerPath.endsWith(".jpe") || lowerPath.endsWith(".jfif")) {
      return "image/jpeg";
    }
    if (lowerPath.endsWith(".png")) {
      return "image/png";
    }
    if (lowerPath.endsWith(".gif")) {
      return "image/gif";
    }
    if (lowerPath.endsWith(".webp")) {
      return "image/webp";
    }
    if (lowerPath.endsWith(".bmp")) {
      return "image/bmp";
    }
    if (lowerPath.endsWith(".svg")) {
      return "image/svg+xml";
    }
    return "application/octet-stream";
  }

  function stripFrontMatter(text) {
    if (text.startsWith("---\n")) {
      const end = text.indexOf("\n---\n", 4);
      if (end !== -1) {
        return text.slice(end + 5);
      }
    }
    return text;
  }

  function markdownSortKey(path) {
    const lowerName = leafName(path).toLowerCase();
    if (lowerName === "full.md") {
      return [0, lowerName];
    }
    if (lowerName.endsWith(".zh.md")) {
      return [1, lowerName];
    }
    return [2, lowerName];
  }

  function listFiles(workdirPath, predicate) {
    if (!isDirectory(workdirPath)) {
      return [];
    }

    const directory = toFile(workdirPath);
    const entries = directory.directoryEntries;
    const output = [];
    while (entries.hasMoreElements()) {
      const entry = entries.getNext().QueryInterface(Components.interfaces.nsIFile);
      if (!entry.isFile()) {
        continue;
      }
      if (!predicate(entry)) {
        continue;
      }
      output.push(entry.path);
    }
    return output;
  }

  function listMarkdownFiles(workdirPath) {
    const output = listFiles(workdirPath, (entry) => entry.leafName.toLowerCase().endsWith(".md"));
    output.sort((a, b) => {
      const left = markdownSortKey(a);
      const right = markdownSortKey(b);
      if (left[0] !== right[0]) {
        return left[0] - right[0];
      }
      return left[1].localeCompare(right[1]);
    });
    return output;
  }

  function listContentListFiles(workdirPath) {
    const output = listFiles(workdirPath, (entry) => /_content_list\.json$/i.test(entry.leafName));
    output.sort((a, b) => leafName(a).localeCompare(leafName(b)));
    return output;
  }

  async function readTextFile(path) {
    try {
      return String(await Zotero.File.getContentsAsync(path));
    } catch (error) {
      log("读取文本失败: " + path, error);
      throw error;
    }
  }

  async function readMarkdownText(path) {
    return (await readTextFile(path)).slice(0, MAX_MARKDOWN_CHARS);
  }

  async function readJSONFile(path) {
    return JSON.parse(await readTextFile(path));
  }

  function findContentListForMarkdown(markdownPath, contentListFiles) {
    const markdownName = leafName(markdownPath);
    const stem = removeMarkdownExtension(markdownName);
    const exactName = stem + "_content_list.json";
    const exact = contentListFiles.find((path) => leafName(path).toLowerCase() === exactName.toLowerCase());
    if (exact) {
      return exact;
    }

    if (markdownName.toLowerCase() === "full.md" && contentListFiles.length === 1) {
      return contentListFiles[0];
    }

    if (/\.zh$/i.test(stem)) {
      const originalStem = stem.replace(/\.zh$/i, "");
      const originalName = originalStem + "_content_list.json";
      const original = contentListFiles.find((path) => leafName(path).toLowerCase() === originalName.toLowerCase());
      if (original) {
        return original;
      }
    }

    return null;
  }

  function isPDFAttachment(item) {
    if (!item) {
      return false;
    }
    try {
      if (typeof item.isPDFAttachment === "function") {
        return item.isPDFAttachment();
      }
    } catch (error) {
      log("检查 PDF 附件失败", error);
    }

    const contentType = String(item.attachmentContentType || "").toLowerCase();
    const filename = String(item.attachmentFilename || "").toLowerCase();
    return contentType === "application/pdf" || filename.endsWith(".pdf");
  }

  async function getReaderItem(reader) {
    if (!reader) {
      return null;
    }
    if (reader.item) {
      return reader.item;
    }
    if (reader._item) {
      return reader._item;
    }
    if (reader._itemID) {
      try {
        return await Zotero.Items.getAsync(reader._itemID);
      } catch (error) {
        log("读取阅读器条目失败", error);
      }
    }
    return null;
  }

  async function getPDFAttachmentsFromItem(item) {
    if (!item) {
      return [];
    }

    if (typeof item.isAttachment === "function" && item.isAttachment()) {
      return isPDFAttachment(item) ? [item] : [];
    }

    if (!(typeof item.isRegularItem === "function" && item.isRegularItem())) {
      return [];
    }

    const attachmentIDs = typeof item.getAttachments === "function" ? item.getAttachments() : [];
    if (!attachmentIDs.length) {
      return [];
    }

    const attachments = await Zotero.Items.getAsync(attachmentIDs);
    return attachments.filter((attachment) => isPDFAttachment(attachment));
  }

  async function getParentItemForAttachment(attachment) {
    const parentID = attachment.parentID || attachment.parentItemID;
    if (!parentID) {
      return null;
    }
    return await Zotero.Items.getAsync(parentID);
  }

  async function buildMarkdownRecordsForAttachment(attachment) {
    const parentItem = await getParentItemForAttachment(attachment);
    if (!parentItem) {
      return [];
    }

    const workdirPath = joinPath(getWorkdirRoot(), String(attachment.id));
    const markdownFiles = listMarkdownFiles(workdirPath);
    const contentListFiles = listContentListFiles(workdirPath);
    const attachmentFilePath = await attachment.getFilePathAsync();

    return Promise.all(
      markdownFiles.map(async (markdownPath) => {
        const markdownText = await readMarkdownText(markdownPath);
        const contentListPath = findContentListForMarkdown(markdownPath, contentListFiles);
        return {
          parentItem,
          attachment,
          attachmentFilePath,
          workdirPath,
          markdownPath,
          markdownName: leafName(markdownPath),
          markdownText,
          contentListPath,
        };
      }),
    );
  }

  function buildSourceMarker(record) {
    return [
      MANAGED_MARKER,
      'data-mineru-attachment-id="' + htmlEscape(record.attachment.id) + '"',
      'data-mineru-source-file="' + htmlEscape(record.markdownName) + '"',
    ].join(" ");
  }

  async function getChildAttachments(item) {
    const attachmentIDs = typeof item.getAttachments === "function" ? item.getAttachments() : [];
    if (!attachmentIDs || !attachmentIDs.length) {
      return [];
    }
    return await Zotero.Items.getAsync(attachmentIDs);
  }

  async function findManagedNotesForSource(parentItem, record) {
    const noteIDs = typeof parentItem.getNotes === "function" ? parentItem.getNotes() : [];
    if (!noteIDs.length) {
      return [];
    }

    const notes = await Zotero.Items.getAsync(noteIDs);
    const attachmentMarker = 'data-mineru-attachment-id="' + record.attachment.id + '"';
    const sourceMarker = 'data-mineru-source-file="' + htmlEscape(record.markdownName) + '"';
    return notes.filter((note) => {
      try {
        const html = String(note.getNote() || "");
        return (html.includes(MANAGED_MARKER) || html.includes(LEGACY_MANAGED_MARKER)) && html.includes(attachmentMarker) && html.includes(sourceMarker);
      } catch (error) {
        return false;
      }
    });
  }

  async function ensureManagedNote(parentItem, record) {
    const managedNotes = await findManagedNotesForSource(parentItem, record);
    if (managedNotes.length) {
      return {
        note: managedNotes[0],
        action: "updated",
        duplicateCount: Math.max(0, managedNotes.length - 1),
      };
    }

    const note = new Zotero.Item("note");
    note.libraryID = parentItem.libraryID;
    note.parentID = parentItem.id;
    note.setNote("<p>初始化中...</p>");
    await note.saveTx();
    return {
      note,
      action: "created",
      duplicateCount: 0,
    };
  }

  async function resolveImportedAttachment(result) {
    if (!result) {
      return null;
    }
    if (typeof result.getField === "function") {
      return result;
    }
    if (typeof result === "number") {
      return await Zotero.Items.getAsync(result);
    }
    if (Array.isArray(result) && result.length) {
      return await resolveImportedAttachment(result[0]);
    }
    if (result.itemID) {
      return await Zotero.Items.getAsync(result.itemID);
    }
    if (result.id) {
      return await Zotero.Items.getAsync(result.id);
    }
    return null;
  }

  function readBinaryFile(path) {
    const file = toFile(path);
    const input = Components.classes["@mozilla.org/network/file-input-stream;1"].createInstance(Components.interfaces.nsIFileInputStream);
    const binaryInput = Components.classes["@mozilla.org/binaryinputstream;1"].createInstance(Components.interfaces.nsIBinaryInputStream);
    try {
      input.init(file, -1, -1, false);
      binaryInput.setInputStream(input);
      return binaryInput.readBytes(binaryInput.available());
    } finally {
      try {
        binaryInput.close();
      } catch (_error) {}
      try {
        input.close();
      } catch (_error) {}
    }
  }

  function filePathToBlob(filePath) {
    const bytes = readBinaryFile(filePath);
    const mimeType = getImageMimeType(filePath);
    const array = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) {
      array[index] = bytes.charCodeAt(index) & 0xff;
    }
    return new Blob([array], { type: mimeType });
  }

  async function findExistingImageAttachment(noteItem, filePath) {
    const title = leafName(filePath);
    const normalizedTitle = title.toLowerCase();
    const attachments = await getChildAttachments(noteItem);
    for (const attachment of attachments) {
      if (!attachment?.isEmbeddedImageAttachment?.()) {
        continue;
      }
      const currentNames = [
        String(attachment.getField?.("title") || "").toLowerCase(),
        String(attachment.attachmentFilename || "").toLowerCase(),
      ];
      if (currentNames.includes(normalizedTitle)) {
        return attachment;
      }
    }
    return null;
  }

  async function importImageAttachment(noteItem, filePath) {
    const existing = await findExistingImageAttachment(noteItem, filePath);
    if (existing) {
      return existing;
    }

    if (typeof Zotero.Attachments.importEmbeddedImage === "function") {
      const blob = filePathToBlob(filePath);
      const result = await Zotero.Attachments.importEmbeddedImage({
        blob,
        parentItemID: noteItem.id,
      });
      const attachment = await resolveImportedAttachment(result);
      if (attachment) {
        attachment.setField?.("title", leafName(filePath));
        await attachment.saveTx?.();
        return attachment;
      }
    }

    const file = toFile(filePath);
    const result = await Zotero.Attachments.importFromFile({
      file,
      parentItemID: noteItem.id,
      libraryID: noteItem.libraryID,
      title: leafName(filePath),
      contentType: getImageMimeType(filePath),
    });
    return resolveImportedAttachment(result);
  }

  function normalizeMathContent(text) {
    let content = String(text || "").trim();
    if (!content) {
      return "";
    }
    if (!content.startsWith("$$")) {
      content = "$$\n" + content + "\n$$";
    }
    return content;
  }

  function renderMathBlock(text) {
    const content = normalizeMathContent(text);
    if (!content) {
      return "";
    }
    return "<pre class=\"math\">" + htmlEscape(content) + "</pre>";
  }

  function markdownInlineToHTML(text) {
    const placeholders = [];
    function push(html) {
      const index = placeholders.push(html) - 1;
      return "@@MINERU_INLINE_" + index + "@@";
    }

    let value = String(text || "");
    value = value.replace(/`([^`]+)`/g, (_match, code) => push("<code>" + htmlEscape(code) + "</code>"));
    value = value.replace(/\$([^$\n]+)\$/g, (_match, expr) => push("<span class=\"math\">" + htmlEscape("$" + expr + "$") + "</span>"));
    value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => push("<a href=\"" + htmlEscape(href) + "\">" + htmlEscape(label) + "</a>"));

    let escaped = htmlEscape(value);
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    escaped = escaped.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    escaped = escaped.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");

    escaped = escaped.replace(/@@MINERU_INLINE_(\d+)@@/g, (_match, index) => placeholders[Number(index)] || "");
    return escaped;
  }

  function renderParagraph(text) {
    const content = String(text || "").trim();
    if (!content) {
      return "";
    }
    return "<p>" + markdownInlineToHTML(content) + "</p>";
  }

  function renderLinesAsParagraphs(lines) {
    const output = [];
    for (const line of lines || []) {
      const html = renderParagraph(line);
      if (html) {
        output.push(html);
      }
    }
    return output.join("");
  }

  function renderEmbeddedImageTag(attachment, filePath) {
    const key = htmlEscape(attachment.key);
    const filename = htmlEscape(leafName(filePath) || attachment.getField?.("title") || attachment.attachmentFilename || key);
    return (
      "<p><img alt=\"" +
      filename +
      "\" data-attachment-key=\"" +
      key +
      "\" style=\"display:block;max-width:100%;height:auto;object-fit:contain;margin:0.5em auto;\"></p>"
    );
  }

  function renderImageReference(filePath, label) {
    return (
      "<p>图片未能嵌入为 Zotero 笔记图片附件，已保留源文件引用：<code>" +
      htmlEscape(filePath) +
      "</code></p><p>图片文件名：" +
      htmlEscape(String(label || leafName(filePath))) +
      "</p>"
    );
  }

  async function renderImageBlock(noteItem, basePath, relativeImagePath, captionLines, footnoteLines) {
    const fullPath = resolveRelativePath(basePath, relativeImagePath);
    const output = [];
    if (!fullPath || !pathExists(fullPath)) {
      output.push(renderParagraph("图片文件不存在：" + String(relativeImagePath || "")));
      output.push(renderLinesAsParagraphs(captionLines));
      output.push(renderLinesAsParagraphs(footnoteLines));
      return output.join("");
    }

    try {
      const attachment = await importImageAttachment(noteItem, fullPath);
      if (attachment?.key) {
        output.push(renderEmbeddedImageTag(attachment, fullPath));
      } else {
        output.push(renderImageReference(fullPath, relativeImagePath || leafName(fullPath)));
      }
    } catch (error) {
      log("渲染图片块失败: " + fullPath, error);
      output.push(renderImageReference(fullPath, relativeImagePath || leafName(fullPath)));
    }

    output.push(renderLinesAsParagraphs(captionLines));
    output.push(renderLinesAsParagraphs(footnoteLines));
    return output.join("");
  }

  function renderTableBlock(tableBody, captionLines, footnoteLines) {
    const output = [];
    output.push(renderLinesAsParagraphs(captionLines));
    if (tableBody) {
      output.push(String(tableBody));
    }
    output.push(renderLinesAsParagraphs(footnoteLines));
    return output.join("");
  }

  async function renderEquationBlock(noteItem, basePath, block) {
    const output = [];
    if (block.text && String(block.text).trim()) {
      output.push(renderMathBlock(block.text));
      return output.join("");
    }
    if (block.img_path) {
      output.push(await renderImageBlock(noteItem, basePath, block.img_path, [], []));
    }
    return output.join("");
  }

  async function renderContentListBody(noteItem, record) {
    if (!record.contentListPath) {
      return "";
    }

    const blocks = await readJSONFile(record.contentListPath);
    if (!Array.isArray(blocks) || !blocks.length) {
      return "";
    }

    const output = [];
    for (const block of blocks) {
      const type = String(block?.type || "");
      if (type === "discarded") {
        continue;
      }
      if (type === "text") {
        const text = String(block.text || "").trim();
        if (!text) {
          continue;
        }
        const level = Number(block.text_level || 0);
        if (level > 0) {
          const headingLevel = Math.max(1, Math.min(6, level));
          output.push("<h" + headingLevel + ">" + markdownInlineToHTML(text) + "</h" + headingLevel + ">");
        } else {
          output.push(renderParagraph(text));
        }
        continue;
      }
      if (type === "image") {
        output.push(
          await renderImageBlock(
            noteItem,
            record.workdirPath,
            block.img_path,
            Array.isArray(block.image_caption) ? block.image_caption : [],
            Array.isArray(block.image_footnote) ? block.image_footnote : [],
          ),
        );
        continue;
      }
      if (type === "equation") {
        output.push(await renderEquationBlock(noteItem, record.workdirPath, block));
        continue;
      }
      if (type === "table") {
        output.push(
          renderTableBlock(
            block.table_body,
            Array.isArray(block.table_caption) ? block.table_caption : [],
            Array.isArray(block.table_footnote) ? block.table_footnote : [],
          ),
        );
      }
    }
    return output.join("");
  }

  async function renderMarkdownBody(noteItem, record) {
    const text = stripFrontMatter(String(record.markdownText || "").replace(/\r\n/g, "\n")).trim();
    if (!text) {
      return "<p>Markdown 文件为空。</p>";
    }

    const lines = text.split("\n");
    const output = [];
    let paragraphLines = [];
    let listItems = [];
    let codeLines = [];
    let mathLines = [];
    let tableLines = [];
    let inCode = false;
    let inMath = false;
    let inTable = false;

    async function flushParagraph() {
      if (!paragraphLines.length) {
        return;
      }
      const content = paragraphLines.map((line) => line.trim()).filter(Boolean).join(" ");
      if (content) {
        output.push(renderParagraph(content));
      }
      paragraphLines = [];
    }

    async function flushList() {
      if (!listItems.length) {
        return;
      }
      output.push("<ul>");
      for (const item of listItems) {
        output.push("<li>" + markdownInlineToHTML(item) + "</li>");
      }
      output.push("</ul>");
      listItems = [];
    }

    async function flushCode() {
      if (!codeLines.length) {
        return;
      }
      output.push("<pre>" + htmlEscape(codeLines.join("\n")) + "</pre>");
      codeLines = [];
    }

    async function flushMath() {
      if (!mathLines.length) {
        return;
      }
      output.push(renderMathBlock(mathLines.join("\n")));
      mathLines = [];
    }

    async function flushTable() {
      if (!tableLines.length) {
        return;
      }
      output.push(tableLines.join("\n"));
      tableLines = [];
    }

    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index];
      const line = rawLine.replace(/\s+$/, "");
      const stripped = line.trim();

      if (inCode) {
        if (stripped.startsWith("```")) {
          inCode = false;
          await flushCode();
        } else {
          codeLines.push(line);
        }
        continue;
      }

      if (inMath) {
        if (stripped === "$$") {
          inMath = false;
          await flushMath();
        } else {
          mathLines.push(line);
        }
        continue;
      }

      if (inTable) {
        tableLines.push(line);
        if (/<\/table>/i.test(line)) {
          inTable = false;
          await flushTable();
        }
        continue;
      }

      if (!stripped) {
        await flushParagraph();
        await flushList();
        continue;
      }

      if (stripped.startsWith("```")) {
        await flushParagraph();
        await flushList();
        inCode = true;
        continue;
      }

      if (stripped === "$$") {
        await flushParagraph();
        await flushList();
        inMath = true;
        continue;
      }

      if (/^\$\$.*\$\$$/.test(stripped) && stripped.length > 4) {
        await flushParagraph();
        await flushList();
        output.push(renderMathBlock(stripped));
        continue;
      }

      if (/^<table/i.test(stripped)) {
        await flushParagraph();
        await flushList();
        tableLines.push(line);
        if (/<\/table>/i.test(stripped)) {
          await flushTable();
        } else {
          inTable = true;
        }
        continue;
      }

      const imageMatch = stripped.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
      if (imageMatch) {
        await flushParagraph();
        await flushList();
        output.push(await renderImageBlock(noteItem, record.workdirPath, imageMatch[2], [], []));
        continue;
      }

      const headingMatch = stripped.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        await flushParagraph();
        await flushList();
        const level = Math.min(headingMatch[1].length, 6);
        output.push("<h" + level + ">" + markdownInlineToHTML(headingMatch[2].trim()) + "</h" + level + ">");
        continue;
      }

      const listMatch = stripped.match(/^[-*+]\s+(.*)$/);
      if (listMatch) {
        await flushParagraph();
        listItems.push(listMatch[1].trim());
        continue;
      }

      if (stripped === "---") {
        await flushParagraph();
        await flushList();
        output.push("<hr>");
        continue;
      }

      paragraphLines.push(line);
    }

    await flushParagraph();
    await flushList();
    await flushCode();
    await flushMath();
    await flushTable();
    return output.join("");
  }

  function shouldPreferContentList(record) {
    if (!record.contentListPath) {
      return false;
    }
    return !/\.zh\.md$/i.test(record.markdownName);
  }

  function renderLocalPath(text, path) {
    return "<p>" + htmlEscape(text) + "：<code>" + htmlEscape(path) + "</code></p>";
  }

  async function renderManagedNoteHTML(noteItem, record) {
    const managedTitle = getManagedTitle();
    const parentTitle = record.parentItem.getField("title") || "";
    const output = [];
    const metadata = [];

    const body = shouldPreferContentList(record)
      ? await renderContentListBody(noteItem, record)
      : await renderMarkdownBody(noteItem, record);
    output.push(body || "<p>未生成正文内容。</p>");

    metadata.push("<p><strong>" + htmlEscape(managedTitle) + "</strong></p>");
    metadata.push("<p><span " + buildSourceMarker(record) + "></span>此笔记由插件自动维护，来源于 MinerU 解析文件。</p>");
    metadata.push(renderLocalPath("源 Markdown", record.markdownPath));
    if (record.contentListPath) {
      metadata.push(renderLocalPath("结构化来源", record.contentListPath));
    }
    if (record.attachmentFilePath && pathExists(record.attachmentFilePath)) {
      metadata.push(renderLocalPath("PDF 文件", record.attachmentFilePath));
    }
    if (isDirectory(record.workdirPath)) {
      metadata.push(renderLocalPath("解析目录", record.workdirPath));
    }
    if (parentTitle) {
      metadata.push("<p>父条目：" + htmlEscape(parentTitle) + "</p>");
    }

    output.push("<hr>");
    output.push(metadata.join(""));
    return output.join("");
  }

  async function upsertManagedNote(parentItem, record) {
    const ensured = await ensureManagedNote(parentItem, record);
    try {
      const noteHTML = await renderManagedNoteHTML(ensured.note, record);
      ensured.note.setNote(noteHTML);
      await ensured.note.saveTx();
      return ensured;
    } catch (error) {
      log("写入受管笔记失败: " + record.markdownName, error);
      ensured.note.setNote(
        "<p><strong>同步失败</strong></p>" +
          "<p>源 Markdown：" + htmlEscape(record.markdownName) + "</p>" +
          "<p>错误信息：" + htmlEscape(error?.message || String(error)) + "</p>",
      );
      await ensured.note.saveTx();
      throw error;
    }
  }

  async function syncFromItem(item) {
    const attachments = await getPDFAttachmentsFromItem(item);
    if (!attachments.length) {
      throw new Error("当前条目没有可同步的 PDF 附件。");
    }

    const results = [];
    for (const attachment of attachments) {
      const records = await buildMarkdownRecordsForAttachment(attachment);
      for (const record of records) {
        const result = await upsertManagedNote(record.parentItem, record);
        results.push({
          parentItem: record.parentItem,
          record,
          result,
        });
      }
    }

    if (!results.length) {
      throw new Error("未找到任何可同步的 Markdown 文件。");
    }

    return results;
  }

  async function syncFromReader(reader, button) {
    const item = await getReaderItem(reader);
    if (!item) {
      throw new Error("无法识别当前阅读器对应的条目。");
    }
    return await runSync(item, button);
  }

  async function runSync(item, button) {
    const itemKey = String(item.id || item.key || Math.random());
    if (state.busyKeys.has(itemKey)) {
      notify("MinerU 同步", "当前条目正在同步，请稍候。");
      return null;
    }

    state.busyKeys.add(itemKey);
    setButtonState(button, true);
    try {
      const results = await syncFromItem(item);
      const lines = [];
      for (const entry of results) {
        const title = entry.parentItem.getField("title") || ("条目 " + entry.parentItem.id);
        const source = entry.record.markdownName;
        let line = title + " / " + source + "：" + (entry.result.action === "created" ? "已创建受管笔记" : "已更新受管笔记");
        if (entry.result.duplicateCount) {
          line += "（发现额外重复受管笔记 " + entry.result.duplicateCount + " 条，未改动）";
        }
        lines.push(line);
      }
      notify("MinerU 同步完成", lines);
      return results;
    } catch (error) {
      notify("MinerU 同步失败", error.message || String(error));
      throw error;
    } finally {
      state.busyKeys.delete(itemKey);
      setButtonState(button, false);
    }
  }

  function setButtonState(button, busy) {
    if (!button) {
      return;
    }
    button.disabled = !!busy;
    button.textContent = busy ? "同步中..." : BUTTON_LABEL;
    button.title = busy
      ? "MinerU 同步进行中，请稍候"
      : "把当前 PDF 对应的 MinerU Markdown 同步到条目笔记";
  }

  function ensureReaderStyle(doc) {
    if (doc.getElementById(READER_STYLE_ID)) {
      return;
    }
    const style = doc.createElement("style");
    style.id = READER_STYLE_ID;
    // 按钮不做绝对/固定定位。工具栏右侧分组 .end（justify-content:flex-end）自带右对齐，
    // 插进它内部的 .custom-sections 后位置由工具栏布局决定，不随窗口缩放、侧边栏开合或文案变化而偏移。
    style.textContent = [
      "#" + READER_BUTTON_ID + " {",
      "  width: auto;",
      "  min-width: 0;",
      "  max-width: 150px;",
      "  height: 28px;",
      "  margin: 0;",
      "  padding: 0 10px;",
      "  overflow: hidden;",
      "  text-overflow: ellipsis;",
      "  white-space: nowrap;",
      "  font: inherit;",
      "  cursor: pointer;",
      "  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.15));",
      "  border-radius: 5px;",
      "  background-color: var(--material-background, #fff);",
      "  color: inherit;",
      "}",
      "#" + READER_BUTTON_ID + ":hover {",
      "  background-color: var(--fill-quinary, rgba(0, 0, 0, 0.05));",
      "}",
      "#" + READER_BUTTON_ID + ":active {",
      "  background-color: var(--fill-quarternary, rgba(0, 0, 0, 0.1));",
      "}",
      "#" + READER_BUTTON_ID + "[disabled] {",
      "  opacity: 0.6;",
      "  cursor: default;",
      "}",
    ].join("\n");
    doc.head.appendChild(style);
  }

  function getReaderInstances() {
    try {
      if (typeof Zotero.Reader?.getInstances === "function") {
        return Zotero.Reader.getInstances();
      }
    } catch (error) {
      log("获取 Reader 实例失败", error);
    }

    if (Array.isArray(Zotero.Reader?._readers)) {
      return Zotero.Reader._readers;
    }
    return [];
  }

  function getReaderDocument(reader) {
    const candidates = [
      reader?._iframeWindow?.document,
      reader?._iframe?.contentDocument,
      reader?._iframe?.contentWindow?.document,
      reader?.iframe?.contentDocument,
      reader?.iframe?.contentWindow?.document,
      reader?._window?.document,
      reader?.window?.document,
    ];
    return candidates.find((doc) => doc?.body && doc?.head) || null;
  }

  // Zotero 阅读器工具栏（React）右侧分组的真实结构：
  //   .toolbar > .end > .custom-sections > .section*  ->  之后才是 Zotero 自带按钮
  // React 组件 CustomSections 挂载时会派发 "customEvent"（detail.type = "renderToolbar"），
  // 外部插件用 Zotero.Reader.registerEventListener("renderToolbar", …) 拿到
  // { reader, doc, params, append }，append 必须在该回调里同步调用，
  // 它会把节点放进 .custom-sections —— 这是 Zotero 官方给插件预留的工具栏位置。
  function getCustomSectionsContainer(doc) {
    return doc.querySelector(".toolbar .end .custom-sections") || null;
  }

  function createReaderButton(doc, reader) {
    const button = doc.createElement("button");
    button.id = READER_BUTTON_ID;
    button.type = "button";
    button.textContent = BUTTON_LABEL;
    button.title = "把当前 PDF 对应的 MinerU Markdown 同步到条目笔记";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await syncFromReader(reader, button);
      } catch (error) {
        log("阅读器同步失败", error);
      }
    });
    return button;
  }

  // 只在确认存在官方 .custom-sections 时插入，避免落到错误容器里造成位置偏移
  function injectIntoDocument(doc, reader) {
    if (!doc || !doc.querySelector) {
      return false;
    }
    ensureReaderStyle(doc);
    if (doc.getElementById(READER_BUTTON_ID)) {
      return true;
    }
    const container = getCustomSectionsContainer(doc);
    if (!container) {
      return false;
    }
    // 与 renderToolbar 事件路径保持同一结构：.custom-sections > .section > button
    const section = doc.createElement("div");
    section.className = "section";
    section.appendChild(createReaderButton(doc, reader));
    container.insertBefore(section, container.firstChild);
    return true;
  }

  function injectReaderButton(reader) {
    const doc = getReaderDocument(reader);
    if (!doc) {
      return false;
    }
    return injectIntoDocument(doc, reader);
  }

  // 阅读器刚打开时工具栏可能还没渲染，短轮询等它出现（不占全局定时器）
  function waitAndInject(reader, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || RENDER_TOOLBAR_PROBE_TIMEOUT);
    const attempt = () => {
      if (injectReaderButton(reader)) {
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(attempt, 300);
      }
    };
    attempt();
  }

  // "renderToolbar" 事件的 doc 即阅读器内部文档，append 直接写入 .custom-sections。
  // 工具栏重新挂载时 React 会清空 .custom-sections，这个回调会再跑一次把按钮补回来，
  // 因此不会再出现“按钮偶尔消失”。
  function onRenderToolbar(event) {
    try {
      const { reader, doc, append } = event || {};
      if (!doc || typeof append !== "function" || doc.getElementById(READER_BUTTON_ID)) {
        return;
      }
      ensureReaderStyle(doc);
      // 与 Zotero 自带的自定义按钮保持一致：外面再包一层 .section
      const section = doc.createElement("div");
      section.className = "section";
      section.appendChild(createReaderButton(doc, reader));
      append(section);
    } catch (error) {
      log("处理 renderToolbar 事件失败", error);
    }
  }

  // 注册阅读器工具栏渲染回调：阅读器每次挂载工具栏都会派发 renderToolbar
  function registerReaderToolbarButton() {
    if (!Zotero.Reader || typeof Zotero.Reader.registerEventListener !== "function") {
      log("Zotero.Reader.registerEventListener 不可用，无法注册工具栏按钮");
      return;
    }
    Zotero.Reader.registerEventListener("renderToolbar", onRenderToolbar, PLUGIN_ID);
    // 插件启动时可能已有打开的阅读器（它们的 renderToolbar 已经派发过了）
    for (const reader of getReaderInstances()) {
      waitAndInject(reader, 5000);
    }
  }

  // 轮询只用于兜底：插件在已打开的阅读器之后启动，或事件已经错过的情况
  function scanReaders() {
    for (const reader of getReaderInstances()) {
      try {
        injectReaderButton(reader);
      } catch (error) {
        log("注入阅读器按钮失败", error);
      }
    }
  }

  function selectedItemsContainPDF(window) {
    try {
      const items = window.ZoteroPane?.getSelectedItems() || [];
      return items.some((item) => {
        if (!item) {
          return false;
        }
        if (typeof item.isAttachment === "function" && item.isAttachment()) {
          return isPDFAttachment(item);
        }
        if (typeof item.isRegularItem === "function" && item.isRegularItem()) {
          const attachmentIDs = typeof item.getAttachments === "function" ? item.getAttachments() : [];
          return attachmentIDs.length > 0;
        }
        return false;
      });
    } catch (error) {
      return false;
    }
  }

  async function syncSelectedItems(window) {
    const items = window.ZoteroPane?.getSelectedItems() || [];
    if (!items.length) {
      throw new Error("请先选中一个 PDF 条目或其父条目。");
    }

    const summaries = [];
    for (const item of items) {
      try {
        const results = await runSync(item, null);
        if (results && results.length) {
          summaries.push(...results);
        }
      } catch (error) {
        log("同步选中条目失败", error);
      }
    }
    return summaries;
  }

  function registerWindowMenus(window) {
    const document = window.document;
    const itemMenu = document.querySelector("#zotero-itemmenu");
    if (!itemMenu) {
      return;
    }

    if (!document.getElementById(ITEM_MENU_ID)) {
      const menuItem = document.createXULElement("menuitem");
      menuItem.id = ITEM_MENU_ID;
      menuItem.setAttribute("label", "同步 MinerU Markdown 到笔记");
      menuItem.addEventListener("command", async () => {
        try {
          await syncSelectedItems(window);
        } catch (error) {
          notify("MinerU 同步失败", error.message || String(error));
        }
      });
      itemMenu.appendChild(menuItem);

      const onPopupShowing = () => {
        menuItem.hidden = !selectedItemsContainPDF(window);
      };
      itemMenu.addEventListener("popupshowing", onPopupShowing);
      state.windows.get(window)?.cleanup.push(() => {
        itemMenu.removeEventListener("popupshowing", onPopupShowing);
      });
    }

    const toolsPopup = document.querySelector("#menu_ToolsPopup");
    if (toolsPopup && !document.getElementById(TOOLS_MENU_ID)) {
      const menuItem = document.createXULElement("menuitem");
      menuItem.id = TOOLS_MENU_ID;
      menuItem.setAttribute("label", "同步选中条目的 MinerU Markdown");
      menuItem.addEventListener("command", async () => {
        try {
          await syncSelectedItems(window);
        } catch (error) {
          notify("MinerU 同步失败", error.message || String(error));
        }
      });
      toolsPopup.appendChild(menuItem);
    }
  }

  async function onStartup() {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);

    registerReaderToolbarButton();

    if (!state.intervalID) {
      state.intervalID = setInterval(() => {
        scanReaders();
      }, 1500);
    }

    scanReaders();
  }

  async function onMainWindowLoad(window) {
    if (!state.windows.has(window)) {
      state.windows.set(window, { cleanup: [] });
    }
    registerWindowMenus(window);
    window.setTimeout(() => {
      scanReaders();
    }, 1200);
  }

  function onMainWindowUnload(window) {
    const data = state.windows.get(window);
    if (!data) {
      return;
    }
    for (const fn of data.cleanup) {
      try {
        fn();
      } catch (error) {
        log("窗口清理失败", error);
      }
    }
    state.windows.delete(window);
  }

  function onShutdown() {
    if (state.intervalID) {
      clearInterval(state.intervalID);
      state.intervalID = null;
    }

    try {
      Zotero.Reader?.unregisterEventListener?.("renderToolbar", onRenderToolbar);
    } catch (error) {
      log("注销 renderToolbar 监听失败", error);
    }

    for (const [window] of state.windows) {
      onMainWindowUnload(window);
    }
    state.windows.clear();

    for (const reader of getReaderInstances()) {
      const doc = getReaderDocument(reader);
      doc?.getElementById(READER_BUTTON_ID)?.remove();
      doc?.getElementById(READER_STYLE_ID)?.remove();
    }
  }

  return {
    hooks: {
      onStartup,
      onMainWindowLoad,
      onMainWindowUnload,
      onShutdown,
    },
  };
})();
