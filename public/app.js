const form = document.getElementById("downloadForm");
const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const submitBtn = document.getElementById("submitBtn");
const languageSelect = document.getElementById("languageSelect");
const urlsInput = document.getElementById("urls");

const i18n = {
  en: {
    title: "YouTube Downloader",
    helper: "One URL per line. Multiple URLs will be downloaded as a zip file.",
    urlsLabel: "Video URLs (one per line)",
    urlsPlaceholder: "https://www.youtube.com/watch?v=...\nhttps://youtu.be/...",
    outputFormatLabel: "Output Format (select one or both)",
    cookiesLabel: "cookies.txt (Optional. Usually not required unless access is restricted.)",
    cookiesHelpTitle: "Need cookies.txt? Quick steps:",
    cookiesHelpStep1: "Log in to YouTube with the account that has access.",
    cookiesHelpStep2: "Export cookies as Netscape cookies.txt using a browser extension.",
    cookiesHelpStep3: "Upload the cookies.txt file here, then submit again.",
    cookiesHelpNote: "Use your own account only. Keep cookies.txt private and rotate it if expired.",
    downloadButton: "Download",
    statusNeedUrl: "Please enter at least one video URL.",
    statusNeedFormat: "Please select at least one output format.",
    statusStarting: "Starting download job...",
    statusPolling: "Processing on the server...",
    statusReady: "Download is ready.",
    statusManualDownloadHint: "If the download did not start automatically, click the button below.",
    statusCancelled: "Download was cancelled.",
    statusExpired: "The download file has expired. Please submit again.",
    downloadFileButton: "Download File",
    itemDownloadsTitle: "Per-item downloads",
    itemDownloadLabel: "Item {index}: {format} {name}",
    statusFailed: "Download failed. Please try again.",
    statusUnknownError: "Unknown error occurred"
  },
  "zh-Hant": {
    title: "YouTube 下載器",
    helper: "每行輸入一個連結。多個連結會自動打包成 zip 下載。",
    urlsLabel: "影片連結（每行一個）",
    urlsPlaceholder: "https://www.youtube.com/watch?v=...\nhttps://youtu.be/...",
    outputFormatLabel: "輸出格式（可複選）",
    cookiesLabel: "cookies.txt（選填，通常不需要；遇到權限限制再上傳）",
    cookiesHelpTitle: "需要 cookies.txt？快速三步驟：",
    cookiesHelpStep1: "先登入有權限觀看該影片的 YouTube 帳號。",
    cookiesHelpStep2: "使用瀏覽器擴充功能匯出 Netscape 格式的 cookies.txt。",
    cookiesHelpStep3: "回到這裡上傳 cookies.txt，再重新送出下載。",
    cookiesHelpNote: "請只使用自己的帳號並妥善保管 cookies.txt；過期後需重新匯出。",
    downloadButton: "開始下載",
    statusNeedUrl: "請至少輸入一個影片連結。",
    statusNeedFormat: "請至少勾選一個輸出格式。",
    statusStarting: "正在建立下載任務...",
    statusPolling: "伺服器處理中...",
    statusReady: "下載已完成。",
    statusManualDownloadHint: "若未自動開始下載，請點擊下方按鈕。",
    statusCancelled: "下載已取消。",
    statusExpired: "下載檔案已過期，請重新送出任務。",
    downloadFileButton: "下載檔案",
    itemDownloadsTitle: "逐項下載連結",
    itemDownloadLabel: "第 {index} 項：{format} {name}",
    statusFailed: "下載失敗，請稍後再試。",
    statusUnknownError: "發生未知錯誤"
  }
};

const qualityI18n = {
  videoResolutionLabel: { en: "Maximum video resolution", "zh-Hant": "影片解析度上限" },
  audioBitrateLabel: { en: "MP3 bitrate", "zh-Hant": "MP3 位元率" },
  qualityBest: { en: "Best available (default)", "zh-Hant": "最佳可用品質（預設）" },
  qualityHelp: { en: "Video uses the best available resolution at or below your selection; unavailable formats fail clearly.", "zh-Hant": "影片會使用不超過所選上限的最佳解析度；沒有可用格式時會顯示錯誤。" }
};

const localeStorageKey = "preferredLocale";
let currentLocale = "en";
let activeJobId = null;
let activeJobStatus = null;
let latestProgressJob = null;

function isCancellableStatus(status) {
  return status === "queued" || status === "running";
}

