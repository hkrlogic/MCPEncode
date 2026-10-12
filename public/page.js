/*
 * Behaviour for the server-rendered pages. Loaded on every page as a static
 * file, so the Content-Security-Policy can refuse inline script entirely.
 * Each part only acts when its elements are on the page.
 */
(function confirmations() {
  // <form data-confirm="…"> or <button data-confirm="…">: ask before submitting.
  // <form data-confirm-if="sa">: only when that checkbox is ticked.
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const submitter = event.submitter;
      const messages = [];
      if (submitter instanceof HTMLElement && submitter.dataset.confirm) messages.push(submitter.dataset.confirm);
      if (form.dataset.confirm) {
        const gate = form.dataset.confirmIf;
        const box = gate ? form.elements.namedItem(gate) : null;
        if (!gate || (box instanceof HTMLInputElement && box.checked)) messages.push(form.dataset.confirm);
      }
      for (const message of messages) {
        if (!window.confirm(message)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      }
    },
    true,
  );
})();
document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const el = document.querySelector(btn.getAttribute("data-copy"));
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.textContent || "");
      const previous = btn.textContent;
      btn.textContent = "Copied";
      btn.classList.add("is-copied");
      setTimeout(() => {
        btn.textContent = previous || "Copy";
        btn.classList.remove("is-copied");
      }, 1500);
    } catch { /* clipboard can be denied; the link stays visible */ }
  });
});
(function mcpMenu() {
  const menus = Array.from(document.querySelectorAll(".mcp-menu"));
  if (menus.length === 0) return;
  document.addEventListener("click", (event) => {
    for (const menu of menus) {
      if (!menu.open) continue;
      if (event.target instanceof Node && menu.contains(event.target)) continue;
      menu.open = false;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const menu of menus) {
      if (!menu.open) continue;
      menu.open = false;
      const summary = menu.querySelector("summary");
      if (summary instanceof HTMLElement) summary.focus();
    }
  });
})();
(function pendingSelect() {
  const form = document.getElementById("pending-publish");
  if (!form) return;
  const selectAll = document.getElementById("pending-select-all");
  const publishBtn = document.getElementById("pending-publish-btn");
  const cancelBtn = document.getElementById("pending-cancel-btn");
  const selection = document.getElementById("pending-selection");
  const boxes = () => Array.from(form.querySelectorAll('input[name="item_id"]'));
  function sync() {
    const all = boxes();
    const checked = all.filter((box) => box.checked);
    if (publishBtn) {
      publishBtn.disabled = checked.length === 0;
      publishBtn.textContent =
        checked.length === 0
          ? "Publish"
          : checked.length === 1
            ? "Publish 1"
            : "Publish " + checked.length;
    }
    if (cancelBtn) {
      cancelBtn.disabled = checked.length === 0;
      cancelBtn.textContent =
        checked.length === 0
          ? "Cancel"
          : checked.length === 1
            ? "Cancel 1"
            : "Cancel " + checked.length;
    }
    if (selection) {
      selection.textContent =
        checked.length === 0
          ? "Select items"
          : checked.length === all.length
            ? "All " + checked.length + " selected"
            : checked.length + " selected";
    }
    if (selectAll) {
      selectAll.checked = all.length > 0 && checked.length === all.length;
      selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
    }
  }
  selectAll?.addEventListener("change", () => {
    boxes().forEach((box) => { box.checked = selectAll.checked; });
    sync();
  });
  form.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.name === "item_id") sync();
  });
  sync();
})();
(function publishDiffSheet() {
  const sheet = document.getElementById("publish-diff");
  if (!(sheet instanceof HTMLDialogElement)) return;
  document.querySelectorAll('[data-open-sheet="publish-diff"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const menu = btn.closest("details.item-menu");
      if (menu) menu.open = false;
      sheet.showModal();
    });
  });
  sheet.querySelector("[data-close-sheet]")?.addEventListener("click", () => sheet.close());
  sheet.addEventListener("click", (event) => {
    if (event.target === sheet) sheet.close();
  });
})();
(function signOut() {
  // Sign-out links post the CSRF token at once; without script they open the
  // confirm form at GET /logout.
  const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
  if (!token) return;
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href="/logout"]') : null;
    if (!link || link.closest("form")) return;
    event.preventDefault();
    const form = document.createElement("form");
    form.method = "post";
    form.action = "/logout";
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "csrf";
    input.value = token;
    form.append(input);
    document.body.append(form);
    form.submit();
  });
})();
