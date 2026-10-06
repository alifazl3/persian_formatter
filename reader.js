/* Reading aids for the preview: estimated reading time, a table of contents
   built from the rendered headings, a scroll progress bar and text size. */
(function () {
  const SCALE_KEY = "pf_preview_scale";
  const SCALES = [0.85, 0.92, 1, 1.1, 1.2, 1.32, 1.45];
  const WORDS_PER_MINUTE = 200; // an average silent reading pace for Persian prose
  const HEADINGS = ".md-h1, .md-h2, .md-h3, .title";

  const bar = document.getElementById("readingBar");
  const stats = document.getElementById("readingStats");
  const tocButton = document.getElementById("tocButton");
  const tocPanel = document.getElementById("tocPanel");
  const progress = document.getElementById("readingProgress");
  const preview = document.getElementById("preview");

  let scaleIndex = SCALES.indexOf(1);
  try {
    const saved = Number(localStorage.getItem(SCALE_KEY));
    if (SCALES.includes(saved)) scaleIndex = SCALES.indexOf(saved);
  } catch (_) { /* Optional convenience. */ }

  function applyScale() {
    preview.style.setProperty("--preview-scale", String(SCALES[scaleIndex]));
    document.getElementById("textSmaller").disabled = scaleIndex === 0;
    document.getElementById("textLarger").disabled = scaleIndex === SCALES.length - 1;
    try { localStorage.setItem(SCALE_KEY, String(SCALES[scaleIndex])); } catch (_) { /* Optional. */ }
    updateProgress();
  }

  window.changeTextSize = step => {
    scaleIndex = Math.max(0, Math.min(SCALES.length - 1, scaleIndex + step));
    applyScale();
  };

  function readingTime(words) {
    const minutes = Math.round(words / WORDS_PER_MINUTE);
    return minutes < 1 ? "کمتر از ۱ دقیقه" : `حدود ${minutes.toLocaleString("fa-IR")} دقیقه`;
  }

  /** Called after every render of the preview. */
  window.updateReader = () => {
    closeToc();
    const empty = !!preview.querySelector(":scope > .empty") || !preview.textContent.trim();
    bar.hidden = empty;
    if (empty) { updateProgress(); return; }

    const words = (preview.textContent.match(/\S+/g) || []).length;
    stats.textContent = `${readingTime(words)} · ${words.toLocaleString("fa-IR")} کلمه`;

    const headings = [...preview.querySelectorAll(HEADINGS)].filter(h => h.textContent.trim());
    tocButton.hidden = headings.length < 2;
    tocPanel.replaceChildren();
    headings.forEach((heading, index) => {
      heading.id = `section-${index + 1}`;
      const level = heading.classList.contains("md-h1") ? 1 : heading.classList.contains("md-h3") ? 3 : 2;
      const link = document.createElement("button");
      link.type = "button";
      link.className = `toc-item toc-level-${level}`;
      link.textContent = heading.textContent.trim();
      link.addEventListener("click", () => {
        closeToc();
        heading.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      tocPanel.append(link);
    });
    updateProgress();
  };

  function closeToc() {
    tocPanel.hidden = true;
    tocButton.setAttribute("aria-expanded", "false");
  }
  window.toggleToc = () => {
    const open = tocPanel.hidden;
    tocPanel.hidden = !open;
    tocButton.setAttribute("aria-expanded", String(open));
    if (open) tocPanel.querySelector("button")?.focus();
  };
  document.addEventListener("click", event => {
    if (!tocPanel.hidden && !tocPanel.contains(event.target) && !tocButton.contains(event.target)) closeToc();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !tocPanel.hidden) { event.stopPropagation(); closeToc(); tocButton.focus(); }
  }, true);

  /** Thin bar at the top of the window: how far the preview has been read. */
  function updateProgress() {
    const rect = preview.getBoundingClientRect();
    const visible = !bar.hidden && preview.offsetParent !== null;
    const scrollable = rect.height - window.innerHeight;
    if (!visible || scrollable <= 0) { progress.hidden = true; return; }
    progress.hidden = false;
    const done = Math.min(1, Math.max(0, -rect.top / scrollable));
    progress.style.transform = `scaleX(${done})`;
  }
  let frame = 0;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; updateProgress(); }); };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);

  applyScale();
  window.updateReader();
})();