function getLocaleText(key) {
  return qualityI18n[key]?.[currentLocale] ?? i18n[currentLocale]?.[key] ?? i18n.en[key] ?? "";
}

function applyLocaleToPage() {
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    if (!key) return;
    element.textContent = getLocaleText(key);
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const key = element.dataset.i18nPlaceholder;
    if (!key) return;
    element.setAttribute("placeholder", getLocaleText(key));
  });

  document.documentElement.lang = currentLocale;
  if (latestProgressJob) renderJobProgress(latestProgressJob);
  if (typeof tasks !== "undefined") renderTaskPanel(Array.from(tasks.values()));
}

function setLocale(nextLocale) {
  currentLocale = i18n[nextLocale] ? nextLocale : "en";
  localStorage.setItem(localeStorageKey, currentLocale);
  applyLocaleToPage();
}

function initLocale() {
  const browserLocale = navigator.language?.startsWith("zh") ? "zh-Hant" : "en";
  const savedLocale = localStorage.getItem(localeStorageKey);
  currentLocale = i18n[savedLocale] ? savedLocale : browserLocale;
  languageSelect.value = currentLocale;
  applyLocaleToPage();
}

function setStatus(message, mode = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${mode}`.trim();
}

const stageText = {
  en: {queued: "Queued", starting: "Starting", preparing: "Preparing", running: "Downloading", packaging: "Building ZIP", completed: "Completed", "item-failed": "Item failed", failed: "Failed", cancelled: "Cancelled"},
  "zh-Hant": {queued: "排隊中", starting: "啟動中", preparing: "準備中", running: "下載中", packaging: "建立 ZIP 中", completed: "已完成", "item-failed": "項目失敗", failed: "失敗", cancelled: "已取消"}
};

function renderJobProgress(job) {
  latestProgressJob = job;
  const progress = job.progress || {};
  const stage = stageText[currentLocale][progress.stage] || getLocaleText("statusPolling");
  const percent = (value) => Math.max(0, Math.min(100, Number(value) || 0)).toFixed(1);
  const labels = currentLocale === "zh-Hant" ? ["整體", "目前檔案"] : ["Overall", "Current file"];
  setStatus(`${stage} (${Number(progress.current) || 0}/${Number(progress.total) || 0}) | ${labels[0]} ${percent(progress.percent)}% | ${labels[1]} ${percent(progress.itemPercent)}%`, "progress");
  setProgress(progress.percent);
}

function setProgress(percent) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  progressBar.style.width = `${clamped}%`;
  progressBar.setAttribute("aria-valuenow", `${clamped}`);
}

function normalizeUrls(input) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Store only opaque server IDs. Summaries and submission data stay in memory.
const taskStorageKey = "downloadJobIds";
const tasks = new Map();
const submissions = new Map();
const polling = new Set();
const cancelling = new Set();
const retrying = new Set();
const taskRevisions = new Map();
let submitting = false;
let submissionGeneration = 0;

const taskText = {
  en: {title: "Download tasks", cancel: "Cancel", retry: "Retry failed items", pending: "Pending", running: "Downloading", completed: "Completed", failed: "Failed", cancelled: "Cancelled", queued: "Queued", expired: "Expired", unavailable: "Connection lost. Check again", check: "Check status", retrySettings: "After a reload, retries use the current form settings. Reselect cookies.txt if needed.", cancelledHint: "Cancellation requested", cancelFailed: "Could not cancel. Please try again.", partial: "Completed with failed items", forget: "Dismiss"},
  "zh-Hant": {title: "下載任務", cancel: "取消", retry: "重試失敗項目", pending: "等待中", running: "下載中", completed: "已完成", failed: "失敗", cancelled: "已取消", queued: "排隊中", expired: "已過期", unavailable: "連線中斷，請重新查詢", check: "查詢狀態", retrySettings: "重新載入後，重試會使用目前表單設定；如有需要，請重新選取 cookies.txt。", cancelledHint: "已請求取消", cancelFailed: "無法取消，請再試一次。", partial: "部分項目下載失敗", forget: "移除"}
};
function taskLabel(key) { return taskText[currentLocale][key] || key; }
function persistedJobIds(jobs) {
  return jobs.map((job) => job.id).filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
}
function persistTasks() {
  try { sessionStorage.setItem(taskStorageKey, JSON.stringify(persistedJobIds(Array.from(tasks.values())))); } catch { /* unavailable storage does not block downloads */ }
}
function copyFormData(source) {
  const data = new FormData();
  for (const [key, value] of source.entries()) data.append(key, value);
  return data;
}
function buildRetryData(job, original) {
  const data = copyFormData(original || new FormData(form));
  const items = (job.items || []).filter((item) => item.status === "failed").map(({ url, format }) => ({ url, format }));
  data.set("items", JSON.stringify(items));
  data.set("urls", [...new Set(items.map((item) => item.url))].join("\n"));
  data.delete("format");
  [...new Set(items.map((item) => item.format))].forEach((format) => data.append("format", format));
  return data;
}
function taskButton(label, action, disabled = false, jobId = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = taskLabel(label);
  button.disabled = disabled;
  button.dataset.taskFocus = `${jobId}:${label}`;
  button.addEventListener("click", action);
  return button;
}
function renderTaskPanel(jobs) {
  const panel = document.getElementById("taskList");
  const focusKey = document.activeElement?.dataset.taskFocus;
  panel.replaceChildren();
  document.getElementById("taskPanel").classList.toggle("hidden", jobs.length === 0);
  document.getElementById("taskTitle").textContent = taskLabel("title");
  document.getElementById("retrySettings").textContent = taskLabel("retrySettings");
  for (const job of jobs) {
    const card = document.createElement("li");
    const heading = document.createElement("p");
    const partial = job.status === "completed" && job.items?.some((item) => item.status === "failed");
    heading.textContent = `${job.id} — ${taskLabel(job.connectionError ? "unavailable" : partial ? "partial" : job.status)}`;
    card.appendChild(heading);
    if (job.expiresAt) {
      const expiry = document.createElement("small");
      expiry.textContent = `${currentLocale === "zh-Hant" ? "到期時間" : "Expires"}: ${new Date(job.expiresAt).toLocaleString(currentLocale)}`;
      card.appendChild(expiry);
    }
    const list = document.createElement("ul");
    (job.items || []).forEach((item, index) => {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${index + 1}. [${item.format?.toUpperCase() || ""}] ${item.downloadName || item.url || ""} — ${taskLabel(item.status)}`;
      row.appendChild(label);
      if (item.error) {
        const error = document.createElement("p");
        error.className = "status err";
        error.textContent = item.error;
        row.appendChild(error);
      }
      if (item.status === "completed" && !["expired", "cancelled", "failed"].includes(job.status)) {
        const link = document.createElement("a");
        link.dataset.taskFocus = `${job.id}:item:${item.id}`;
        link.href = `/api/download/${job.id}/items/${item.id}/file`;
        link.setAttribute("download", item.downloadName || `item-${index + 1}`);
        link.textContent = getLocaleText("downloadFileButton");
        row.appendChild(link);
      }
      list.appendChild(row);
    });
    card.appendChild(list);
    if (job.error) { const error = document.createElement("p"); error.textContent = job.error; card.appendChild(error); }
    if (job.status === "completed") {
      const link = document.createElement("a");
      link.dataset.taskFocus = `${job.id}:file`;
      link.href = `/api/download/${job.id}/file`;
      link.setAttribute("download", job.downloadName || "download.zip");
      link.textContent = getLocaleText("downloadFileButton");
      card.appendChild(link);
    }
    if (isCancellableStatus(job.status)) card.appendChild(taskButton("cancel", () => cancelTask(job.id), cancelling.has(job.id), job.id));
    if (!isCancellableStatus(job.status) && job.status !== "expired" && job.items?.some((item) => item.status === "failed")) card.appendChild(taskButton("retry", () => retryTask(job.id), retrying.has(job.id), job.id));
    if (job.connectionError) card.appendChild(taskButton("check", () => pollTask(job.id), false, job.id));
    if (!isCancellableStatus(job.status)) card.appendChild(taskButton("forget", () => { tasks.delete(job.id); submissions.delete(job.id); persistTasks(); renderTasks(); }, false, job.id));
    panel.appendChild(card);
  }
  if (focusKey) {
    for (const element of panel.querySelectorAll("[data-task-focus]")) {
      if (element.dataset.taskFocus === focusKey) { element.focus(); break; }
    }
  }
}
function renderTasks() { renderTaskPanel(Array.from(tasks.values())); }
function updateTask(job) {
  tasks.set(job.id, job);
  persistTasks();
  renderTasks();
  if (activeJobId === job.id) {
    activeJobStatus = job.status;
    if (isCancellableStatus(job.status)) renderJobProgress(job);
    else {
      latestProgressJob = null;
      setStatus(getLocaleText(job.status === "completed" ? "statusReady" : job.status === "cancelled" ? "statusCancelled" : job.status === "expired" ? "statusExpired" : "statusFailed"), job.status === "completed" ? "ok" : "err");
      setProgress(job.status === "completed" ? 100 : job.progress?.percent || 0);
    }
  }
}
async function pollTask(id) {
  if (polling.has(id) || !tasks.has(id)) return;
  polling.add(id);
  try {
    while (tasks.has(id)) {
      const revision = taskRevisions.get(id) || 0;
      const response = await fetch(`/api/download/${id}`);
      if (revision !== (taskRevisions.get(id) || 0) || cancelling.has(id)) { await sleep(100); continue; }
      if (!tasks.has(id)) return;
      if (response.status === 404) { updateTask({id, status: "expired", items: []}); return; }
      if (!response.ok) throw new Error("poll failed");
      const job = await response.json();
      if (revision !== (taskRevisions.get(id) || 0) || cancelling.has(id)) { await sleep(100); continue; }
      if (!tasks.has(id)) return;
      updateTask(job);
      if (!isCancellableStatus(job.status)) return;
      await sleep(1000);
    }
  } catch {
    if (tasks.has(id)) { tasks.get(id).connectionError = true; renderTasks(); }
  } finally { polling.delete(id); }
}
async function cancelTask(id) {
  if (cancelling.has(id) || !isCancellableStatus(tasks.get(id)?.status)) return;
  cancelling.add(id);
  taskRevisions.set(id, (taskRevisions.get(id) || 0) + 1);
  renderTasks();
  try {
    const response = await fetch(`/api/download/${id}/cancel`, {method: "POST"});
    if (!response.ok) throw new Error("cancel failed");
    // Read the authoritative summary through the poller. An older in-flight poll
    // can never overwrite a cancellation response with a different summary.
    if (!polling.has(id)) void pollTask(id);
  } catch { if (tasks.has(id)) { tasks.get(id).error = taskLabel("cancelFailed"); renderTasks(); } }
  finally {
    taskRevisions.set(id, (taskRevisions.get(id) || 0) + 1);
    cancelling.delete(id); renderTasks();
    if (!polling.has(id)) void pollTask(id);
  }
}
async function submitTask(data) {
  const generation = ++submissionGeneration;
  activeJobId = null;
  latestProgressJob = null;
  const response = await fetch("/api/download", {method: "POST", body: data});
  if (!response.ok) {
    let message = getLocaleText("statusFailed");
    try { message = (await response.json()).message || message; } catch { /* keep fallback */ }
    throw new Error(message);
  }
  const job = await response.json();
  if (generation === submissionGeneration) activeJobId = job.id;
  submissions.set(job.id, copyFormData(data));
  updateTask(job);
  if (isCancellableStatus(job.status)) void pollTask(job.id);
}
async function retryTask(id) {
  if (retrying.has(id)) return;
  const job = tasks.get(id);
  if (!job || !job.items?.some((item) => item.status === "failed")) return;
  retrying.add(id); renderTasks();
  try { await submitTask(buildRetryData(job, submissions.get(id))); }
  catch (error) { setStatus(error.message || getLocaleText("statusFailed"), "err"); }
  finally { retrying.delete(id); renderTasks(); }
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitting) return;
  const urls = normalizeUrls(urlsInput.value);
  const data = new FormData(form);
  if (!urls.length) { setStatus(getLocaleText("statusNeedUrl"), "err"); return; }
  if (!data.getAll("format").some((format) => format === "mp3" || format === "mp4")) { setStatus(getLocaleText("statusNeedFormat"), "err"); return; }
  data.set("urls", urls.join("\n"));
  submitting = true; submitBtn.disabled = true;
  setStatus(getLocaleText("statusStarting"), "progress");
  try { await submitTask(data); }
  catch (error) { setStatus(error.message || getLocaleText("statusFailed"), "err"); }
  finally { submitting = false; submitBtn.disabled = false; }
});
languageSelect.addEventListener("change", () => setLocale(languageSelect.value));
initLocale();
try {
  const ids = JSON.parse(sessionStorage.getItem(taskStorageKey) || "[]");
  if (Array.isArray(ids)) {
    for (const id of persistedJobIds(ids.map((id) => ({id})))) {
      tasks.set(id, {id, status: "queued", items: []});
      activeJobId = id;
      void pollTask(id);
    }
  }
} catch { /* corrupt or unavailable storage does not block downloads */ }
renderTasks();
