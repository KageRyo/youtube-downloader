const form = document.getElementById("downloadForm");
const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const downloadActions = document.getElementById("downloadActions");
const downloadLink = document.getElementById("downloadLink");
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
    statusFailed: "下載失敗，請稍後再試。",
    statusUnknownError: "發生未知錯誤"
  }
};

const localeStorageKey = "preferredLocale";
let currentLocale = "en";
let activeJobId = null;
let activeJobStatus = null;

function isCancellableStatus(status) {
  return status === "queued" || status === "running";
}

function getLocaleText(key) {
  return i18n[currentLocale]?.[key] ?? i18n.en[key] ?? "";
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

  downloadLink.textContent = getLocaleText("downloadFileButton");
  document.documentElement.lang = currentLocale;
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

function setProgress(percent) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  progressBar.style.width = `${clamped}%`;
  progressBar.setAttribute("aria-valuenow", `${clamped}`);
}

function hideDownloadAction() {
  downloadActions.classList.add("hidden");
  downloadLink.setAttribute("href", "#");
  downloadLink.removeAttribute("download");
  downloadLink.textContent = getLocaleText("downloadFileButton");
}

function showDownloadAction(downloadUrl, fileName, autoStart = true) {
  downloadLink.setAttribute("href", downloadUrl);
  downloadLink.setAttribute("download", fileName);
  downloadLink.textContent = getLocaleText("downloadFileButton");
  downloadActions.classList.remove("hidden");

  if (autoStart) {
    window.setTimeout(() => {
      downloadLink.click();
    }, 0);
  }
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

async function fetchJobStatus(jobId) {
  const response = await fetch(`/api/download/${jobId}`);
  if (!response.ok) {
    let message = getLocaleText("statusFailed");
    try {
      const payload = await response.json();
      if (payload?.message) {
        message = payload.message;
      }
    } catch {
      // keep fallback message
    }

    if (response.status === 404) {
      message = getLocaleText("statusExpired");
    }

    throw new Error(message);
  }

  return response.json();
}

function cancelActiveJobIfNeeded() {
  if (!activeJobId || !isCancellableStatus(activeJobStatus)) {
    activeJobId = null;
    activeJobStatus = null;
    return;
  }

  const cancelUrl = `/api/download/${activeJobId}/cancel`;
  const payload = JSON.stringify({ reason: "page-unload" });

  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: "application/json" });
    navigator.sendBeacon(cancelUrl, blob);
  } else {
    void fetch(cancelUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: payload,
      keepalive: true
    }).catch(() => undefined);
  }

  activeJobId = null;
  activeJobStatus = null;
}

downloadLink.addEventListener("click", () => {
  activeJobId = null;
  activeJobStatus = null;
});

window.addEventListener("pagehide", cancelActiveJobIfNeeded);
window.addEventListener("beforeunload", cancelActiveJobIfNeeded);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  cancelActiveJobIfNeeded();
  hideDownloadAction();

  const urlLines = normalizeUrls(urlsInput.value);
  if (urlLines.length === 0) {
    setStatus(getLocaleText("statusNeedUrl"), "err");
    return;
  }

  const formData = new FormData(form);
  const selectedFormats = formData
    .getAll("format")
    .map((value) => `${value}`)
    .filter((value) => value === "mp3" || value === "mp4");

  if (selectedFormats.length === 0) {
    setStatus(getLocaleText("statusNeedFormat"), "err");
    return;
  }

  formData.set("urls", urlLines.join("\n"));
  for (const key of Array.from(formData.keys())) {
    if (key === "format") {
      formData.delete("format");
      break;
    }
  }
  selectedFormats.forEach((format) => {
    formData.append("format", format);
  });

  setStatus(getLocaleText("statusStarting"), "progress");
  setProgress(5);
  submitBtn.disabled = true;

  try {
    const response = await fetch("/api/download", {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      let message = getLocaleText("statusFailed");
      try {
        const payload = await response.json();
        if (payload?.message) {
          message = payload.message;
        }
      } catch {
        // keep fallback message
      }
      throw new Error(message);
    }

    const job = await response.json();
    let currentJob = job;
    activeJobId = currentJob.id;
    activeJobStatus = currentJob.status;
    setStatus(`${getLocaleText("statusPolling")} ${currentJob.message}`, "progress");
    setProgress(currentJob.progress?.itemPercent ?? currentJob.progress?.percent ?? 0);

    while (currentJob.status === "queued" || currentJob.status === "running") {
      await sleep(1000);
      currentJob = await fetchJobStatus(currentJob.id);
      activeJobStatus = currentJob.status;
      const itemPercent = currentJob.progress?.itemPercent ?? 0;
      setProgress(itemPercent);
      const current = currentJob.progress?.current ?? 0;
      const total = currentJob.progress?.total ?? 0;
      const overallPercent = currentJob.progress?.percent ?? 0;
      setStatus(
        `${currentJob.message} (${current}/${total}) | item ${itemPercent.toFixed(1)}% | total ${overallPercent.toFixed(1)}%`,
        "progress"
      );
    }

    if (currentJob.status === "failed") {
      throw new Error(currentJob.error || currentJob.message || getLocaleText("statusFailed"));
    }

    if (currentJob.status === "cancelled") {
      throw new Error(currentJob.message || getLocaleText("statusCancelled"));
    }

    const downloadUrl = `/api/download/${currentJob.id}/file`;
    const fileName = currentJob.downloadName || "download.zip";

    activeJobId = null;
    activeJobStatus = null;

    setStatus(`${getLocaleText("statusReady")} ${getLocaleText("statusManualDownloadHint")}`, "ok");
    setProgress(100);
    showDownloadAction(downloadUrl, fileName, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : getLocaleText("statusUnknownError");
    setStatus(message, "err");
    setProgress(0);
    activeJobId = null;
    activeJobStatus = null;
  } finally {
    submitBtn.disabled = false;
  }
});

languageSelect.addEventListener("change", () => {
  setLocale(languageSelect.value);
});

initLocale();
