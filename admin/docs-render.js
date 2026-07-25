/** 极简 Markdown → HTML（教程/流程页用，不引入外部库） */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineFormat(text) {
  let s = escapeHtml(text);
  s = s.replace(/`\[([^\]]+)\]\(([^)]+)\)`/g, "`$1`"); // noop guard
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s;
}

function mdToHtml(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let inCode = false;
  let codeBuf = [];
  let inUl = false;
  let inOl = false;
  let inTable = false;

  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };
  const closeTable = () => {
    if (inTable) { out.push("</tbody></table>"); inTable = false; }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      closeLists();
      closeTable();
      if (!inCode) {
        inCode = true;
        codeBuf = [];
      } else {
        out.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>");
        inCode = false;
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    if (/^\|/.test(line)) {
      closeLists();
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      const isSep = cells.every((c) => /^:?-+:?$/.test(c));
      if (!inTable) {
        out.push("<table><thead><tr>" + cells.map((c) => "<th>" + inlineFormat(c) + "</th>").join("") + "</tr></thead><tbody>");
        inTable = true;
        i++;
        continue;
      }
      if (isSep) {
        i++;
        continue;
      }
      out.push("<tr>" + cells.map((c) => "<td>" + inlineFormat(c) + "</td>").join("") + "</tr>");
      i++;
      continue;
    } else {
      closeTable();
    }

    if (/^>\s?/.test(line)) {
      closeLists();
      out.push("<blockquote><p>" + inlineFormat(line.replace(/^>\s?/, "")) + "</p></blockquote>");
      i++;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      closeLists();
      out.push("<hr />");
      i++;
      continue;
    }
    if (/^### /.test(line)) {
      closeLists();
      out.push("<h3>" + inlineFormat(line.slice(4)) + "</h3>");
      i++;
      continue;
    }
    if (/^## /.test(line)) {
      closeLists();
      out.push("<h2>" + inlineFormat(line.slice(3)) + "</h2>");
      i++;
      continue;
    }
    if (/^# /.test(line)) {
      closeLists();
      out.push("<h1>" + inlineFormat(line.slice(2)) + "</h1>");
      i++;
      continue;
    }
    if (/^[-*] /.test(line)) {
      if (!inUl) { closeLists(); out.push("<ul>"); inUl = true; }
      out.push("<li>" + inlineFormat(line.replace(/^[-*] /, "")) + "</li>");
      i++;
      continue;
    }
    if (/^\d+\. /.test(line)) {
      if (!inOl) { closeLists(); out.push("<ol>"); inOl = true; }
      out.push("<li>" + inlineFormat(line.replace(/^\d+\. /, "")) + "</li>");
      i++;
      continue;
    }
    if (!line.trim()) {
      closeLists();
      i++;
      continue;
    }
    closeLists();
    out.push("<p>" + inlineFormat(line) + "</p>");
    i++;
  }
  closeLists();
  closeTable();
  if (inCode) out.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>");
  return out.join("\n");
}

async function renderDoc(url, titleFallback) {
  const el = document.getElementById("content");
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const md = await res.text();
    el.innerHTML = mdToHtml(md);
    const h1 = el.querySelector("h1");
    if (h1) document.title = h1.textContent + " · OpenClaw";
    else if (titleFallback) document.title = titleFallback + " · OpenClaw";
  } catch (e) {
    el.innerHTML = '<p class="err">文档加载失败：' + escapeHtml(e.message || e) + "</p>";
  }
}
