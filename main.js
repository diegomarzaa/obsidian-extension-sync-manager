const { ItemView, Notice, Plugin } = require("obsidian");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VIEW_TYPE = "plugin-sync-manager-view";
const POLICY_PATH = "99 - Obsidian/plugin-sync/policy.json";
const SYNC_ENGINE_PATH = "99 - Obsidian/Templates/Scripts/plugin_sync.js";
const PLUGIN_DESIRED = ["both", "desktop-only", "mobile-only", "frozen", "ignore", "remove"];
const CONFIG_DESIRED = ["both", "prefer-desktop", "prefer-mobile", "frozen", "ignore"];
const PLUGIN_ENABLED = ["enabled", "disabled"];
const MAX_CONFIG_DIFF_KEYS = 40;
const MAX_VALUE_PREVIEW_CHARS = 6000;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function valueHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function previewValue(value) {
  if (value === undefined) return { exists: false, text: "<missing>" };
  let text = JSON.stringify(value, null, 2);
  if (text === undefined) text = String(value);
  if (text.length > MAX_VALUE_PREVIEW_CHARS) {
    text = `${text.slice(0, MAX_VALUE_PREVIEW_CHARS)}\n... <truncated>`;
  }
  return { exists: true, text };
}

class PluginSyncManagerPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new PluginSyncManagerView(leaf, this));
    this.addRibbonIcon("refresh-cw", "Plugin Sync Manager", () => this.activateView());
    this.addCommand({
      id: "open-plugin-sync-manager",
      name: "Open Plugin Sync Manager",
      callback: () => this.activateView(),
    });
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }
}

class PluginSyncManagerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.vaultRoot = plugin.app.vault.adapter.basePath;
    this.data = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Plugin Sync Manager";
  }

  getIcon() {
    return "refresh-cw";
  }

  async onOpen() {
    this.rootEl = this.contentEl || this.containerEl.children[1];
    this.rootEl.empty();
    this.rootEl.addClass("plugin-sync-manager");
    this.renderShell();
    await this.refresh();
  }

  onClose() {
    this.rootEl?.empty();
  }

  absolute(relativePath) {
    return path.join(this.vaultRoot, relativePath);
  }

  getSyncEngine() {
    const enginePath = this.absolute(SYNC_ENGINE_PATH);
    if (require.cache && require.cache[enginePath]) delete require.cache[enginePath];
    return require(enginePath);
  }

  runtime() {
    return this.getSyncEngine().createRuntime(null, { basePath: this.vaultRoot });
  }

  readJson(relativePath, fallback) {
    const fullPath = this.absolute(relativePath);
    if (!fs.existsSync(fullPath)) return fallback;
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  }

  writeJson(relativePath, data) {
    fs.mkdirSync(path.dirname(this.absolute(relativePath)), { recursive: true });
    fs.writeFileSync(this.absolute(relativePath), JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  timestamp() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  }

  backupFile(relativePath, policy) {
    const source = this.absolute(relativePath);
    if (!fs.existsSync(source)) return;
    const backupRoot = policy.backupRoot || "99 - Obsidian/plugin-sync/backups";
    const targetRelative = `${backupRoot}/${this.timestamp()}/${relativePath}`;
    const target = this.absolute(targetRelative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  currentScan() {
    const sync = this.getSyncEngine();
    const rt = sync.createRuntime(null, { basePath: this.vaultRoot });
    const loaded = sync.loadOrCreatePolicy(rt);
    const state = sync.loadState(rt, loaded.policy);
    return {
      sync,
      rt,
      scan: sync.scanPolicy(rt, loaded.policy, state),
      state,
      policyCreated: loaded.created,
    };
  }

  configDiffValues(item, stateEntry) {
    if (item.kind !== "config") return [];
    const desktop = item.desktop.json;
    const mobile = item.mobile.json;
    if (!desktop || !mobile || typeof desktop !== "object" || typeof mobile !== "object") return [];

    const keys = Array.from(new Set([...Object.keys(desktop), ...Object.keys(mobile)])).sort();
    const changed = [];
    for (const key of keys) {
      if (jsonEqual(desktop[key], mobile[key])) continue;
      changed.push({
        key,
        desktop: previewValue(desktop[key]),
        mobile: previewValue(mobile[key]),
        desktopChangedSinceBaseline: stateEntry?.desktopJsonKeys?.[key]
          ? stateEntry.desktopJsonKeys[key] !== valueHash(desktop[key])
          : false,
        mobileChangedSinceBaseline: stateEntry?.mobileJsonKeys?.[key]
          ? stateEntry.mobileJsonKeys[key] !== valueHash(mobile[key])
          : false,
      });
      if (changed.length >= MAX_CONFIG_DIFF_KEYS) break;
    }
    return changed;
  }

  compactSide(item, side) {
    const data = item[side];
    return {
      exists: data.exists,
      hash: data.hash ? data.hash.slice(0, 10) : "",
      fileCount: data.fileCount,
      size: data.size,
      mtimeMs: data.mtimeMs,
      version: item.kind === "plugin" ? item[`${side}Version`] || "" : "",
      enabled: item.kind === "plugin" ? Boolean(item[`${side}Enabled`]) : null,
    };
  }

  actionByType(item, type) {
    return item.actions.find((action) => action.type === type) || null;
  }

  pluginDecision(item) {
    const wantsDesktopEnabled = item.desktopEnabledState !== "disabled";
    const wantsMobileEnabled = item.mobileEnabledState !== "disabled";
    const desktopOk = item.desktop.exists && item.desktop.enabled === wantsDesktopEnabled;
    const mobileOk = item.mobile.exists && item.mobile.enabled === wantsMobileEnabled;
    const desktopAbsent = !item.desktop.exists && !item.desktop.enabled;
    const mobileAbsent = !item.mobile.exists && !item.mobile.enabled;

    if (item.mode === "remove") {
      return {
        category: desktopAbsent && mobileAbsent ? "ok" : "needs",
        label: desktopAbsent && mobileAbsent ? "Ready to forget" : "Needs removal",
        primaryAction: this.actionByType(item, "remove-completely"),
        secondaryActions: [],
      };
    }

    if (item.mode === "ignore") {
      return { category: "ok", label: "Ignored", primaryAction: null, secondaryActions: [] };
    }

    if (item.mode === "desktop-only") {
      const ok = desktopOk && mobileAbsent;
      const staleMobile = item.desktop.exists && !item.mobile.exists && item.mobile.enabled;
      return {
        category: ok ? "ok" : "needs",
        label: ok ? "Synced" : staleMobile ? "Disable stale mobile entry" : "Apply PC only",
        primaryAction: ok ? null : this.actionByType(item, "enforce-plugin-policy") || this.actionByType(item, "enforce-desktop-only"),
        secondaryActions: [],
      };
    }

    if (item.mode === "mobile-only") {
      const ok = mobileOk && desktopAbsent;
      const staleDesktop = !item.desktop.exists && item.desktop.enabled && item.mobile.exists;
      return {
        category: ok ? "ok" : "needs",
        label: ok ? "Synced" : staleDesktop ? "Disable stale PC entry" : "Apply mobile only",
        primaryAction: ok ? null : this.actionByType(item, "enforce-plugin-policy") || this.actionByType(item, "enforce-mobile-only"),
        secondaryActions: [],
      };
    }

    if (item.mode === "frozen") {
      const same = item.rawStatus === "same" && !item.enabledDifferent;
      return {
        category: same ? "ok" : "review",
        label: same ? "Synced" : "Review only",
        primaryAction: null,
        secondaryActions: [],
      };
    }

    const same = item.desktop.exists && item.mobile.exists && item.rawStatus === "same" &&
      item.desktop.enabled === wantsDesktopEnabled && item.mobile.enabled === wantsMobileEnabled;
    const desktopToMobile = this.actionByType(item, "desktop-to-mobile");
    const mobileToDesktop = this.actionByType(item, "mobile-to-desktop");
    const enforcePolicy = this.actionByType(item, "enforce-plugin-policy");
    const versionSuggestsDesktop = item.desktop.version && item.mobile.version && item.desktop.version !== item.mobile.version;

    if (same) return { category: "ok", label: "Synced", primaryAction: null, secondaryActions: [] };
    if (item.desktop.exists && !item.mobile.exists) {
      return { category: "needs", label: "Needs install on mobile", primaryAction: enforcePolicy || desktopToMobile, secondaryActions: [] };
    }
    if (!item.desktop.exists && item.mobile.exists) {
      return { category: "needs", label: "Needs install on PC", primaryAction: enforcePolicy || mobileToDesktop, secondaryActions: [] };
    }
    if (item.rawStatus === "same" && (item.desktop.enabled !== wantsDesktopEnabled || item.mobile.enabled !== wantsMobileEnabled)) {
      return { category: "needs", label: "Apply enabled states", primaryAction: enforcePolicy, secondaryActions: [] };
    }
    if (versionSuggestsDesktop && item.desktop.version > item.mobile.version) {
      return { category: "needs", label: "Needs sync", primaryAction: desktopToMobile, secondaryActions: [mobileToDesktop].filter(Boolean) };
    }
    if (versionSuggestsDesktop && item.mobile.version > item.desktop.version) {
      return { category: "needs", label: "Needs sync", primaryAction: mobileToDesktop, secondaryActions: [desktopToMobile].filter(Boolean) };
    }
    return {
      category: "needs",
      label: "Choose source",
      primaryAction: null,
      secondaryActions: [desktopToMobile, mobileToDesktop].filter(Boolean),
    };
  }

  configDecision(item) {
    const same = item.desktop.exists && item.mobile.exists && item.rawStatus === "same";
    const desktopToMobile = this.actionByType(item, "desktop-to-mobile");
    const mobileToDesktop = this.actionByType(item, "mobile-to-desktop");

    if (item.mode === "frozen") {
      return { category: same ? "ok" : "review", label: same ? "Synced" : "Review only", primaryAction: null, secondaryActions: [] };
    }
    if (item.mode === "prefer-desktop") {
      return { category: same ? "ok" : "needs", label: same ? "Synced" : "Prefer PC", primaryAction: same ? null : desktopToMobile, secondaryActions: [] };
    }
    if (item.mode === "prefer-mobile") {
      return { category: same ? "ok" : "needs", label: same ? "Synced" : "Prefer Mobile", primaryAction: same ? null : mobileToDesktop, secondaryActions: [] };
    }
    if (same) return { category: "ok", label: "Synced", primaryAction: null, secondaryActions: [] };
    if (item.desktop.exists && !item.mobile.exists) {
      return { category: "needs", label: "Needs sync", primaryAction: desktopToMobile, secondaryActions: [] };
    }
    if (!item.desktop.exists && item.mobile.exists) {
      return { category: "needs", label: "Needs sync", primaryAction: mobileToDesktop, secondaryActions: [] };
    }
    return {
      category: "needs",
      label: "Choose source",
      primaryAction: null,
      secondaryActions: [desktopToMobile, mobileToDesktop].filter(Boolean),
    };
  }

  compactItem(sync, item, stateEntry) {
    const actions = sync.itemActionOptions(item);
    const raw = {
      key: item.key,
      kind: item.kind,
      id: item.id,
      label: item.label,
      mode: item.mode,
      enabledState: item.enabledState || "enabled",
      desktopEnabledState: item.desktopEnabledState || item.enabledState || "enabled",
      mobileEnabledState: item.mobileEnabledState || item.enabledState || "enabled",
      rawStatus: item.status,
      enabledDifferent: Boolean(item.enabledDifferent),
      desktop: this.compactSide(item, "desktop"),
      mobile: this.compactSide(item, "mobile"),
      changedFiles: item.changedFiles || [],
      changedKeys: item.changedKeys || [],
      diffValues: this.configDiffValues(item, stateEntry),
      actions,
    };
    raw.desiredOptions = item.kind === "plugin" ? PLUGIN_DESIRED : CONFIG_DESIRED;
    raw.enabledOptions = PLUGIN_ENABLED;
    const decision = item.kind === "plugin" ? this.pluginDecision(raw) : this.configDecision(raw);
    return { ...raw, decision };
  }

  getData() {
    const { sync, scan, state, policyCreated } = this.currentScan();
    const items = scan.items.map((item) => this.compactItem(sync, item, state.items?.[item.key]));
    const counts = items.reduce((acc, item) => {
      acc.total += 1;
      acc[item.kind] += 1;
      acc[item.decision.category] += 1;
      return acc;
    }, { total: 0, plugin: 0, config: 0, needs: 0, review: 0, ok: 0 });
    return { scannedAt: scan.scannedAt, policyCreated, counts, items };
  }

  updatePolicy({ key, mode, desktopEnabledState, mobileEnabledState }) {
    const [kind, id] = String(key || "").split(":");
    if (!kind || !id) throw new Error("Missing key.");
    if (mode !== undefined && kind === "plugin" && !PLUGIN_DESIRED.includes(mode)) throw new Error(`Unsupported plugin desired state: ${mode}`);
    if (mode !== undefined && kind === "config" && !CONFIG_DESIRED.includes(mode)) throw new Error(`Unsupported config desired state: ${mode}`);
    if (desktopEnabledState !== undefined && !PLUGIN_ENABLED.includes(desktopEnabledState)) throw new Error(`Unsupported PC enabled state: ${desktopEnabledState}`);
    if (mobileEnabledState !== undefined && !PLUGIN_ENABLED.includes(mobileEnabledState)) throw new Error(`Unsupported mobile enabled state: ${mobileEnabledState}`);

    const policy = this.readJson(POLICY_PATH, null);
    if (!policy) throw new Error("Policy does not exist.");
    if (kind === "plugin") {
      policy.plugins = policy.plugins || {};
      policy.plugins[id] = policy.plugins[id] || {};
      if (mode !== undefined) policy.plugins[id].mode = mode;
      if (desktopEnabledState !== undefined) policy.plugins[id].desktopEnabledState = desktopEnabledState;
      if (mobileEnabledState !== undefined) policy.plugins[id].mobileEnabledState = mobileEnabledState;
    } else if (kind === "config") {
      policy.rootConfigFiles = policy.rootConfigFiles || {};
      policy.rootConfigFiles[id] = policy.rootConfigFiles[id] || {};
      if (mode !== undefined) policy.rootConfigFiles[id].mode = mode;
    }
    this.writeJson(POLICY_PATH, policy);
  }

  applyAction(action) {
    if (!action || !action.type || !action.key) throw new Error("Missing action.");
    const { sync, rt, scan } = this.currentScan();
    const applied = sync.applyActions(rt, scan, [action]);
    const next = this.currentScan();
    sync.saveState(this.runtime(), next.scan.policy, next.scan);
    return applied;
  }

  refreshBaseline() {
    const { sync, scan } = this.currentScan();
    sync.saveState(this.runtime(), scan.policy, scan);
  }

  copyConfigKey({ key, property, source }) {
    const [kind, fileName] = String(key || "").split(":");
    if (kind !== "config" || !fileName) throw new Error("Expected config key.");
    if (!property) throw new Error("Missing property.");
    if (!["desktop", "mobile"].includes(source)) throw new Error("Invalid source.");

    const { scan } = this.currentScan();
    const policy = scan.policy;
    const roots = policy.roots || { desktop: ".obsidian", mobile: ".obsidian_mobile" };
    const sourceRoot = source === "desktop" ? roots.desktop : roots.mobile;
    const targetRoot = source === "desktop" ? roots.mobile : roots.desktop;
    const sourcePath = `${sourceRoot}/${fileName}`;
    const targetPath = `${targetRoot}/${fileName}`;
    const sourceJson = this.readJson(sourcePath, {});
    const targetJson = this.readJson(targetPath, {});

    this.backupFile(targetPath, policy);
    if (Object.prototype.hasOwnProperty.call(sourceJson, property)) targetJson[property] = sourceJson[property];
    else delete targetJson[property];
    this.writeJson(targetPath, targetJson);
  }

  renderShell() {
    this.rootEl.innerHTML = `
      <h2>Plugin Sync Manager</h2>
      <div class="psm-toolbar">
        <input class="psm-search" placeholder="Search plugin or config">
        <select class="psm-kind">
          <option value="all">All items</option>
          <option value="plugin">Plugins</option>
          <option value="config">Base configs</option>
        </select>
        <select class="psm-view">
          <option value="all">Everything</option>
          <option value="active">Needs decision</option>
          <option value="needs">Needs action</option>
          <option value="review">Review only</option>
          <option value="ok">OK</option>
        </select>
        <button class="psm-button psm-refresh">Refresh</button>
        <button class="psm-button psm-baseline">Refresh baseline</button>
      </div>
      <div class="psm-summary"></div>
      <div class="psm-statusbar">Loading...</div>
      <table class="psm-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Desired</th>
            <th>PC enabled</th>
            <th>Mobile enabled</th>
            <th>Actual</th>
            <th>Status</th>
            <th>Action</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    `;

    this.rootEl.querySelector(".psm-search").addEventListener("input", () => this.renderRows());
    this.rootEl.querySelector(".psm-kind").addEventListener("change", () => this.renderRows());
    this.rootEl.querySelector(".psm-view").addEventListener("change", () => this.renderRows());
    this.rootEl.querySelector(".psm-refresh").addEventListener("click", () => this.refresh());
    this.rootEl.querySelector(".psm-baseline").addEventListener("click", () => {
      if (!confirm("Refresh baseline hashes without copying files?")) return;
      try {
        this.refreshBaseline();
        new Notice("Plugin sync baseline refreshed.");
        this.refresh();
      } catch (error) {
        new Notice(error.message);
      }
    });
  }

  async refresh() {
    try {
      this.data = this.getData();
      this.renderSummary();
      this.renderRows();
    } catch (error) {
      this.setMessage(error.stack || error.message);
      new Notice(error.message);
    }
  }

  setMessage(text) {
    this.rootEl.querySelector(".psm-statusbar").textContent = text;
  }

  renderSummary() {
    const c = this.data.counts;
    const cards = [
      ["Needs action", c.needs],
      ["Review only", c.review],
      ["OK", c.ok],
      ["Plugins", c.plugin],
      ["Configs", c.config],
    ];
    this.rootEl.querySelector(".psm-summary").innerHTML = cards.map(([label, value]) =>
      `<div class="psm-metric"><strong>${value}</strong><span>${label}</span></div>`
    ).join("");
  }

  passesFilters(item) {
    const text = this.rootEl.querySelector(".psm-search").value.trim().toLowerCase();
    const kind = this.rootEl.querySelector(".psm-kind").value;
    const view = this.rootEl.querySelector(".psm-view").value;
    if (kind !== "all" && item.kind !== kind) return false;
    if (text && !(item.id.toLowerCase().includes(text) || item.label.toLowerCase().includes(text))) return false;
    if (view === "active" && item.decision.category === "ok") return false;
    if (view !== "all" && view !== "active" && item.decision.category !== view) return false;
    return true;
  }

  desiredLabel(kind, mode) {
    const plugin = {
      both: "Both devices",
      "desktop-only": "PC only",
      "mobile-only": "Mobile only",
      frozen: "Frozen",
      ignore: "Ignored",
      remove: "Remove completely",
    };
    const config = {
      both: "Sync both",
      "prefer-desktop": "Prefer PC",
      "prefer-mobile": "Prefer Mobile",
      frozen: "Frozen",
      ignore: "Ignored",
    };
    return (kind === "plugin" ? plugin : config)[mode] || mode;
  }

  actionLabel(action, item) {
    const labels = {
      "desktop-to-mobile": "PC -> Mobile",
      "mobile-to-desktop": "Mobile -> PC",
      "enforce-desktop-only": "Apply PC only",
      "enforce-mobile-only": "Apply mobile only",
      "remove-completely": "Remove completely",
      "enforce-plugin-policy": "Apply desired state",
    };
    if (action.type === "enforce-desktop-only" && item.mobile.enabled && !item.mobile.exists) return "Disable on mobile";
    if (action.type === "enforce-mobile-only" && item.desktop.enabled && !item.desktop.exists) return "Disable on PC";
    if (action.type === "desktop-to-mobile" && item.mode === "prefer-desktop") return "Apply desired state";
    if (action.type === "mobile-to-desktop" && item.mode === "prefer-mobile") return "Apply desired state";
    return labels[action.type] || action.type;
  }

  sideText(item, sideName) {
    const side = item[sideName];
    const name = sideName === "desktop" ? "PC" : "Mobile";
    if (!side.exists) {
      if (side.enabled === true) return `${name}: enabled but files missing`;
      return `${name}: absent`;
    }
    const parts = [`${name}: installed`];
    if (side.version) parts.push(`v${side.version}`);
    if (side.enabled !== null) parts.push(side.enabled ? "on" : "off");
    return parts.join(", ");
  }

  actualText(item) {
    if (item.kind === "config") {
      if (!item.desktop.exists && !item.mobile.exists) return "Missing on both";
      if (!item.desktop.exists) return "Missing on PC";
      if (!item.mobile.exists) return "Missing on mobile";
      if (item.rawStatus === "same") return "Same on both";
      return "Different values";
    }
    return `${this.sideText(item, "desktop")}. ${this.sideText(item, "mobile")}.`;
  }

  renderOptionHtml(item) {
    return item.desiredOptions.map((mode) =>
      `<option value="${mode}"${mode === item.mode ? " selected" : ""}>${escapeHtml(this.desiredLabel(item.kind, mode))}</option>`
    ).join("");
  }

  renderEnabledHtml(item, side) {
    if (item.kind !== "plugin") return '<span class="psm-meta">-</span>';
    const selected = side === "desktop" ? item.desktopEnabledState : item.mobileEnabledState;
    return `<select data-role="${side}-enabled">` + item.enabledOptions.map((value) =>
      `<option value="${value}"${value === selected ? " selected" : ""}>${value === "enabled" ? "Enabled" : "Disabled"}</option>`
    ).join("") + "</select>";
  }

  renderStatusHtml(item) {
    return `<span class="psm-badge psm-badge-${item.decision.category}">${escapeHtml(item.decision.label)}</span>`;
  }

  renderActionHtml(item) {
    const buttons = [];
    if (item.decision.primaryAction) {
      const cls = item.decision.primaryAction.type === "remove-completely" ? "psm-button-danger" : "psm-button-primary";
      buttons.push(`<button class="psm-button ${cls}" data-role="apply-action" data-action="${escapeHtml(JSON.stringify(item.decision.primaryAction))}">${escapeHtml(this.actionLabel(item.decision.primaryAction, item))}</button>`);
    }
    for (const action of item.decision.secondaryActions || []) {
      buttons.push(`<button class="psm-button" data-role="apply-action" data-action="${escapeHtml(JSON.stringify(action))}">${escapeHtml(this.actionLabel(action, item))}</button>`);
    }
    return buttons.length ? `<div class="psm-actions">${buttons.join("")}</div>` : '<span class="psm-meta">No action needed</span>';
  }

  renderDetailsHtml(item) {
    if (item.kind === "config" && item.diffValues && item.diffValues.length) {
      const entries = item.diffValues.map((entry) => `
        <div class="psm-diff-item">
          <div class="psm-diff-key">${escapeHtml(entry.key)}</div>
          <div class="psm-diff-grid">
            <div class="psm-diff-side">
              <div class="psm-diff-label">
                <span>PC${entry.desktopChangedSinceBaseline ? ' <span class="psm-changed-flag">changed</span>' : ""}</span>
                <button class="psm-button psm-mini-button" data-role="copy-config-key" data-source="desktop" data-property="${escapeHtml(entry.key)}">PC -> Mobile</button>
              </div>
              <pre class="psm-value">${escapeHtml(entry.desktop.text)}</pre>
            </div>
            <div class="psm-diff-side">
              <div class="psm-diff-label">
                <span>Mobile${entry.mobileChangedSinceBaseline ? ' <span class="psm-changed-flag">changed</span>' : ""}</span>
                <button class="psm-button psm-mini-button" data-role="copy-config-key" data-source="mobile" data-property="${escapeHtml(entry.key)}">Mobile -> PC</button>
              </div>
              <pre class="psm-value">${escapeHtml(entry.mobile.text)}</pre>
            </div>
          </div>
        </div>
      `).join("");
      return `<details class="psm-details"><summary>${item.diffValues.length} changed value(s)</summary>${entries}</details>`;
    }

    const bits = [];
    if (item.desktop.hash) bits.push(`PC hash ${item.desktop.hash}`);
    if (item.mobile.hash) bits.push(`Mobile hash ${item.mobile.hash}`);
    if (item.changedFiles && item.changedFiles.length) bits.push(`Changed files: ${item.changedFiles.slice(0, 8).join(", ")}`);
    if (!bits.length) bits.push("No extra details");
    return `<div class="psm-details-summary">${bits.map(escapeHtml).join("<br>")}</div>`;
  }

  renderRows() {
    const rows = this.data.items.filter((item) => this.passesFilters(item));
    const tbody = this.rootEl.querySelector("tbody");
    tbody.innerHTML = rows.map((item) => `
      <tr class="${item.decision.category === "ok" ? "psm-row-ok" : ""}" data-key="${escapeHtml(item.key)}">
        <td><div class="psm-item-name">${escapeHtml(item.label)}</div><div class="psm-meta">${escapeHtml(item.kind)}</div></td>
        <td><select data-role="desired">${this.renderOptionHtml(item)}</select></td>
        <td>${this.renderEnabledHtml(item, "desktop")}</td>
        <td>${this.renderEnabledHtml(item, "mobile")}</td>
        <td><div class="psm-actual">${escapeHtml(this.actualText(item))}</div></td>
        <td>${this.renderStatusHtml(item)}</td>
        <td>${this.renderActionHtml(item)}</td>
        <td>${this.renderDetailsHtml(item)}</td>
      </tr>
    `).join("");
    this.bindRowEvents(tbody);
    this.setMessage(`${rows.length} visible. Last scan: ${this.data.scannedAt}`);
  }

  bindRowEvents(tbody) {
    tbody.querySelectorAll("select[data-role='desired']").forEach((select) => {
      select.addEventListener("change", () => {
        const key = select.closest("tr").dataset.key;
        try {
          this.updatePolicy({ key, mode: select.value });
          new Notice("Desired state updated.");
          this.refresh();
        } catch (error) {
          new Notice(error.message);
        }
      });
    });

    tbody.querySelectorAll("select[data-role='desktop-enabled']").forEach((select) => {
      select.addEventListener("change", () => {
        const key = select.closest("tr").dataset.key;
        try {
          this.updatePolicy({ key, desktopEnabledState: select.value });
          new Notice("PC enabled preference updated.");
          this.refresh();
        } catch (error) {
          new Notice(error.message);
        }
      });
    });

    tbody.querySelectorAll("select[data-role='mobile-enabled']").forEach((select) => {
      select.addEventListener("change", () => {
        const key = select.closest("tr").dataset.key;
        try {
          this.updatePolicy({ key, mobileEnabledState: select.value });
          new Notice("Mobile enabled preference updated.");
          this.refresh();
        } catch (error) {
          new Notice(error.message);
        }
      });
    });

    tbody.querySelectorAll("button[data-role='apply-action']").forEach((button) => {
      button.addEventListener("click", () => {
        const row = button.closest("tr");
        const item = this.data.items.find((entry) => entry.key === row.dataset.key);
        const action = JSON.parse(button.dataset.action);
        const label = this.actionLabel(action, item);
        let extra = "A backup is created before overwriting or removing files.";
        if (action.type === "remove-completely") {
          extra = "This removes the plugin from PC and mobile, disables it on both sides, and removes it from policy. Backups are created first.";
        }
        if (!confirm(`Apply ${label} for ${item.label}?\n\n${extra}`)) return;
        try {
          this.applyAction(action);
          new Notice(`Applied: ${label}`);
          this.refresh();
        } catch (error) {
          new Notice(error.message);
        }
      });
    });

    tbody.querySelectorAll("button[data-role='copy-config-key']").forEach((button) => {
      button.addEventListener("click", () => {
        const row = button.closest("tr");
        const item = this.data.items.find((entry) => entry.key === row.dataset.key);
        const property = button.dataset.property;
        const source = button.dataset.source;
        const label = `${source === "desktop" ? "PC -> Mobile" : "Mobile -> PC"} for ${item.label} / ${property}`;
        if (!confirm(`Copy this single config value?\n\n${label}\n\nThe target config file is backed up first.`)) return;
        try {
          this.copyConfigKey({ key: item.key, property, source });
          new Notice(`Copied: ${label}`);
          this.refresh();
        } catch (error) {
          new Notice(error.message);
        }
      });
    });
  }
}

module.exports = PluginSyncManagerPlugin;
