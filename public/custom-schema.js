/** Add library → Custom: add and remove field rows, up to the cap on the form. */
(function () {
  const root = document.querySelector("[data-custom-fields]");
  if (!root) return;
  const list = root.querySelector("[data-custom-field-list]");
  const add = root.querySelector("[data-custom-field-add]");
  const template = document.getElementById("custom-field-template");
  if (!list || !add || !template) return;
  const cap = Number(root.getAttribute("data-custom-field-cap")) || 12;

  function rows() {
    return [...list.querySelectorAll("[data-custom-field-row]")];
  }

  function sync() {
    add.disabled = rows().length >= cap;
  }

  function bind(row) {
    const remove = row.querySelector("[data-custom-field-remove]");
    if (!remove) return;
    remove.addEventListener("click", () => {
      row.remove();
      sync();
    });
  }

  add.addEventListener("click", () => {
    if (rows().length >= cap) return;
    const row = template.content.firstElementChild?.cloneNode(true);
    if (!row) return;
    list.append(row);
    bind(row);
    sync();
    row.querySelector("input")?.focus();
  });

  rows().forEach(bind);
  sync();
})();
