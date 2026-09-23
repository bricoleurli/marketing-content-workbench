if (!window.__workbenchHostPending) {
const state = {
  voices: [],
  selectedVoiceId: "",
  model: "s2.1-pro-free",
  history: [],
  keyConfigured: false,
};

const elements = {
  voiceList: document.querySelector("#voiceList"),
  scriptInput: document.querySelector("#scriptInput"),
  characterCount: document.querySelector("#characterCount"),
  characterLimit: document.querySelector("#characterLimit"),
  speedInput: document.querySelector("#speedInput"),
  speedValue: document.querySelector("#speedValue"),
  modelControl: document.querySelector("#modelControl"),
  costEstimate: document.querySelector("#costEstimate"),
  generateButton: document.querySelector("#generateButton"),
  emptyResult: document.querySelector("#emptyResult"),
  currentResult: document.querySelector("#currentResult"),
  resultTitle: document.querySelector("#resultTitle"),
  resultDetail: document.querySelector("#resultDetail"),
  audioPlayer: document.querySelector("#audioPlayer"),
  libraryButton: document.querySelector("#libraryButton"),
  downloadButton: document.querySelector("#downloadButton"),
  historyList: document.querySelector("#historyList"),
  historyCount: document.querySelector("#historyCount"),
  connectionStatus: document.querySelector("#connectionStatus"),
  settingsButton: document.querySelector("#settingsButton"),
  settingsDialog: document.querySelector("#settingsDialog"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  toggleKeyButton: document.querySelector("#toggleKeyButton"),
  saveSettingsButton: document.querySelector("#saveSettingsButton"),
  addVoiceButton: document.querySelector("#addVoiceButton"),
  voiceDialog: document.querySelector("#voiceDialog"),
  voiceNameInput: document.querySelector("#voiceNameInput"),
  voiceIdInput: document.querySelector("#voiceIdInput"),
  voiceDescriptionInput: document.querySelector("#voiceDescriptionInput"),
  saveVoiceButton: document.querySelector("#saveVoiceButton"),
  toast: document.querySelector("#toast"),
};

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeVoiceId(rawValue) {
  const raw = String(rawValue || "").trim();
  if (/^[A-Za-z0-9_-]{8,128}$/.test(raw)) return raw;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://fish.audio/${raw.replace(/^\/+/, "")}`);
    const queryId = url.searchParams.get("modelId")?.trim() || "";
    if (/^[A-Za-z0-9_-]{8,128}$/.test(queryId)) return queryId;
    const parts = url.pathname.split("/").filter(Boolean);
    const marker = parts.indexOf("m");
    const pathId = marker >= 0 ? parts[marker + 1] || "" : "";
    return /^[A-Za-z0-9_-]{8,128}$/.test(pathId) ? pathId : "";
  } catch (_error) {
    return "";
  }
}

function showToast(message, type = "info") {
  elements.toast.textContent = message;
  elements.toast.className = `toast show ${type === "error" ? "error" : ""}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 3400);
}

async function requestJson(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET") {
    const prefetched = window.workbenchReadPrefetch?.(path);
    if (prefetched) return prefetched;
  } else {
    window.workbenchClearPrefetch?.();
  }
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function setConnectionStatus(configured) {
  state.keyConfigured = configured;
  elements.connectionStatus.className = `connection-status ${configured ? "ready" : "missing"}`;
  elements.connectionStatus.querySelector("span").textContent = configured ? "API 已配置" : "等待 API Key";
}

function renderVoices() {
  if (!state.selectedVoiceId && state.voices.length) {
    state.selectedVoiceId = state.voices[0].id;
  }
  elements.voiceList.innerHTML = state.voices
    .map(
      (voice) => `
        <button class="voice-item ${voice.id === state.selectedVoiceId ? "active" : ""}" type="button" data-voice-id="${escapeHtml(voice.id)}">
          <img class="voice-avatar" src="${escapeHtml(voice.avatar || "")}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
          <span class="voice-copy">
            <strong>${escapeHtml(voice.name)}</strong>
            <span>${escapeHtml(voice.description || voice.id)}</span>
          </span>
          <i class="voice-check" data-lucide="check"></i>
        </button>
      `,
    )
    .join("");
  elements.voiceList.querySelectorAll(".voice-item").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedVoiceId = button.dataset.voiceId;
      renderVoices();
    });
  });
  refreshIcons();
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function renderHistory() {
  elements.historyCount.textContent = state.history.length;
  if (!state.history.length) {
    elements.historyList.innerHTML = '<p class="history-empty">还没有生成记录。</p>';
    return;
  }
  elements.historyList.innerHTML = state.history
    .map(
      (item) => `
        <a class="history-item" href="${escapeHtml(item.url)}" data-result-file="${escapeHtml(item.file)}">
          <span class="history-item-top">
            <strong>${escapeHtml(item.voice)}</strong>
            <time>${escapeHtml(formatDate(item.createdAt))}</time>
          </span>
          <p>${escapeHtml(item.preview || "配音文件")}</p>
        </a>
      `,
    )
    .join("");
  elements.historyList.querySelectorAll(".history-item").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const item = state.history.find((entry) => entry.file === link.dataset.resultFile);
      if (item) showResult(item, false);
    });
  });
}

function selectedVoice() {
  return state.voices.find((voice) => voice.id === state.selectedVoiceId) || state.voices[0];
}

function updateEditorMeta() {
  const length = elements.scriptInput.value.length;
  elements.characterCount.textContent = length;
  const limit = state.model === "s2.1-pro-free" ? 500 : 15000;
  elements.characterLimit.textContent = limit;
  elements.scriptInput.maxLength = limit;
  if (state.model === "s2.1-pro-free") {
    elements.costEstimate.textContent = "免费开发模型 · $0";
  } else {
    const usd = new TextEncoder().encode(elements.scriptInput.value).length * 15 / 1_000_000;
    elements.costEstimate.textContent = `预计 US$${usd.toFixed(4)} · 按 UTF-8 字节计费`;
  }
}

function showResult(item, autoplay) {
  elements.emptyResult.classList.add("hidden");
  elements.currentResult.classList.remove("hidden");
  elements.resultTitle.textContent = `${item.voice} · ${item.speed}x`;
  elements.resultDetail.textContent = `${item.characters} 字符 · ${(item.bytes / 1024).toFixed(0)} KB · ${item.model}`;
  elements.audioPlayer.src = item.url;
  elements.libraryButton.href = `/library`;
  elements.downloadButton.href = item.url;
  elements.downloadButton.download = item.file;
  if (autoplay) elements.audioPlayer.play().catch(() => {});
}

async function loadConfig() {
  try {
    const data = await requestJson("/api/config");
    state.voices = data.voices || [];
    state.history = data.history || [];
    setConnectionStatus(Boolean(data.keyConfigured));
    renderVoices();
    renderHistory();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function saveSettings() {
  const apiKey = elements.apiKeyInput.value.trim();
  if (!apiKey) {
    showToast("请粘贴 Fish Audio API Key", "error");
    return;
  }
  elements.saveSettingsButton.disabled = true;
  try {
    const data = await requestJson("/api/settings", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    });
    setConnectionStatus(Boolean(data.keyConfigured));
    elements.apiKeyInput.value = "";
    elements.settingsDialog.close();
    showToast("API Key 已保存在本机");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.saveSettingsButton.disabled = false;
  }
}

async function saveVoice() {
  const name = elements.voiceNameInput.value.trim();
  const id = normalizeVoiceId(elements.voiceIdInput.value);
  const description = elements.voiceDescriptionInput.value.trim();
  if (!name || !id) {
    showToast("请填写名称，并粘贴有效的 Voice ID 或 Fish 音色网址", "error");
    return;
  }
  if (state.voices.some((voice) => voice.id === id)) {
    showToast("这个音色已经在列表中", "error");
    return;
  }
  const nextVoices = [...state.voices, { name, id, description, avatar: "", builtin: false }];
  elements.saveVoiceButton.disabled = true;
  try {
    await requestJson("/api/settings", {
      method: "POST",
      body: JSON.stringify({ voices: nextVoices }),
    });
    state.voices = nextVoices;
    state.selectedVoiceId = id;
    renderVoices();
    elements.voiceDialog.close();
    elements.voiceNameInput.value = "";
    elements.voiceIdInput.value = "";
    elements.voiceDescriptionInput.value = "";
    showToast("音色已添加");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.saveVoiceButton.disabled = false;
  }
}

async function generateAudio() {
  const text = elements.scriptInput.value.trim();
  const voice = selectedVoice();
  if (!state.keyConfigured) {
    elements.settingsDialog.showModal();
    showToast("先配置 Fish Audio API Key", "error");
    return;
  }
  if (!text) {
    elements.scriptInput.focus();
    showToast("先输入需要配音的文案", "error");
    return;
  }
  if (!voice) {
    showToast("没有可用音色", "error");
    return;
  }

  elements.generateButton.disabled = true;
  elements.generateButton.classList.add("loading");
  elements.generateButton.querySelector("span").textContent = "正在生成";
  elements.generateButton.querySelector("svg")?.setAttribute("data-lucide", "loader-circle");
  refreshIcons();
  try {
    const data = await requestJson("/api/generate", {
      method: "POST",
      body: JSON.stringify({
        text,
        voiceId: voice.id,
        voiceName: voice.name,
        model: state.model,
        speed: Number(elements.speedInput.value),
      }),
    });
    state.history = [data.result, ...state.history].slice(0, 20);
    renderHistory();
    showResult(data.result, true);
    showToast("配音生成完成");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.generateButton.disabled = false;
    elements.generateButton.classList.remove("loading");
    elements.generateButton.querySelector("span").textContent = "生成配音";
    elements.generateButton.querySelector("svg")?.setAttribute("data-lucide", "audio-lines");
    refreshIcons();
  }
}

elements.scriptInput.addEventListener("input", updateEditorMeta);
elements.speedInput.addEventListener("input", () => {
  elements.speedValue.textContent = `${Number(elements.speedInput.value).toFixed(1)}x`;
});
elements.modelControl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-model]");
  if (!button) return;
  state.model = button.dataset.model;
  elements.modelControl.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
  updateEditorMeta();
});
elements.generateButton.addEventListener("click", generateAudio);
elements.settingsButton.addEventListener("click", () => elements.settingsDialog.showModal());
elements.addVoiceButton.addEventListener("click", () => elements.voiceDialog.showModal());
elements.saveSettingsButton.addEventListener("click", saveSettings);
elements.saveVoiceButton.addEventListener("click", saveVoice);
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    document.getElementById(button.dataset.closeDialog)?.close();
  });
});
elements.toggleKeyButton.addEventListener("click", () => {
  const reveal = elements.apiKeyInput.type === "password";
  elements.apiKeyInput.type = reveal ? "text" : "password";
  elements.toggleKeyButton.innerHTML = `<i data-lucide="${reveal ? "eye-off" : "eye"}"></i>`;
  refreshIcons();
});

refreshIcons();
updateEditorMeta();
loadConfig();
}
