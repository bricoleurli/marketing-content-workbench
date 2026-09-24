/* 选题库：清单 + 标签展示，支持分类筛选、搜索、复制和已用标记（存本机）。 */
(() => {
  const original = window.WORKBENCH_TOPICS || { categories: [] };
  let data = structuredClone(original);
  const STORAGE_KEY = "topics-status:v1";
  const state = {
    category: "all",
    group: "",
    query: "",
    hideDone: false,
    done: new Set(),
  };

  const statsEl = document.getElementById("topicStats");
  const filtersEl = document.getElementById("topicFilters");
  const listsEl = document.getElementById("topicLists");
  const emptyEl = document.getElementById("topicsEmpty");
  const statusEl = document.getElementById("topicsStatus");
  const searchEl = document.getElementById("topicSearch");
  const hideDoneEl = document.getElementById("hideDoneButton");
  const copyVisibleEl = document.getElementById("copyVisibleButton");
  const toastEl = document.getElementById("topicsToast");

  let toastTimer = 0;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function topicKey(categoryId, text) {
    const source = `${categoryId}|${text}`;
    let hash = 5381;
    for (let index = 0; index < source.length; index += 1) {
      hash = ((hash * 33) ^ source.charCodeAt(index)) >>> 0;
    }
    return hash.toString(36);
  }

  function readStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const value = JSON.parse(raw);
      if (Array.isArray(value.done)) state.done = new Set(value.done);
      state.hideDone = Boolean(value.hideDone);
    } catch (_error) {
      // 损坏的本地记录直接丢弃，不影响浏览。
    }
  }

  function writeStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ done: [...state.done], hideDone: state.hideDone }));
    } catch (_error) {
      // 无痕模式等场景写不进去就算了。
    }
  }

  function totalTopicCount() {
    return data.categories.reduce(
      (sum, category) => sum + category.groups.reduce((groupSum, group) => groupSum + group.topics.length, 0),
      0,
    );
  }

  function doneTopicCount() {
    return data.categories.reduce(
      (sum, category) =>
        sum +
        category.groups.reduce(
          (groupSum, group) =>
            groupSum + group.topics.filter((text) => state.done.has(topicKey(category.id, text))).length,
          0,
        ),
      0,
    );
  }

  function matchTopic(category, group, text) {
    if (state.category !== "all" && state.category !== category.id) return false;
    if (state.group && state.group !== group.name) return false;
    if (state.hideDone && state.done.has(topicKey(category.id, text))) return false;
    const query = state.query.trim().toLowerCase();
    if (!query) return true;
    return `${text} ${group.name} ${category.name}`.toLowerCase().includes(query);
  }

  function visibleGroups(category) {
    return category.groups
      .map((group) => ({
        ...group,
        topics: group.topics.filter((text) => matchTopic(category, group, text)),
      }))
      .filter((group) => group.topics.length > 0);
  }

  function showToast(message, isError = false) {
    toastEl.textContent = message;
    toastEl.classList.toggle("error", isError);
    toastEl.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_error) {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (_secondary) {
        ok = false;
      }
      area.remove();
      return ok;
    }
  }

  function renderStats() {
    const cells = [{ id: "all", name: "全部选题", note: `${data.categories.length} 类 ${data.categories.reduce((n, c) => n + c.groups.length, 0)} 组`, count: totalTopicCount() }];
    data.categories.forEach((category) => {
      const count = category.groups.reduce((sum, group) => sum + group.topics.length, 0);
      cells.push({ id: category.id, name: category.name, note: category.note, count });
    });
    statsEl.innerHTML = cells
      .map(
        (cell) => `
          <button class="topics-stat${state.category === cell.id ? " is-active" : ""}" type="button"
            data-category="${cell.id}" title="${escapeHtml(cell.note || "")}">
            <span>${escapeHtml(cell.name)}</span>
            <strong>${cell.count}</strong>
            <small>${cell.id === "all" ? "点分类查看" : escapeHtml(cell.note)}</small>
          </button>`,
      )
      .join("");
  }

  function renderFilters() {
    const groups = [];
    data.categories.forEach((category) => {
      if (state.category !== "all" && state.category !== category.id) return;
      category.groups.forEach((group) => groups.push(group.name));
    });
    const chips = [{ value: "", label: "全部分组" }, ...groups.map((name) => ({ value: name, label: name }))];
    filtersEl.innerHTML = `${chips
      .map(
        (chip) =>
          `<button class="topics-filter${state.group === chip.value ? " is-active" : ""}" type="button"
            role="tab" data-group="${escapeHtml(chip.value)}">${escapeHtml(chip.label)}</button>`,
      )
      .join("")}`;
  }

  function updateResultCount(visibleTotal) {
    const countEl = document.getElementById("resultCount");
    if (countEl) countEl.textContent = `${visibleTotal} 条选题`;
  }

  function renderLists() {
    const sections = [];
    let visibleTotal = 0;
    data.categories.forEach((category) => {
      const groups = visibleGroups(category);
      if (groups.length === 0) return;
      const categoryTotal = groups.reduce((sum, group) => sum + group.topics.length, 0);
      visibleTotal += categoryTotal;
      const groupBlocks = groups
        .map((group) => {
          const rows = group.topics
            .map((text, rowIndex) => {
              const key = topicKey(category.id, text);
              const isDone = state.done.has(key);
              return `
                <div class="topics-row${isDone ? " is-done" : ""}" data-key="${key}">
                  <span class="topics-row-index">${String(rowIndex + 1).padStart(2, "0")}</span>
                  <p class="topics-row-text">${escapeHtml(text)}</p>
                  <div class="topics-row-tags"><span>${escapeHtml(category.name)}</span><span>${escapeHtml(group.name)}</span>${isDone ? '<span class="tag-done">已用</span>' : ""}</div>
                  <div class="topics-row-actions">
                    <button class="topics-row-btn" type="button" data-action="copy" title="复制这条选题" aria-label="复制这条选题"><i data-lucide="copy"></i></button>
                    <button class="topics-row-btn is-done-btn" type="button" data-action="done" title="${isDone ? "标记为未用" : "标记已用"}" aria-label="${isDone ? "标记为未用" : "标记已用"}"><i class="icon-done-circle" data-lucide="circle"></i><i class="icon-done-check" data-lucide="check"></i></button>
                  </div>
                </div>`;
            })
            .join("");
          return `
            <div class="topics-group">
              <p class="topics-group-head">${escapeHtml(group.name)} · ${group.topics.length} 条</p>
              <div class="topics-rows">${rows}</div>
            </div>`;
        })
        .join("");
      sections.push(
        `<section class="topics-cat">
          <div class="topics-cat-head">
            <h3>${escapeHtml(category.numeral)}、${escapeHtml(category.name)}</h3>
            <span class="topics-cat-note">${escapeHtml(category.note)}</span>
            <span class="topics-cat-count">${categoryTotal} 条</span>
          </div>
          ${groupBlocks}
        </section>`,
      );
    });
    listsEl.innerHTML = sections.join("");
    emptyEl.hidden = visibleTotal > 0;
    updateResultCount(visibleTotal);
    refreshIcons();
  }

  function renderStatus() {
    const done = doneTopicCount();
    statusEl.innerHTML = `<i></i><span>${totalTopicCount()} 个选题 · 已用 ${done} 个</span>`;
    statusEl.classList.add("ready");
  }

  function refreshIcons() {
    if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
  }

  function renderAll() {
    renderStats();
    renderFilters();
    renderLists();
    renderStatus();
  }

  function visibleTopicLines() {
    const lines = [];
    let total = 0;
    data.categories.forEach((category) => {
      const groups = visibleGroups(category);
      if (groups.length === 0) return;
      groups.forEach((group) => {
        lines.push(`${category.numeral}、${category.name} · ${group.name}`);
        group.topics.forEach((text, index) => {
          total += 1;
          lines.push(`${index + 1}. ${text}`);
        });
        lines.push("");
      });
    });
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return { text: `选题清单（共 ${total} 条）\n\n${lines.join("\n")}`, count: total };
  }

  statsEl.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-category]");
    if (!button) return;
    state.category = button.dataset.category;
    state.group = "";
    renderAll();
  });

  filtersEl.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-group]");
    if (!button) return;
    state.group = state.group === button.dataset.group ? "" : button.dataset.group;
    renderFilters();
    renderLists();
  });

  searchEl.addEventListener("input", () => {
    state.query = searchEl.value;
    renderLists();
  });

  hideDoneEl.addEventListener("click", () => {
    state.hideDone = !state.hideDone;
    hideDoneEl.setAttribute("aria-pressed", String(state.hideDone));
    writeStorage();
    renderLists();
  });

  listsEl.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const row = button.closest(".topics-row");
    if (!row) return;
    const key = row.dataset.key;
    if (button.dataset.action === "copy") {
      const textEl = row.querySelector(".topics-row-text");
      const ok = await copyText(textEl ? textEl.textContent : "");
      showToast(ok ? "已复制这条选题" : "复制失败，请手动选择文字", !ok);
      return;
    }
    if (state.done.has(key)) state.done.delete(key);
    else state.done.add(key);
    writeStorage();
    renderLists();
    renderStatus();
  });

  copyVisibleEl.addEventListener("click", async () => {
    const { text, count } = visibleTopicLines();
    if (count === 0) {
      showToast("当前没有可复制的选题", true);
      return;
    }
    const ok = await copyText(text);
    showToast(ok ? `已复制 ${count} 条选题` : "复制失败，请重试", !ok);
  });


  const editor = document.getElementById("topicEditor");
  const form = document.getElementById("topicForm");
  const categoryInput = document.getElementById("newTopicCategory");
  const groupInput = document.getElementById("newTopicGroup");
  const textInput = document.getElementById("newTopicText");
  const fileInput = document.getElementById("topicFile");
  const saveButton = document.getElementById("saveTopicButton");
  const cancelButton = document.getElementById("cancelTopicButton");
  const errorEl = document.getElementById("topicEditorError");
  let batchMode = false;
  let saving = false;
  let fileVersion = 0;

  function mergeCustom(custom) {
    data = structuredClone(original);
    for (const source of custom.categories) {
      let category = data.categories.find(c => c.name === source.name);
      if (!category) {
        category = { ...source, numeral: String(data.categories.length + 1), groups: [] };
        data.categories.push(category);
      }
      for (const incoming of source.groups) {
        let group = category.groups.find(g => g.name === incoming.name);
        if (!group) {
          group = { name: incoming.name, topics: [] };
          category.groups.push(group);
        }
        group.topics = [...new Set([...group.topics, ...incoming.topics])];
      }
    }
    renderAll();
  }

  async function topicRequest(options) {
    const response = await fetch("/api/topics", { cache: "no-store", ...options });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "保存失败，请重试");
    return result;
  }

  function topicLines() {
    if (!batchMode) return textInput.value.trim() ? [textInput.value.trim()] : [];
    return textInput.value.split(/\r?\n/).map(line => line.trim().replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/, "")).filter(Boolean);
  }

  function updateCount() {
    document.getElementById("topicEditorCount").textContent = `${topicLines().length} 条选题 · 每条最多 500 字`;
  }

  function updateGroups() {
    const category = data.categories.find(c => c.name === categoryInput.value.trim());
    document.getElementById("topicGroupOptions").replaceChildren(...(category?.groups || []).map(g => {
      const option = document.createElement("option"); option.value = g.name; return option;
    }));
  }

  function openEditor(batch) {
    batchMode = batch;
    fileVersion += 1;
    form.reset();
    saveButton.disabled = false;
    const selected = data.categories.find(c => c.id === state.category);
    categoryInput.value = selected?.name || "自建选题";
    groupInput.value = state.group || "默认分组";
    document.getElementById("topicEditorTitle").textContent = batch ? "批量导入选题" : "新建选题";
    document.getElementById("topicTextLabel").textContent = batch ? "选题清单（每行一条，也可以直接粘贴）" : "选题内容";
    document.getElementById("topicFileArea").hidden = !batch;
    errorEl.textContent = "";
    document.getElementById("topicCategoryOptions").replaceChildren(...data.categories.map(c => {
      const option = document.createElement("option"); option.value = c.name; return option;
    }));
    updateGroups(); updateCount();
    editor.showModal();
    textInput.focus();
  }

  document.getElementById("newTopicButton").addEventListener("click", () => openEditor(false));
  document.getElementById("importTopicsButton").addEventListener("click", () => openEditor(true));
  categoryInput.addEventListener("input", updateGroups);
  textInput.addEventListener("input", updateCount);
  cancelButton.addEventListener("click", () => editor.close());
  editor.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const version = ++fileVersion;
    errorEl.textContent = "";
    if (!/\.(txt|md)$/i.test(file.name) || file.size > 100 * 1024) {
      errorEl.textContent = "请选择不超过 100 KB 的 TXT 或 Markdown 文件";
      fileInput.value = ""; return;
    }
    saveButton.disabled = true;
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (version !== fileVersion || !editor.open) return;
      textInput.value = content.replace(/^\uFEFF/, ""); updateCount();
    } catch (_) {
      errorEl.textContent = "文件读取失败，请使用 UTF-8 编码的文本文件";
    } finally {
      if (version === fileVersion) saveButton.disabled = false;
    }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (saving) return;
    errorEl.textContent = "";
    const lines = topicLines();
    if (!lines.length || lines.length > 200 || lines.some(t => t.length > 500)) {
      errorEl.textContent = "请填写 1–200 条选题，每条不超过 500 字"; return;
    }
    const category = categoryInput.value.trim();
    const group = groupInput.value.trim();
    const known = new Set(data.categories.find(c => c.name === category)?.groups.find(g => g.name === group)?.topics || []);
    const topics = [...new Set(lines)].filter(t => !known.has(t));
    if (!topics.length) { errorEl.textContent = "这些选题已在此分类和分组中，无需重复添加"; return; }
    saving = true; saveButton.disabled = true; cancelButton.disabled = true;
    saveButton.textContent = "保存中…";
    try {
      const result = await topicRequest({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category, group, topics }) });
      state.category = "all"; state.group = ""; state.query = ""; searchEl.value = "";
      state.hideDone = false; hideDoneEl.setAttribute("aria-pressed", "false"); writeStorage();
      mergeCustom(result);
      state.category = data.categories.find(c => c.name === category).id;
      state.group = group; renderAll();
      editor.close();
      showToast(`已保存 ${result.added} 条选题，跳过 ${lines.length - result.added} 条重复项`);
    } catch (error) {
      errorEl.textContent = error.message;
    } finally {
      saving = false; saveButton.disabled = false; cancelButton.disabled = false;
      saveButton.textContent = "保存选题";
    }
  });
  topicRequest().then(mergeCustom).catch(() => showToast("自建选题读取失败，请刷新重试；原有选题仍可查看", true));

  readStorage();
  hideDoneEl.setAttribute("aria-pressed", String(state.hideDone));
  renderAll();
  refreshIcons();
})();
