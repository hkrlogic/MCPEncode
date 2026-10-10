/**
 * Add library: cycle example names in the empty Library name field.
 * Stops while the field is focused or already filled. Reduced motion keeps one example.
 */
(function () {
  const input = document.querySelector("[data-name-examples]");
  if (!(input instanceof HTMLInputElement)) return;
  const examples = (input.getAttribute("data-name-examples") || "")
    .split("|")
    .map((name) => name.trim())
    .filter(Boolean);
  if (examples.length === 0) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || examples.length === 1) {
    input.placeholder = examples[0];
    return;
  }

  let index = 0;
  let count = 0;
  let deleting = false;

  function schedule(ms) {
    window.setTimeout(tick, ms);
  }

  function tick() {
    if (document.activeElement === input || input.value.trim()) {
      input.placeholder = examples[0];
      schedule(400);
      return;
    }
    const name = examples[index];
    if (!deleting) {
      count += 1;
      input.placeholder = name.slice(0, count);
      if (count >= name.length) {
        deleting = true;
        schedule(1600);
        return;
      }
      schedule(72);
      return;
    }
    count -= 1;
    input.placeholder = name.slice(0, Math.max(count, 0));
    if (count <= 0) {
      deleting = false;
      index = (index + 1) % examples.length;
      schedule(360);
      return;
    }
    schedule(36);
  }

  tick();
})();
