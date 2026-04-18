const form = document.getElementById("downloadForm");
const statusEl = document.getElementById("status");
const submitBtn = document.getElementById("submitBtn");
const languageSelect = document.getElementById("languageSelect");
const urlsInput = document.getElementById("urls");

const i18n = {
  en: {
    title: "YouTube Downloader",
    helper: "One URL per line. Multiple URLs will be downloaded as a zip file.",
    urlsLabel: "Video URLs (one per line)",
    urlsPlaceholder: "https://www.youtube.com/watch?v=...\\nhttps://youtu.be/...",
    outputFormatLabel: "Output Format (select one or both)",
    cookiesLabel: "cookies.txt (Optional. Usually not required unless access is restricted.)",
    downloadButton: "Download",
    statusProcessing: "Preparing your download. Please wait...",
    statusFailed: "Download failed. Please try again.",
    statusDone: "Download complete.",
    statusUnknownError: "Unknown error occurred",
    statusNeedUrl: "Please enter at least one video URL.",
    statusNeedFormat: "Please select at least one output format."
  },
  "zh-Hant": {
    title: "YouTube 下載器",
    helper: "每行輸入一個連結。多個連結會自動打包成 zip 下載。",
    urlsLabel: "影片連結（每行一個）",
    urlsPlaceholder: "https://www.youtube.com/watch?v=...\\nhttps://youtu.be/...",
    outputFormatLabel: "輸出格式（可複選）",
    cookiesLabel: "cookies.txt（選填，通常不需要；遇到權限限制再上傳）",
    downloadButton: "開始下載",
    statusProcessing: "正在準備下載，請稍候...",
    statusFailed: "下載失敗，請稍後再試。",
    statusDone: "下載完成。",
    statusUnknownError: "發生未知錯誤",
    statusNeedUrl: "請至少輸入一個影片連結。",
    statusNeedFormat: "請至少勾選一個輸出格式。"
  }
};

const localeStorageKey = "preferredLocale";
let currentLocale = "en";

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

function getFileNameFromHeaders(headers, fallback) {
  const disposition = headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename=\"?([^\";]+)\"?/i);

  if (match?.[1]) {
    return decodeURIComponent(match[1]);
  }

  if (match?.[2]) {
    return match[2];
  }

  return fallback;
}

function inferDownloadFileName(response, selectedFormats, urlCount) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/zip") || urlCount > 1 || selectedFormats.length > 1) {
    return "youtube-downloads.zip";
  }

  return `download.${selectedFormats[0] || "mp4"}`;
}

async function downloadBlob(response, fallbackFileName) {
  const blob = await response.blob();
  const fileName = getFileNameFromHeaders(response.headers, fallbackFileName);
  const objectUrl = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(objectUrl);
}

function normalizeUrls(input) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

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

  setStatus(getLocaleText("statusProcessing"));
  submitBtn.disabled = true;

  try {
    const response = await fetch("/api/download", {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      let message = getLocaleText("statusFailed");
      const responseType = response.headers.get("content-type") || "";
      try {
        if (responseType.includes("application/json")) {
          const payload = await response.json();
          if (payload?.message) {
            message = payload.message;
          }
        }
      } catch {
        // keep fallback message
      }
      throw new Error(message);
    }

    const fallbackName = inferDownloadFileName(response, selectedFormats, urlLines.length);
    await downloadBlob(response, fallbackName);
    setStatus(getLocaleText("statusDone"), "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : getLocaleText("statusUnknownError");
    setStatus(message, "err");
  } finally {
    submitBtn.disabled = false;
  }
});

languageSelect.addEventListener("change", () => {
  setLocale(languageSelect.value);
});

initLocale();
