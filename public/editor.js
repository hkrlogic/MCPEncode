/** Capture grid + Description: table Markdown is hidden in #notes; prose lives in #description. */
const notes = document.getElementById("notes");
const preview = document.getElementById("preview");
const description = document.getElementById("description");
const descriptionPreview = document.getElementById("description-preview");
const sheet = document.getElementById("spreadsheet");
const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return null;
  return response.json();
}

function escapeCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/g, " ")
    .trim();
}

function usedWidth(headers, rows) {
  const width = Math.max(headers.length, ...rows.map((row) => row.length), 0);
  let last = -1;
  for (let index = 0; index < width; index += 1) {
    if ((headers[index] ?? "").trim() || rows.some((row) => (row[index] ?? "").trim())) {
      last = index;
    }
  }
  return last + 1;
}

function markdownFromTable(headers, rows) {
  const width = usedWidth(headers, rows);
  if (width === 0) return "";
  const pad = (row) => Array.from({ length: width }, (_, i) => escapeCell(row[i] ?? ""));
  const head = pad(headers).map((cell) => cell || " ");
  const body = rows.map(pad).filter((row) => row.some((cell) => cell && cell !== " "));
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function asRows(data) {
  if (!Array.isArray(data)) return [];
  return data.map((row) => (Array.isArray(row) ? row.map((cell) => (cell == null ? "" : String(cell))) : []));
}

let worksheet = null;

function readSheet() {
  if (!worksheet || typeof worksheet.getData !== "function") return [];
  try {
    return asRows(worksheet.getData(false, true));
  } catch {
    return asRows(worksheet.getData());
  }
}

function syncNotes() {
  if (!notes || !worksheet) return;
  const rows = readSheet();
  notes.value = markdownFromTable(rows[0] ?? [], rows.slice(1));
  notes.dispatchEvent(new Event("input"));
}

let tableTimer = 0;
let descriptionTimer = 0;

async function refreshPreview() {
  if (!notes || !preview) return;
  const data = await post("/preview", { markdown: notes.value });
  if (data?.html) preview.innerHTML = data.html;
}

async function refreshDescriptionPreview() {
  if (!description || !descriptionPreview) return;
  const markdown = description.value.trim();
  if (!markdown) {
    descriptionPreview.innerHTML = "";
    return;
  }
  const data = await post("/preview", { markdown });
  if (data?.html) descriptionPreview.innerHTML = data.html;
}

async function pasteMarkdown(event, field) {
  const html = event.clipboardData?.getData("text/html");
  if (!html) return;
  event.preventDefault();
  const data = await post("/convert-html", { html });
  const markdown = data?.markdown ?? event.clipboardData?.getData("text/plain") ?? "";
  const start = field.selectionStart ?? field.value.length;
  field.setRangeText(markdown, start, field.selectionEnd ?? start, "end");
  field.dispatchEvent(new Event("input"));
}

notes?.addEventListener("input", () => {
  window.clearTimeout(tableTimer);
  tableTimer = window.setTimeout(refreshPreview, 250);
});

description?.addEventListener("input", () => {
  window.clearTimeout(descriptionTimer);
  descriptionTimer = window.setTimeout(refreshDescriptionPreview, 250);
});

notes?.addEventListener("paste", (event) => {
  if (sheet) return;
  void pasteMarkdown(event, notes);
});

description?.addEventListener("paste", (event) => {
  void pasteMarkdown(event, description);
});

if (sheet && window.jspreadsheet) {
  let data = [
    ["", "", "", "", "", ""],
    ["", "", "", "", "", ""],
  ];
  try {
    const parsed = JSON.parse(sheet.dataset.table || "");
    if (Array.isArray(parsed) && parsed.length) data = asRows(parsed);
  } catch {
    /* keep default */
  }
  const cols = Math.max(6, ...data.map((row) => row.length));
  const rows = Math.max(10, data.length);

  const created = window.jspreadsheet(sheet, {
    parseHTML: false,
    toolbar: false,
    onafterchanges: syncNotes,
    onchange: syncNotes,
    oninsertrow: syncNotes,
    oninsertcolumn: syncNotes,
    ondeleterow: syncNotes,
    ondeletecolumn: syncNotes,
    onundo: syncNotes,
    onredo: syncNotes,
    worksheets: [
      {
        data,
        minDimensions: [cols, rows],
        tableOverflow: true,
        tableWidth: "100%",
        tableHeight: "340px",
        defaultColWidth: 140,
        allowInsertRow: true,
        allowInsertColumn: true,
        allowDeleteRow: true,
        allowDeleteColumn: true,
        columnDrag: true,
      },
    ],
  });
  worksheet = Array.isArray(created) ? created[0] : created;
  document.querySelector("form.capture")?.addEventListener("submit", syncNotes);
  syncNotes();
}

refreshPreview();
refreshDescriptionPreview();
