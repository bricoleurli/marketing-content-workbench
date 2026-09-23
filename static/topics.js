/* 选题库：清单 + 标签展示，支持分类筛选、搜索、复制和已用标记（存本机）。 */
(() => {
  const data = window.WORKBENCH_TOPICS || { categories: [] };
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
    const cells = [{ id: "all", name: "全部选题", note: "5 类 13 组", count: totalTopicCount() }];
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

  readStorage();
  hideDoneEl.setAttribute("aria-pressed", String(state.hideDone));
  renderAll();
  refreshIcons();
})();
