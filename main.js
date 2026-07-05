const { ItemView, Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");
const crypto = require("crypto");

const VIEW_TYPE = "extensions-sync-manager-view";
const DESKTOP = "desktop";
const MOBILE = "mobile";
const PLUGIN_DESIRED = ["both", "desktop-only", "mobile-only", "frozen", "ignore", "remove"];
const CONFIG_DESIRED = ["both", "prefer-desktop", "prefer-mobile", "frozen", "ignore"];
const ENABLED_STATES = ["enabled", "disabled"];
const MAX_CONFIG_DIFF_KEYS = 40;
const MAX_VALUE_PREVIEW_CHARS = 6000;

const DEFAULT_SETTINGS = {
  desktopConfigDir: ".obsidian",
  mobileConfigDir: ".obsidian_mobile",
  backupDir: ".obsidian/plugins/extensions-sync-manager/backups",
};

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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

function normalizeRelativePath(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function joinVaultPath(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).length > 0)
    .map((part) => String(part).replace(/^\/+|\/+$/g, ""))
    .join("/")
    .replace(/\/+/g, "/");
}

function parentVaultPath(relativePath) {
  const normalized = joinVaultPath(relativePath);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function relativeVaultPath(root, fullPath) {
  const normalizedRoot = joinVaultPath(root);
  const normalizedFullPath = joinVaultPath(fullPath);
  if (!normalizedRoot) return normalizedFullPath;
  return normalizedFullPath.startsWith(`${normalizedRoot}/`)
    ? normalizedFullPath.slice(normalizedRoot.length + 1)
    : normalizedFullPath;
}

function bufferFromArrayBuffer(arrayBuffer) {
  return Buffer.from(new Uint8Array(arrayBuffer));
}

class PluginSyncManagerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new PluginSyncManagerView(leaf, this));
    this.addSettingTab(new PluginSyncManagerSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "Extensions Sync Manager", () => this.activateView());
    this.addCommand({
      id: "open-manager",
      name: "Open Extensions Sync Manager",
      callback: () => this.activateView(),
    });
  }

  async loadSettings() {
    const rawData = await this.loadData() || {};
    const hasStructuredData = rawData.settings || rawData.policy || rawData.state;
    const savedSettings = hasStructuredData ? rawData.settings || {} : rawData;
    this.pluginData = {
      settings: Object.assign({}, DEFAULT_SETTINGS, savedSettings),
      policy: hasStructuredData ? rawData.policy || null : null,
      state: hasStructuredData ? rawData.state || { items: {} } : { items: {} },
    };
    this.settings = this.pluginData.settings;
  }

  async saveSettings() {
    await this.savePluginData();
  }

  async savePluginData() {
    this.pluginData.settings = this.settings;
    await this.saveData(this.pluginData);
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

class PluginSyncManagerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Paths").setHeading();

    this.addPathSetting(
      "Desktop config folder",
      "Folder that contains the desktop profile. Usually .obsidian.",
      "desktopConfigDir",
      DEFAULT_SETTINGS.desktopConfigDir
    );
    this.addPathSetting(
      "Mobile config folder",
      "Folder that contains the mobile profile. Usually .obsidian_mobile.",
      "mobileConfigDir",
      DEFAULT_SETTINGS.mobileConfigDir
    );
    this.addPathSetting(
      "Backup folder",
      "Files are backed up here before copy or remove actions.",
      "backupDir",
      DEFAULT_SETTINGS.backupDir
    );

  }

  addPathSetting(name, desc, key, fallback) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text
          .setPlaceholder(fallback)
          .setValue(this.plugin.settings[key])
          .onChange(async (value) => {
            this.plugin.settings[key] = normalizeRelativePath(value, fallback);
            await this.plugin.saveSettings();
          });
      });
  }

}

class PluginSyncManagerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.data = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Extensions Sync Manager";
  }

  getIcon() {
    return "refresh-cw";
  }

  async onOpen() {
    this.rootEl = this.contentEl || this.containerEl.children[1];
    this.rootEl.empty();
    this.rootEl.addClass("extensions-sync-manager");
    this.renderShell();
    await this.refresh();
  }

  onClose() {
    this.rootEl?.empty();
  }

  adapter() {
    return this.plugin.app.vault.adapter;
  }

  desktopRoot() {
    return this.plugin.settings.desktopConfigDir;
  }

  mobileRoot() {
    return this.plugin.settings.mobileConfigDir;
  }

  async readJson(relativePath, fallback) {
    const normalizedPath = joinVaultPath(relativePath);
    if (!await this.exists(normalizedPath)) return fallback;
    try {
      return JSON.parse(await this.adapter().read(normalizedPath));
    } catch (error) {
      throw new Error(`Could not read JSON: ${normalizedPath}. ${error.message}`);
    }
  }

  async writeJson(relativePath, data) {
    await this.writeText(relativePath, JSON.stringify(data, null, 2) + "\n");
  }

  async writeText(relativePath, text) {
    const normalizedPath = joinVaultPath(relativePath);
    await this.ensureFolder(parentVaultPath(normalizedPath));
    await this.adapter().write(normalizedPath, text);
  }

  async exists(relativePath) {
    return this.adapter().exists(joinVaultPath(relativePath));
  }

  async stat(relativePath) {
    if (!await this.exists(relativePath)) return null;
    return this.adapter().stat(joinVaultPath(relativePath));
  }

  async ensureFolder(relativePath) {
    const normalizedPath = joinVaultPath(relativePath);
    if (!normalizedPath || await this.exists(normalizedPath)) return;
    await this.ensureFolder(parentVaultPath(normalizedPath));
    await this.adapter().mkdir(normalizedPath);
  }

  timestamp() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  }

  async backupPath(relativePath, policy) {
    if (!await this.exists(relativePath)) return;
    const target = joinVaultPath(policy.backupRoot, this.timestamp(), relativePath);
    await this.copyPathDirect(relativePath, target);
  }

  loadPolicy() {
    return cloneJson(this.plugin.pluginData.policy || null);
  }

  savePolicy(policy) {
    this.plugin.pluginData.policy = cloneJson(policy);
    void this.plugin.savePluginData();
  }

  loadState() {
    return cloneJson(this.plugin.pluginData.state || { items: {} });
  }

  saveState(scan) {
    const items = {};
    for (const item of scan.items) {
      const entry = {
        desktopHash: item.desktop.hash || null,
        mobileHash: item.mobile.hash || null,
        scannedAt: scan.scannedAt,
      };
      if (item.kind === "config") {
        entry.desktopJsonKeys = this.jsonKeyHashes(item.desktop.json);
        entry.mobileJsonKeys = this.jsonKeyHashes(item.mobile.json);
      }
      items[item.key] = entry;
    }
    this.plugin.pluginData.state = { refreshedAt: scan.scannedAt, items };
    void this.plugin.savePluginData();
  }

  jsonKeyHashes(json) {
    if (!json || typeof json !== "object" || Array.isArray(json)) return {};
    const hashes = {};
    for (const key of Object.keys(json)) hashes[key] = valueHash(json[key]);
    return hashes;
  }

  async loadOrCreatePolicy() {
    let policy = this.loadPolicy();
    if (policy) return { policy, created: false };
    policy = await this.createDefaultPolicy();
    this.savePolicy(policy);
    return { policy, created: true };
  }

  async createDefaultPolicy() {
    const pluginIds = await this.listPluginIds();
    const configFiles = await this.listConfigFiles();
    const plugins = {};
    const desktopEnabled = await this.readEnabledPlugins(this.desktopRoot());
    const mobileEnabled = await this.readEnabledPlugins(this.mobileRoot());
    for (const id of pluginIds) {
      const desktopExists = await this.exists(`${this.desktopRoot()}/plugins/${id}`);
      const mobileExists = await this.exists(`${this.mobileRoot()}/plugins/${id}`);
      let mode = "both";
      if (desktopExists && !mobileExists) mode = "desktop-only";
      if (!desktopExists && mobileExists) mode = "mobile-only";
      plugins[id] = {
        mode,
        desktopEnabledState: desktopEnabled.has(id) ? "enabled" : "disabled",
        mobileEnabledState: mobileEnabled.has(id) ? "enabled" : "disabled",
      };
    }

    const rootConfigFiles = {};
    for (const file of configFiles) rootConfigFiles[file] = { mode: "frozen" };

    return {
      version: 1,
      roots: { desktop: this.desktopRoot(), mobile: this.mobileRoot() },
      backupRoot: this.plugin.settings.backupDir,
      plugins,
      rootConfigFiles,
    };
  }

  async normalizePolicy(policy) {
    policy.version = policy.version || 1;
    policy.roots = {
      ...(policy.roots || {}),
      desktop: this.desktopRoot(),
      mobile: this.mobileRoot(),
    };
    policy.backupRoot = this.plugin.settings.backupDir;
    policy.plugins = policy.plugins || {};
    policy.rootConfigFiles = policy.rootConfigFiles || {};

    for (const id of await this.listPluginIds()) {
      if (!policy.plugins[id]) {
        policy.plugins[id] = {
          mode: "both",
          desktopEnabledState: "enabled",
          mobileEnabledState: "enabled",
        };
      }
      policy.plugins[id].mode = policy.plugins[id].mode || "both";
      policy.plugins[id].desktopEnabledState = policy.plugins[id].desktopEnabledState || policy.plugins[id].enabledState || "enabled";
      policy.plugins[id].mobileEnabledState = policy.plugins[id].mobileEnabledState || policy.plugins[id].enabledState || "enabled";
    }

    for (const file of await this.listConfigFiles()) {
      if (!policy.rootConfigFiles[file]) policy.rootConfigFiles[file] = { mode: "frozen" };
    }
    return policy;
  }

  async listDir(relativePath) {
    const normalizedPath = joinVaultPath(relativePath);
    if (!await this.exists(normalizedPath)) return [];
    const listed = await this.adapter().list(normalizedPath);
    return [...listed.folders, ...listed.files]
      .map((entry) => relativeVaultPath(normalizedPath, entry))
      .sort();
  }

  async listPluginIds() {
    const ids = new Set();
    for (const root of [this.desktopRoot(), this.mobileRoot()]) {
      for (const entry of await this.listDir(`${root}/plugins`)) ids.add(entry);
      for (const id of await this.readEnabledPlugins(root)) ids.add(id);
    }
    const policy = this.loadPolicy();
    for (const id of Object.keys(policy?.plugins || {})) ids.add(id);
    return Array.from(ids).sort();
  }

  async listConfigFiles() {
    const ignored = new Set(["community-plugins.json", "plugins"]);
    const files = new Set();
    for (const root of [this.desktopRoot(), this.mobileRoot()]) {
      for (const entry of await this.listDir(root)) {
        if (ignored.has(entry)) continue;
        const relative = `${root}/${entry}`;
        const stat = await this.stat(relative);
        if (stat && stat.type === "file" && entry.endsWith(".json")) {
          files.add(entry);
        }
      }
    }
    const policy = this.loadPolicy();
    for (const file of Object.keys(policy?.rootConfigFiles || {})) files.add(file);
    return Array.from(files).sort();
  }

  async readEnabledPlugins(root) {
    return new Set(await this.readJson(`${root}/community-plugins.json`, []));
  }

  async writeEnabledPlugins(root, enabledSet) {
    await this.writeJson(`${root}/community-plugins.json`, Array.from(enabledSet).sort());
  }

  async setPluginEnabled(root, id, enabled) {
    const enabledSet = await this.readEnabledPlugins(root);
    if (enabled) enabledSet.add(id);
    else enabledSet.delete(id);
    await this.writeEnabledPlugins(root, enabledSet);
  }

  async describePath(relativePath) {
    const normalizedPath = joinVaultPath(relativePath);
    const stat = await this.stat(normalizedPath);
    if (!stat) {
      return { exists: false, hash: "", fileCount: 0, size: 0, mtimeMs: 0, json: null };
    }
    if (stat.type === "file") {
      const buffer = bufferFromArrayBuffer(await this.adapter().readBinary(normalizedPath));
      let json = null;
      if (normalizedPath.endsWith(".json")) {
        try {
          json = JSON.parse(buffer.toString("utf8"));
        } catch {
          json = null;
        }
      }
      return {
        exists: true,
        hash: crypto.createHash("sha256").update(buffer).digest("hex"),
        fileCount: 1,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        json,
      };
    }

    const hash = crypto.createHash("sha256");
    let fileCount = 0;
    let size = 0;
    let mtimeMs = stat.mtimeMs;
    for (const file of await this.walkFiles(normalizedPath)) {
      const relativeFile = relativeVaultPath(normalizedPath, file);
      const buffer = bufferFromArrayBuffer(await this.adapter().readBinary(file));
      const fileStat = await this.stat(file);
      hash.update(relativeFile);
      hash.update(buffer);
      fileCount += 1;
      size += fileStat.size;
      mtimeMs = Math.max(mtimeMs, fileStat.mtimeMs);
    }
    return { exists: true, hash: hash.digest("hex"), fileCount, size, mtimeMs, json: null };
  }

  async walkFiles(root) {
    const files = [];
    const normalizedRoot = joinVaultPath(root);
    if (!await this.exists(normalizedRoot)) return files;
    const listed = await this.adapter().list(normalizedRoot);
    for (const folder of listed.folders.sort()) files.push(...await this.walkFiles(folder));
    for (const file of listed.files.sort()) files.push(file);
    return files;
  }

  async readPluginVersion(root, id) {
    const manifest = await this.readJson(`${root}/plugins/${id}/manifest.json`, null);
    return manifest?.version || "";
  }

  itemActionOptions(item) {
    if (item.kind === "plugin") {
      const actions = [];
      if (item.desktop.exists) actions.push({ type: "desktop-to-mobile", key: item.key });
      if (item.mobile.exists) actions.push({ type: "mobile-to-desktop", key: item.key });
      actions.push({ type: "enforce-plugin-policy", key: item.key });
      actions.push({ type: "remove-completely", key: item.key });
      return actions;
    }
    const actions = [];
    if (item.desktop.exists) actions.push({ type: "desktop-to-mobile", key: item.key });
    if (item.mobile.exists) actions.push({ type: "mobile-to-desktop", key: item.key });
    return actions;
  }

  async scanPolicy(policy, state) {
    policy = await this.normalizePolicy(policy);
    const items = [];
    const desktopEnabled = await this.readEnabledPlugins(policy.roots.desktop);
    const mobileEnabled = await this.readEnabledPlugins(policy.roots.mobile);

    for (const id of Object.keys(policy.plugins).sort()) {
      const config = policy.plugins[id] || {};
      const desktop = await this.describePath(`${policy.roots.desktop}/plugins/${id}`);
      const mobile = await this.describePath(`${policy.roots.mobile}/plugins/${id}`);
      const desktopEnabledState = config.desktopEnabledState || config.enabledState || "enabled";
      const mobileEnabledState = config.mobileEnabledState || config.enabledState || "enabled";
      const item = {
        key: `plugin:${id}`,
        kind: "plugin",
        id,
        label: id,
        mode: config.mode || "both",
        desktopEnabledState,
        mobileEnabledState,
        desktop,
        mobile,
        desktopVersion: await this.readPluginVersion(policy.roots.desktop, id),
        mobileVersion: await this.readPluginVersion(policy.roots.mobile, id),
        desktopEnabled: desktopEnabled.has(id),
        mobileEnabled: mobileEnabled.has(id),
        status: desktop.exists && mobile.exists && desktop.hash === mobile.hash ? "same" : "different",
      };
      item.enabledDifferent = item.desktopEnabled !== item.mobileEnabled;
      items.push(item);
    }

    for (const fileName of Object.keys(policy.rootConfigFiles).sort()) {
      const config = policy.rootConfigFiles[fileName] || {};
      const desktop = await this.describePath(`${policy.roots.desktop}/${fileName}`);
      const mobile = await this.describePath(`${policy.roots.mobile}/${fileName}`);
      items.push({
        key: `config:${fileName}`,
        kind: "config",
        id: fileName,
        label: fileName,
        mode: config.mode || "frozen",
        desktop,
        mobile,
        status: desktop.exists && mobile.exists && desktop.hash === mobile.hash ? "same" : "different",
        changedKeys: this.changedJsonKeys(desktop.json, mobile.json),
        baseline: state.items?.[`config:${fileName}`] || null,
      });
    }

    return { scannedAt: new Date().toISOString(), policy, items };
  }

  changedJsonKeys(left, right) {
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return [];
    return Array.from(new Set([...Object.keys(left), ...Object.keys(right)]))
      .filter((key) => !jsonEqual(left[key], right[key]))
      .sort();
  }

  async currentScan() {
    const loaded = await this.loadOrCreatePolicy();
    const state = this.loadState();
    const scan = await this.scanPolicy(loaded.policy, state);
    if (loaded.created) this.savePolicy(scan.policy);
    return { scan, state, policyCreated: loaded.created };
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
    return {
      exists: item[side].exists,
      hash: item[side].hash ? item[side].hash.slice(0, 10) : "",
      fileCount: item[side].fileCount,
      size: item[side].size,
      mtimeMs: item[side].mtimeMs,
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
        primaryAction: desktopAbsent && mobileAbsent ? null : this.actionByType(item, "remove-completely"),
        secondaryActions: [],
      };
    }
    if (item.mode === "ignore") return { category: "ok", label: "Ignored", primaryAction: null, secondaryActions: [] };
    if (item.mode === "desktop-only") {
      const ok = desktopOk && mobileAbsent;
      return {
        category: ok ? "ok" : "needs",
        label: ok ? "Synced" : "Apply PC only",
        primaryAction: ok ? null : this.actionByType(item, "enforce-plugin-policy"),
        secondaryActions: [],
      };
    }
    if (item.mode === "mobile-only") {
      const ok = mobileOk && desktopAbsent;
      return {
        category: ok ? "ok" : "needs",
        label: ok ? "Synced" : "Apply mobile only",
        primaryAction: ok ? null : this.actionByType(item, "enforce-plugin-policy"),
        secondaryActions: [],
      };
    }
    if (item.mode === "frozen") {
      const same = item.rawStatus === "same" && !item.enabledDifferent;
      return { category: same ? "ok" : "review", label: same ? "Synced" : "Review only", primaryAction: null, secondaryActions: [] };
    }

    const same = item.desktop.exists && item.mobile.exists && item.rawStatus === "same" &&
      item.desktop.enabled === wantsDesktopEnabled && item.mobile.enabled === wantsMobileEnabled;
    const desktopToMobile = this.actionByType(item, "desktop-to-mobile");
    const mobileToDesktop = this.actionByType(item, "mobile-to-desktop");
    const enforcePolicy = this.actionByType(item, "enforce-plugin-policy");
    if (same) return { category: "ok", label: "Synced", primaryAction: null, secondaryActions: [] };
    if (!item.desktop.exists || !item.mobile.exists) return { category: "needs", label: "Apply desired state", primaryAction: enforcePolicy, secondaryActions: [] };
    if (item.rawStatus === "same") return { category: "needs", label: "Apply enabled states", primaryAction: enforcePolicy, secondaryActions: [] };
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

    if (item.mode === "ignore") return { category: "ok", label: "Ignored", primaryAction: null, secondaryActions: [] };
    if (item.mode === "frozen") return { category: same ? "ok" : "review", label: same ? "Synced" : "Review only", primaryAction: null, secondaryActions: [] };
    if (item.mode === "prefer-desktop") return { category: same ? "ok" : "needs", label: same ? "Synced" : "Prefer PC", primaryAction: same ? null : desktopToMobile, secondaryActions: [] };
    if (item.mode === "prefer-mobile") return { category: same ? "ok" : "needs", label: same ? "Synced" : "Prefer Mobile", primaryAction: same ? null : mobileToDesktop, secondaryActions: [] };
    if (same) return { category: "ok", label: "Synced", primaryAction: null, secondaryActions: [] };
    return {
      category: "needs",
      label: "Choose source",
      primaryAction: null,
      secondaryActions: [desktopToMobile, mobileToDesktop].filter(Boolean),
    };
  }

  compactItem(item, stateEntry) {
    const raw = {
      key: item.key,
      kind: item.kind,
      id: item.id,
      label: item.label,
      mode: item.mode,
      desktopEnabledState: item.desktopEnabledState || "enabled",
      mobileEnabledState: item.mobileEnabledState || "enabled",
      rawStatus: item.status,
      enabledDifferent: Boolean(item.enabledDifferent),
      desktop: this.compactSide(item, DESKTOP),
      mobile: this.compactSide(item, MOBILE),
      changedKeys: item.changedKeys || [],
      diffValues: this.configDiffValues(item, stateEntry),
      actions: this.itemActionOptions(item),
    };
    raw.desiredOptions = item.kind === "plugin" ? PLUGIN_DESIRED : CONFIG_DESIRED;
    raw.enabledOptions = ENABLED_STATES;
    const decision = item.kind === "plugin" ? this.pluginDecision(raw) : this.configDecision(raw);
    return { ...raw, decision };
  }

  async getData() {
    const { scan, state, policyCreated } = await this.currentScan();
    const items = scan.items.map((item) => this.compactItem(item, state.items?.[item.key]));
    const counts = items.reduce((acc, item) => {
      acc.total += 1;
      acc[item.kind] += 1;
      acc[item.decision.category] += 1;
      return acc;
    }, { total: 0, plugin: 0, config: 0, needs: 0, review: 0, ok: 0 });
    return { scannedAt: scan.scannedAt, policyCreated, counts, items };
  }

  async updatePolicy({ key, mode, desktopEnabledState, mobileEnabledState }) {
    const [kind, id] = String(key || "").split(":");
    if (!kind || !id) throw new Error("Missing key.");
    if (mode !== undefined && kind === "plugin" && !PLUGIN_DESIRED.includes(mode)) throw new Error(`Unsupported extension desired state: ${mode}`);
    if (mode !== undefined && kind === "config" && !CONFIG_DESIRED.includes(mode)) throw new Error(`Unsupported config desired state: ${mode}`);
    if (desktopEnabledState !== undefined && !ENABLED_STATES.includes(desktopEnabledState)) throw new Error(`Unsupported PC enabled state: ${desktopEnabledState}`);
    if (mobileEnabledState !== undefined && !ENABLED_STATES.includes(mobileEnabledState)) throw new Error(`Unsupported mobile enabled state: ${mobileEnabledState}`);

    const policy = await this.normalizePolicy(this.loadPolicy() || await this.createDefaultPolicy());
    if (kind === "plugin") {
      policy.plugins[id] = policy.plugins[id] || {};
      if (mode !== undefined) policy.plugins[id].mode = mode;
      if (desktopEnabledState !== undefined) policy.plugins[id].desktopEnabledState = desktopEnabledState;
      if (mobileEnabledState !== undefined) policy.plugins[id].mobileEnabledState = mobileEnabledState;
    } else if (kind === "config") {
      policy.rootConfigFiles[id] = policy.rootConfigFiles[id] || {};
      if (mode !== undefined) policy.rootConfigFiles[id].mode = mode;
    }
    this.savePolicy(policy);
  }

  async applyAction(action) {
    if (!action || !action.type || !action.key) throw new Error("Missing action.");
    const { scan } = await this.currentScan();
    const item = scan.items.find((entry) => entry.key === action.key);
    if (!item) throw new Error("Item not found.");
    const policy = scan.policy;

    if (item.kind === "plugin") await this.applyPluginAction(action, item, policy);
    else await this.applyConfigAction(action, item, policy);

    const next = await this.currentScan();
    this.saveState(next.scan);
  }

  async applyPluginAction(action, item, policy) {
    const id = item.id;
    const desktopPath = `${policy.roots.desktop}/plugins/${id}`;
    const mobilePath = `${policy.roots.mobile}/plugins/${id}`;
    if (action.type === "desktop-to-mobile") await this.copyPath(desktopPath, mobilePath, policy);
    else if (action.type === "mobile-to-desktop") await this.copyPath(mobilePath, desktopPath, policy);
    else if (action.type === "enforce-plugin-policy") await this.enforcePluginPolicy(item, policy);
    else if (action.type === "remove-completely") await this.removePluginCompletely(item, policy);
  }

  async applyConfigAction(action, item, policy) {
    const desktopPath = `${policy.roots.desktop}/${item.id}`;
    const mobilePath = `${policy.roots.mobile}/${item.id}`;
    if (action.type === "desktop-to-mobile") await this.copyPath(desktopPath, mobilePath, policy);
    if (action.type === "mobile-to-desktop") await this.copyPath(mobilePath, desktopPath, policy);
  }

  async enforcePluginPolicy(item, policy) {
    const id = item.id;
    const config = policy.plugins[id] || {};
    const mode = config.mode || "both";
    const desktopPath = `${policy.roots.desktop}/plugins/${id}`;
    const mobilePath = `${policy.roots.mobile}/plugins/${id}`;

    if (mode === "both") {
      if (item.desktop.exists && !item.mobile.exists) await this.copyPath(desktopPath, mobilePath, policy);
      if (!item.desktop.exists && item.mobile.exists) await this.copyPath(mobilePath, desktopPath, policy);
      await this.setPluginEnabled(policy.roots.desktop, id, config.desktopEnabledState !== "disabled");
      await this.setPluginEnabled(policy.roots.mobile, id, config.mobileEnabledState !== "disabled");
      return;
    }

    if (mode === "desktop-only") {
      if (!item.desktop.exists && item.mobile.exists) await this.copyPath(mobilePath, desktopPath, policy);
      await this.removePath(mobilePath, policy);
      await this.setPluginEnabled(policy.roots.desktop, id, config.desktopEnabledState !== "disabled");
      await this.setPluginEnabled(policy.roots.mobile, id, false);
      return;
    }

    if (mode === "mobile-only") {
      if (item.desktop.exists && !item.mobile.exists) await this.copyPath(desktopPath, mobilePath, policy);
      await this.removePath(desktopPath, policy);
      await this.setPluginEnabled(policy.roots.desktop, id, false);
      await this.setPluginEnabled(policy.roots.mobile, id, config.mobileEnabledState !== "disabled");
      return;
    }

    if (mode === "remove") await this.removePluginCompletely(item, policy);
  }

  async removePluginCompletely(item, policy) {
    await this.removePath(`${policy.roots.desktop}/plugins/${item.id}`, policy);
    await this.removePath(`${policy.roots.mobile}/plugins/${item.id}`, policy);
    await this.setPluginEnabled(policy.roots.desktop, item.id, false);
    await this.setPluginEnabled(policy.roots.mobile, item.id, false);
    delete policy.plugins[item.id];
    this.savePolicy(policy);
  }

  async copyPath(sourceRelative, targetRelative, policy) {
    if (!await this.exists(sourceRelative)) throw new Error(`Source does not exist: ${sourceRelative}`);
    await this.backupPath(targetRelative, policy);
    await this.removePathDirect(targetRelative);
    await this.copyPathDirect(sourceRelative, targetRelative);
  }

  async copyPathDirect(sourceRelative, targetRelative) {
    const source = joinVaultPath(sourceRelative);
    const target = joinVaultPath(targetRelative);
    const stat = await this.stat(source);
    if (!stat) return;
    if (stat.type === "file") {
      await this.ensureFolder(parentVaultPath(target));
      await this.adapter().writeBinary(target, await this.adapter().readBinary(source));
      return;
    }
    await this.ensureFolder(target);
    const listed = await this.adapter().list(source);
    for (const folder of listed.folders) {
      await this.copyPathDirect(folder, joinVaultPath(target, relativeVaultPath(source, folder)));
    }
    for (const file of listed.files) {
      await this.copyPathDirect(file, joinVaultPath(target, relativeVaultPath(source, file)));
    }
  }

  async removePath(relativePath, policy) {
    if (!await this.exists(relativePath)) return;
    await this.backupPath(relativePath, policy);
    await this.removePathDirect(relativePath);
  }

  async removePathDirect(relativePath) {
    const normalizedPath = joinVaultPath(relativePath);
    const stat = await this.stat(normalizedPath);
    if (!stat) return;
    if (stat.type === "folder") await this.adapter().rmdir(normalizedPath, true);
    else await this.adapter().remove(normalizedPath);
  }

  async refreshBaseline() {
    const { scan } = await this.currentScan();
    this.saveState(scan);
  }

  async copyConfigKey({ key, property, source }) {
    const [kind, fileName] = String(key || "").split(":");
    if (kind !== "config" || !fileName) throw new Error("Expected config key.");
    if (!property) throw new Error("Missing property.");
    if (![DESKTOP, MOBILE].includes(source)) throw new Error("Invalid source.");

    const { scan } = await this.currentScan();
    const policy = scan.policy;
    const sourceRoot = source === DESKTOP ? policy.roots.desktop : policy.roots.mobile;
    const targetRoot = source === DESKTOP ? policy.roots.mobile : policy.roots.desktop;
    const sourcePath = `${sourceRoot}/${fileName}`;
    const targetPath = `${targetRoot}/${fileName}`;
    const sourceJson = await this.readJson(sourcePath, {});
    const targetJson = await this.readJson(targetPath, {});

    await this.backupPath(targetPath, policy);
    if (Object.prototype.hasOwnProperty.call(sourceJson, property)) targetJson[property] = sourceJson[property];
    else delete targetJson[property];
    await this.writeJson(targetPath, targetJson);
    await this.refreshBaseline();
  }

  renderShell() {
    this.rootEl.replaceChildren();
    const title = document.createElement("h2");
    title.textContent = "Extensions Sync Manager";
    this.rootEl.appendChild(title);

    const toolbar = document.createElement("div");
    toolbar.addClass("psm-toolbar");
    this.rootEl.appendChild(toolbar);

    const search = document.createElement("input");
    search.addClass("psm-search");
    search.placeholder = "Search extension or config";
    toolbar.appendChild(search);

    const kindSelect = this.createSelect("psm-kind", [
      ["all", "All items"],
      ["plugin", "Extensions"],
      ["config", "Base configs"],
    ]);
    toolbar.appendChild(kindSelect);

    const viewSelect = this.createSelect("psm-view", [
      ["all", "Everything"],
      ["active", "Needs decision"],
      ["needs", "Needs action"],
      ["review", "Review only"],
      ["ok", "OK"],
    ]);
    toolbar.appendChild(viewSelect);

    const refreshButton = this.createButton("Refresh", "psm-refresh");
    toolbar.appendChild(refreshButton);
    const baselineButton = this.createButton("Refresh baseline", "psm-baseline");
    toolbar.appendChild(baselineButton);

    const summary = document.createElement("div");
    summary.addClass("psm-summary");
    this.rootEl.appendChild(summary);

    const status = document.createElement("div");
    status.addClass("psm-statusbar");
    status.textContent = "Loading...";
    this.rootEl.appendChild(status);

    const table = document.createElement("table");
    table.addClass("psm-table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Item", "Desired", "PC enabled", "Mobile enabled", "Actual", "Status", "Action", "Details"]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    table.appendChild(document.createElement("tbody"));
    this.rootEl.appendChild(table);

    this.rootEl.querySelector(".psm-search").addEventListener("input", () => this.renderRows());
    this.rootEl.querySelector(".psm-kind").addEventListener("change", () => this.renderRows());
    this.rootEl.querySelector(".psm-view").addEventListener("change", () => this.renderRows());
    this.rootEl.querySelector(".psm-refresh").addEventListener("click", () => this.refresh());
    this.rootEl.querySelector(".psm-baseline").addEventListener("click", async () => {
      if (!confirm("Refresh baseline hashes without copying files?")) return;
      try {
        await this.refreshBaseline();
        new Notice("Extension sync baseline refreshed.");
        await this.refresh();
      } catch (error) {
        new Notice(error.message);
      }
    });
  }

  createSelect(className, options) {
    const select = document.createElement("select");
    select.addClass(className);
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    return select;
  }

  createButton(label, className) {
    const button = document.createElement("button");
    button.addClass("psm-button");
    if (className) button.addClass(className);
    button.textContent = label;
    return button;
  }

  async refresh() {
    try {
      this.data = await this.getData();
      this.renderSummary();
      this.renderRows();
    } catch (error) {
      this.setMessage(error.stack || error.message);
      new Notice(error.message);
    }
  }

  async refreshKeepingPosition() {
    const scrollTop = this.rootEl?.scrollTop || 0;
    await this.refresh();
    if (this.rootEl) this.rootEl.scrollTop = scrollTop;
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
      ["Extensions", c.plugin],
      ["Configs", c.config],
    ];
    const summary = this.rootEl.querySelector(".psm-summary");
    summary.replaceChildren();
    for (const [label, value] of cards) {
      const card = document.createElement("div");
      card.addClass("psm-metric");
      const count = document.createElement("strong");
      count.textContent = String(value);
      const text = document.createElement("span");
      text.textContent = label;
      card.append(count, text);
      summary.appendChild(card);
    }
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
    const extensionLabels = {
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
    return (kind === "plugin" ? extensionLabels : config)[mode] || mode;
  }

  actionLabel(action, item) {
    const labels = {
      "desktop-to-mobile": "PC -> Mobile",
      "mobile-to-desktop": "Mobile -> PC",
      "remove-completely": "Remove completely",
      "enforce-plugin-policy": "Apply desired state",
    };
    if (action.type === "desktop-to-mobile" && item.mode === "prefer-desktop") return "Apply desired state";
    if (action.type === "mobile-to-desktop" && item.mode === "prefer-mobile") return "Apply desired state";
    return labels[action.type] || action.type;
  }

  sideText(item, sideName) {
    const side = item[sideName];
    const name = sideName === DESKTOP ? "PC" : "Mobile";
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
    return `${this.sideText(item, DESKTOP)}. ${this.sideText(item, MOBILE)}.`;
  }

  renderRows() {
    const rows = this.data.items.filter((item) => this.passesFilters(item));
    const tbody = this.rootEl.querySelector("tbody");
    tbody.replaceChildren();
    for (const item of rows) {
      const row = document.createElement("tr");
      row.dataset.key = item.key;
      if (item.decision.category === "ok") row.addClass("psm-row-ok");

      const nameCell = document.createElement("td");
      const name = document.createElement("div");
      name.addClass("psm-item-name");
      name.textContent = item.label;
      const kind = document.createElement("div");
      kind.addClass("psm-meta");
      kind.textContent = item.kind === "plugin" ? "extension" : item.kind;
      nameCell.append(name, kind);
      row.appendChild(nameCell);

      const desiredCell = document.createElement("td");
      desiredCell.appendChild(this.createDesiredSelect(item));
      row.appendChild(desiredCell);

      const desktopEnabledCell = document.createElement("td");
      this.appendEnabledControl(desktopEnabledCell, item, DESKTOP);
      row.appendChild(desktopEnabledCell);

      const mobileEnabledCell = document.createElement("td");
      this.appendEnabledControl(mobileEnabledCell, item, MOBILE);
      row.appendChild(mobileEnabledCell);

      const actualCell = document.createElement("td");
      const actual = document.createElement("div");
      actual.addClass("psm-actual");
      actual.textContent = this.actualText(item);
      actualCell.appendChild(actual);
      row.appendChild(actualCell);

      const statusCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.addClass("psm-badge");
      badge.addClass(`psm-badge-${item.decision.category}`);
      badge.textContent = item.decision.label;
      statusCell.appendChild(badge);
      row.appendChild(statusCell);

      const actionCell = document.createElement("td");
      this.appendActionControls(actionCell, item);
      row.appendChild(actionCell);

      const detailsCell = document.createElement("td");
      this.appendDetails(detailsCell, item);
      row.appendChild(detailsCell);

      tbody.appendChild(row);
    }
    this.bindRowEvents(tbody);
    this.setMessage(`${rows.length} visible. Last scan: ${this.data.scannedAt}`);
  }

  createDesiredSelect(item) {
    const select = document.createElement("select");
    select.dataset.role = "desired";
    for (const mode of item.desiredOptions) {
      const option = document.createElement("option");
      option.value = mode;
      option.selected = mode === item.mode;
      option.textContent = this.desiredLabel(item.kind, mode);
      select.appendChild(option);
    }
    return select;
  }

  appendEnabledControl(cell, item, side) {
    if (item.kind !== "plugin") {
      const meta = document.createElement("span");
      meta.addClass("psm-meta");
      meta.textContent = "-";
      cell.appendChild(meta);
      return;
    }
    if (!this.enabledSideApplies(item, side)) {
      const meta = document.createElement("span");
      meta.addClass("psm-meta");
      meta.textContent = "-";
      meta.title = "This side is not used by the desired state.";
      cell.appendChild(meta);
      return;
    }
    const selected = side === DESKTOP ? item.desktopEnabledState : item.mobileEnabledState;
    const select = document.createElement("select");
    select.dataset.role = `${side}-enabled`;
    for (const value of item.enabledOptions) {
      const option = document.createElement("option");
      option.value = value;
      option.selected = value === selected;
      option.textContent = value === "enabled" ? "Enabled" : "Disabled";
      select.appendChild(option);
    }
    cell.appendChild(select);
  }

  enabledSideApplies(item, side) {
    if (item.mode === "desktop-only") return side === DESKTOP;
    if (item.mode === "mobile-only") return side === MOBILE;
    if (item.mode === "remove") return false;
    return true;
  }

  appendActionControls(cell, item) {
    const actions = [];
    if (item.decision.primaryAction) actions.push(item.decision.primaryAction);
    actions.push(...(item.decision.secondaryActions || []));
    if (!actions.length) {
      const meta = document.createElement("span");
      meta.addClass("psm-meta");
      meta.textContent = "No action needed";
      cell.appendChild(meta);
      return;
    }
    const wrapper = document.createElement("div");
    wrapper.addClass("psm-actions");
    for (const action of actions) {
      const button = this.createButton(this.actionLabel(action, item));
      if (action === item.decision.primaryAction) {
        button.addClass(action.type === "remove-completely" ? "psm-button-danger" : "psm-button-primary");
      }
      button.dataset.role = "apply-action";
      button.dataset.action = JSON.stringify(action);
      wrapper.appendChild(button);
    }
    cell.appendChild(wrapper);
  }

  appendDetails(cell, item) {
    if (item.kind === "config" && item.diffValues && item.diffValues.length) {
      const details = document.createElement("details");
      details.addClass("psm-details");
      const summary = document.createElement("summary");
      summary.textContent = `${item.diffValues.length} changed value(s)`;
      details.appendChild(summary);

      for (const entry of item.diffValues) {
        const diffItem = document.createElement("div");
        diffItem.addClass("psm-diff-item");
        const key = document.createElement("div");
        key.addClass("psm-diff-key");
        key.textContent = entry.key;
        diffItem.appendChild(key);

        const grid = document.createElement("div");
        grid.addClass("psm-diff-grid");
        this.appendDiffSide(grid, item, entry, DESKTOP);
        this.appendDiffSide(grid, item, entry, MOBILE);
        diffItem.appendChild(grid);
        details.appendChild(diffItem);
      }
      cell.appendChild(details);
      return;
    }

    const details = document.createElement("div");
    details.addClass("psm-details-summary");
    const bits = [];
    if (item.desktop.hash) bits.push(`PC hash ${item.desktop.hash}`);
    if (item.mobile.hash) bits.push(`Mobile hash ${item.mobile.hash}`);
    if (!bits.length) bits.push("No extra details");
    for (const bit of bits) {
      const line = document.createElement("div");
      line.textContent = bit;
      details.appendChild(line);
    }
    cell.appendChild(details);
  }

  appendDiffSide(grid, item, entry, side) {
    const sideData = side === DESKTOP ? entry.desktop : entry.mobile;
    const changed = side === DESKTOP ? entry.desktopChangedSinceBaseline : entry.mobileChangedSinceBaseline;
    const sideEl = document.createElement("div");
    sideEl.addClass("psm-diff-side");

    const label = document.createElement("div");
    label.addClass("psm-diff-label");
    const title = document.createElement("span");
    title.textContent = side === DESKTOP ? "PC" : "Mobile";
    if (changed) {
      const flag = document.createElement("span");
      flag.addClass("psm-changed-flag");
      flag.textContent = "changed";
      title.append(" ", flag);
    }
    label.appendChild(title);

    const button = this.createButton(side === DESKTOP ? "PC -> Mobile" : "Mobile -> PC", "psm-mini-button");
    button.dataset.role = "copy-config-key";
    button.dataset.source = side;
    button.dataset.property = entry.key;
    label.appendChild(button);
    sideEl.appendChild(label);

    const pre = document.createElement("pre");
    pre.addClass("psm-value");
    pre.textContent = sideData.text;
    sideEl.appendChild(pre);
    grid.appendChild(sideEl);
  }

  bindRowEvents(tbody) {
    tbody.querySelectorAll("select[data-role='desired']").forEach((select) => {
      select.addEventListener("change", async () => {
        const key = select.closest("tr").dataset.key;
        try {
          await this.updatePolicy({ key, mode: select.value });
          new Notice("Desired state updated.");
          await this.refreshKeepingPosition();
        } catch (error) {
          new Notice(error.message);
        }
      });
    });

    tbody.querySelectorAll("select[data-role='desktop-enabled']").forEach((select) => {
      select.addEventListener("change", async () => {
        const key = select.closest("tr").dataset.key;
        try {
          await this.updatePolicy({ key, desktopEnabledState: select.value });
          new Notice("PC enabled preference updated.");
          await this.refreshKeepingPosition();
        } catch (error) {
          new Notice(error.message);
        }
      });
    });

    tbody.querySelectorAll("select[data-role='mobile-enabled']").forEach((select) => {
      select.addEventListener("change", async () => {
        const key = select.closest("tr").dataset.key;
        try {
          await this.updatePolicy({ key, mobileEnabledState: select.value });
          new Notice("Mobile enabled preference updated.");
          await this.refreshKeepingPosition();
        } catch (error) {
          new Notice(error.message);
        }
      });
    });

    tbody.querySelectorAll("button[data-role='apply-action']").forEach((button) => {
      button.addEventListener("click", async () => {
        const row = button.closest("tr");
        const item = this.data.items.find((entry) => entry.key === row.dataset.key);
        const action = JSON.parse(button.dataset.action);
        const label = this.actionLabel(action, item);
        let extra = "A backup is created before overwriting or removing files.";
        if (action.type === "remove-completely") {
          extra = "This removes the extension from PC and mobile, disables it on both sides, and removes it from policy. Backups are created first.";
        }
        if (!confirm(`Apply ${label} for ${item.label}?\n\n${extra}`)) return;
        try {
          await this.applyAction(action);
          new Notice(`Applied: ${label}`);
          await this.refreshKeepingPosition();
        } catch (error) {
          new Notice(error.message);
        }
      });
    });

    tbody.querySelectorAll("button[data-role='copy-config-key']").forEach((button) => {
      button.addEventListener("click", async () => {
        const row = button.closest("tr");
        const item = this.data.items.find((entry) => entry.key === row.dataset.key);
        const property = button.dataset.property;
        const source = button.dataset.source;
        const label = `${source === DESKTOP ? "PC -> Mobile" : "Mobile -> PC"} for ${item.label} / ${property}`;
        if (!confirm(`Copy this single config value?\n\n${label}\n\nThe target config file is backed up first.`)) return;
        try {
          await this.copyConfigKey({ key: item.key, property, source });
          new Notice(`Copied: ${label}`);
          await this.refreshKeepingPosition();
        } catch (error) {
          new Notice(error.message);
        }
      });
    });
  }
}

module.exports = PluginSyncManagerPlugin;
