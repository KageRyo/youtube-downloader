(() => {
  const button = document.getElementById("previewBtn");
  const container = document.getElementById("videoPreview");
  const input = document.getElementById("urls");
  let items = [];
  let controller;
  let generation = 0;
  let busy = false;
  const messages = {
    en: { button: "Preview videos", loading: "Loading preview…", missing: "Enter at least one YouTube URL.", failed: "Preview unavailable. Please try again.", duration: "Duration unavailable", title: "Title unavailable" },
    "zh-Hant": { button: "預覽影片", loading: "正在讀取預覽…", missing: "請至少輸入一個 YouTube 連結。", failed: "無法取得預覽，請稍後再試。", duration: "沒有片長資料", title: "沒有標題資料" }
  };
  function render() {
    const text = messages[document.documentElement.lang] ?? messages.en;
    button.textContent = busy ? text.loading : text.button;
    container.replaceChildren();
    container.classList.toggle("hidden", items.length === 0);
    for (const item of items) {
      const card = document.createElement("article");
      if (item.thumbnail) {
        const img = document.createElement("img");
        img.src = item.thumbnail; img.alt = ""; img.referrerPolicy = "no-referrer"; img.loading = "lazy";
        card.append(img);
      }
      const heading = document.createElement("p"); heading.textContent = item.title || item.url || text.title; card.append(heading);
      const detail = document.createElement("p");
      const seconds = Math.floor(item.duration);
      detail.textContent = item.error || (typeof item.duration === "number" && Number.isFinite(item.duration)
        ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : text.duration);
      card.append(detail); container.append(card);
    }
  }
  input.addEventListener("input", () => { generation += 1; controller?.abort(); busy = false; button.disabled = false; items = []; render(); });
  document.getElementById("languageSelect").addEventListener("change", render);
  button.addEventListener("click", async () => {
    const urls = input.value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
    const text = messages[document.documentElement.lang] ?? messages.en;
    if (!urls.length) { items = [{ error: text.missing }]; render(); return; }
    const current = ++generation;
    controller?.abort(); controller = new AbortController();
    busy = true; button.disabled = true; items = []; render();
    try {
      const response = await fetch("/api/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls }), signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || text.failed);
      if (current === generation) items = payload.items;
    } catch (error) {
      if (current === generation && error.name !== "AbortError") items = [{ error: error.message || text.failed }];
    } finally {
      if (current === generation) { busy = false; button.disabled = false; render(); }
    }
  });
  render();
})();
