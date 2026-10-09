// ===== FOLDER SYNC (File System Access API) =====
// 同期フォルダ内の「作品タイトル.json」と NovelBoard のデータを読み書きする。
// 形式は既存エクスポートと同じ。PC版Chrome/Edgeのみ対応（非対応環境ではボタンを出さない）。
(function () {
  if (!('showDirectoryPicker' in window)) return;

  const TABS = ['chars', 'places', 'plot', 'terms', 'notes'];
  const LIST_KEYS = [...TABS, 'relations'];
  const LABELS = { chars: '👤 キャラ', places: '🗺️ 場所', plot: '📖 あらすじ', terms: '📚 用語', notes: '💡 メモ', relations: '🔗 関係' };
  const BACKUP_DIR = '_backup';
  const AUTOSAVE_KEY = 'nb_fs_autosave';

  let dirHandle = null;
  let permission = 'none';     // 'none' | 'granted' | 'prompt'
  let autosaveTimer = null;
  let busy = false;
  let ignoredLastModified = {}; // 「あとで」を押したファイル更新は同じ版で再通知しない
  let pendingLoad = null;       // { link, fileObj, lastModified, text }

  // ---------- IndexedDB ----------
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('nb_folder_sync', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const r = db.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  // 作品ID → { fileName, lastModified, hash }
  const getLink = id => idbGet('link_' + id);
  const setLink = (id, link) => idbSet('link_' + id, link);

  // ---------- データ整形 ----------
  // 書き出し・比較に使う形（_syncTime など内部用キーは含めない）
  function normalize(obj) {
    const g = obj.groups || {};
    const out = { projectTitle: obj.projectTitle || '' };
    TABS.forEach(t => { out[t] = Array.isArray(obj[t]) ? obj[t] : []; });
    out.groups = {};
    TABS.forEach(t => { out.groups[t] = Array.isArray(g[t]) ? g[t] : []; });
    out.relations = Array.isArray(obj.relations) ? obj.relations : [];
    return out;
  }
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  function hashOf(obj) {
    const s = stable(normalize(obj));
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16) + '_' + s.length;
  }
  function safeFileName(title) {
    const base = (title || '').trim().replace(/[\\/:*?"<>|]/g, '_') || '無題';
    return base + '.json';
  }
  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  function parseJSONText(text) {
    return JSON.parse(text.replace(/^﻿/, ''));
  }

  // ---------- 形式チェック ----------
  function validate(data) {
    const errors = [];
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return ['ファイルの中身がオブジェクト（{ ... }）ではありません'];
    }
    if ('projectTitle' in data && typeof data.projectTitle !== 'string') errors.push('projectTitle が文字列ではありません');
    TABS.forEach(t => {
      if (!Array.isArray(data[t])) errors.push(`${t} が配列ではありません（無い場合も [] が必要です）`);
    });
    if ('relations' in data && !Array.isArray(data.relations)) errors.push('relations が配列ではありません');
    if ('groups' in data) {
      if (typeof data.groups !== 'object' || data.groups === null || Array.isArray(data.groups)) errors.push('groups がオブジェクトではありません');
      else TABS.forEach(t => {
        if (t in data.groups && !Array.isArray(data.groups[t])) errors.push(`groups.${t} が配列ではありません`);
      });
    }
    LIST_KEYS.forEach(k => {
      if (!Array.isArray(data[k])) return;
      const seen = new Set();
      data[k].forEach((item, i) => {
        const where = `${k}[${i}]`;
        if (typeof item !== 'object' || item === null || Array.isArray(item)) { errors.push(`${where} がオブジェクトではありません`); return; }
        if ((typeof item.id !== 'string' && typeof item.id !== 'number') || item.id === '') { errors.push(`${where} に id がありません`); return; }
        if (seen.has(item.id)) errors.push(`${where} の id「${item.id}」が重複しています`);
        seen.add(item.id);
        Object.entries(item).forEach(([f, v]) => {
          if (v !== null && v !== undefined && typeof v !== 'string' && typeof v !== 'number') {
            errors.push(`${where}.${f} が文字列・数値ではありません`);
          }
        });
      });
    });
    if (Array.isArray(data.relations) && Array.isArray(data.chars)) {
      const ids = new Set(data.chars.map(c => c && c.id));
      data.relations.forEach((r, i) => {
        if (!r || typeof r !== 'object') return;
        ['charA', 'charB'].forEach(f => {
          if (!ids.has(r[f])) errors.push(`relations[${i}].${f}「${r[f]}」が chars の id に見つかりません`);
        });
      });
    }
    return errors;
  }

  // ---------- 差分 ----------
  function diff(current, incoming) {
    const rows = LIST_KEYS.map(k => {
      const cur = new Map((current[k] || []).map(x => [x.id, x]));
      const inc = new Map((incoming[k] || []).map(x => [x.id, x]));
      let added = 0, changed = 0, missing = 0;
      inc.forEach((v, id) => {
        if (!cur.has(id)) added++;
        else if (stable(cur.get(id)) !== stable(v)) changed++;
      });
      cur.forEach((_, id) => { if (!inc.has(id)) missing++; });
      return { key: k, added, changed, missing };
    });
    const n = normalize(incoming), c = normalize(current);
    return {
      rows,
      titleChanged: n.projectTitle && n.projectTitle !== c.projectTitle ? n.projectTitle : null,
      groupsChanged: stable(n.groups) !== stable(c.groups),
    };
  }

  // ---------- フォルダ・ファイル操作 ----------
  async function checkPermission(request) {
    if (!dirHandle) { permission = 'none'; return false; }
    const opts = { mode: 'readwrite' };
    let p = await dirHandle.queryPermission(opts);
    if (p !== 'granted' && request) p = await dirHandle.requestPermission(opts);
    permission = p === 'granted' ? 'granted' : 'prompt';
    return permission === 'granted';
  }
  async function getFileHandle(name, create) {
    try { return await dirHandle.getFileHandle(name, { create: !!create }); }
    catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
  }
  async function writeText(fileHandle, text) {
    const w = await fileHandle.createWritable();
    await w.write(text);
    await w.close();
  }
  async function writeBackup(obj, suffix) {
    const dir = await dirHandle.getDirectoryHandle(BACKUP_DIR, { create: true });
    const base = safeFileName(obj.projectTitle).replace(/\.json$/, '');
    const name = `${base}_${stamp()}${suffix || ''}.json`;
    const fh = await dir.getFileHandle(name, { create: true });
    await writeText(fh, JSON.stringify(normalize(obj), null, 2));
    return `${BACKUP_DIR}/${name}`;
  }
  async function listJsonFiles() {
    const files = [];
    for await (const [name, h] of dirHandle.entries()) {
      if (h.kind === 'file' && name.toLowerCase().endsWith('.json')) files.push(name);
    }
    return files.sort((a, b) => a.localeCompare(b, 'ja'));
  }

  // ---------- 状態表示 ----------
  async function appDirty() {
    const link = await getLink(getActiveId());
    return !!link && link.hash !== hashOf(state);
  }
  async function refreshUI() {
    const btn = document.getElementById('fs-btn');
    const rec = document.getElementById('fs-reconnect-btn');
    if (!btn) return;
    btn.style.display = '';
    rec.style.display = permission === 'prompt' ? '' : 'none';
    const dirty = permission === 'granted' && await appDirty();
    btn.querySelector('.fs-dot').style.display = dirty ? '' : 'none';
    btn.title = dirty ? 'フォルダ同期（未保存の変更あり）' : 'フォルダ同期';
    const modal = document.getElementById('modal-fsync');
    if (modal && !modal.classList.contains('hidden') && document.getElementById('fs-body').dataset.view === 'main') renderModal();
  }

  // ---------- 同期フォルダ選択・再接続 ----------
  async function pickFolder() {
    try {
      const h = await window.showDirectoryPicker({ id: 'novelboard-sync', mode: 'readwrite' });
      dirHandle = h;
      await idbSet('dir', h);
      await checkPermission(true);
      showToast(`📁 同期フォルダ「${h.name}」を選択しました`);
      await refreshUI();
      checkExternal();
    } catch (e) {
      if (e.name !== 'AbortError') alert('フォルダを選択できませんでした：' + e.message);
    }
  }
  async function reconnect() {
    try {
      if (await checkPermission(true)) {
        showToast('🔌 同期フォルダに再接続しました');
        checkExternal();
      }
    } catch (e) { alert('再接続できませんでした：' + e.message); }
    await refreshUI();
  }

  // ---------- 作品とファイルの紐付け ----------
  async function openLinkChooser() {
    if (!(await ensureReady())) return;
    const files = await listJsonFiles();
    const activeId = getActiveId();
    // 他の作品に紐付いているファイル名
    const owners = {};
    for (const p of getProjects()) {
      if (p.id === activeId) continue;
      const l = await getLink(p.id);
      if (l) owners[l.fileName] = p.title || '（無題）';
    }
    const newName = safeFileName(state.projectTitle);
    const body = document.getElementById('fs-body');
    body.dataset.view = 'link';
    body.innerHTML = `
      <p class="fs-note">この作品（${esc(state.projectTitle || '（無題）')}）と結びつけるファイルを選んでください。</p>
      <div class="fs-file-list">
        ${files.map(f => `
          <div class="fs-file-row">
            <span class="fs-file-name">📄 ${esc(f)}${owners[f] ? `<small>（「${esc(owners[f])}」と紐付け中）</small>` : ''}</span>
            <button class="btn btn-secondary btn-sm" data-fs-link="${esc(f)}">紐付け</button>
          </div>`).join('') || '<p class="fs-note">フォルダに .json ファイルがありません</p>'}
      </div>
      ${files.includes(newName) ? '' : `<button class="btn btn-primary" data-fs-link-new="${esc(newName)}" style="padding:10px;">＋ 新規ファイル「${esc(newName)}」を作って紐付け</button>`}
      <button class="btn btn-ghost" data-fs-act="back" style="padding:8px;">戻る</button>`;
  }
  async function linkFile(name, isNew) {
    const activeId = getActiveId();
    if (isNew) {
      await setLink(activeId, { fileName: name, lastModified: 0, hash: null });
      await saveToFolder();
    } else {
      await setLink(activeId, { fileName: name, lastModified: 0, hash: null });
      showToast(`🔗「${name}」と紐付けました`);
    }
    renderModal();
    refreshUI();
  }

  async function ensureReady() {
    if (!dirHandle) { await pickFolder(); return permission === 'granted'; }
    if (permission !== 'granted') return await checkPermission(true).catch(() => false);
    return true;
  }
  async function ensureLink() {
    const link = await getLink(getActiveId());
    if (link) return link;
    await openModal();
    await openLinkChooser();
    return null;
  }

  // ---------- 保存 ----------
  // auto: 自動保存か / force: 外部更新があってもアプリ側で上書き（確認済み）
  async function saveToFolder({ auto = false, force = false } = {}) {
    if (!(await ensureReady())) return;
    const activeId = getActiveId();
    const link = auto ? await getLink(activeId) : await ensureLink();
    if (!link) return;
    const curHash = hashOf(state);
    if (auto && link.hash === curHash) return;

    const fh = await getFileHandle(link.fileName, true);
    const file = await fh.getFile();
    let fileHash = null;
    if (file.size > 0) {
      const text = await file.text();
      try { fileHash = hashOf(parseJSONText(text)); } catch { fileHash = 'broken'; }
    }
    const fileChanged = file.size > 0 && fileHash !== link.hash && fileHash !== curHash;
    if (fileChanged && !force) {
      if (auto) {
        if (ignoredLastModified[link.fileName] !== file.lastModified) await notifyExternal(link, file, true);
        return;
      }
      const ok = confirm(`「${link.fileName}」はアプリの外で書き換えられています。\nアプリの内容でファイルを上書きしますか？\n（今のファイルは _backup フォルダに保存されます）`);
      if (!ok) return;
    }
    if (fileChanged) {
      // 上書き前にファイル側をバックアップ（壊れたJSONならそのまま退避）
      const text = await file.text();
      const dir = await dirHandle.getDirectoryHandle(BACKUP_DIR, { create: true });
      const bh = await dir.getFileHandle(`${link.fileName.replace(/\.json$/i, '')}_${stamp()}_file.json`, { create: true });
      await writeText(bh, text);
    }
    await writeText(fh, JSON.stringify(normalize(state), null, 2));
    const written = await fh.getFile();
    await setLink(activeId, { fileName: link.fileName, lastModified: written.lastModified, hash: curHash });
    if (!auto) showToast(`💾「${link.fileName}」に保存しました`);
    refreshUI();
  }

  function scheduleAutosave() {
    refreshUI();
    if (localStorage.getItem(AUTOSAVE_KEY) !== '1' || permission !== 'granted') return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      saveToFolder({ auto: true }).catch(e => console.warn('Folder autosave failed:', e));
    }, 2000);
  }

  // ---------- 読み込み ----------
  async function loadFromFolder() {
    if (!(await ensureReady())) return;
    const link = await ensureLink();
    if (!link) return;
    const fh = await getFileHandle(link.fileName, false);
    if (!fh) { alert(`「${link.fileName}」がフォルダに見つかりません。`); return; }
    const file = await fh.getFile();
    await prepareLoad(link, file);
  }

  async function prepareLoad(link, file) {
    const text = await file.text();
    let data;
    try { data = parseJSONText(text); }
    catch (e) { showErrors(link.fileName, ['JSONとして読めません：' + e.message]); return; }
    const errors = validate(data);
    if (errors.length) { showErrors(link.fileName, errors); return; }
    pendingLoad = { link, data, lastModified: file.lastModified };
    const d = diff(state, data);
    const dirty = link.hash !== null && link.hash !== hashOf(state);
    await openModal();
    const db = document.getElementById('fs-body');
    db.dataset.view = 'diff';
    db.innerHTML = `
      <p class="fs-note">「${esc(link.fileName)}」の内容を反映する前に、変更点を確認してください。</p>
      ${dirty ? '<p class="fs-warn">⚠️ アプリ側にも、前回の同期のあとで変更があります。置き換えるとアプリ側の変更は消えます（反映前に _backup に保存されます）。</p>' : ''}
      ${d.titleChanged ? `<p class="fs-note">作品タイトル → 「${esc(d.titleChanged)}」</p>` : ''}
      <table class="fs-diff">
        <tr><th></th><th>追加</th><th>変更</th><th>ファイルに無い</th></tr>
        ${d.rows.map(r => `<tr><td>${LABELS[r.key]}</td><td>${r.added}</td><td>${r.changed}</td><td>${r.missing}</td></tr>`).join('')}
      </table>
      ${d.groupsChanged ? '<p class="fs-note">グループ定義にも変更があります。</p>' : ''}
      <p class="fs-note" style="font-size:0.75rem;">「ファイルに無い」項目は、<b>置き換え</b>では削除され、<b>IDで統合</b>では残ります。</p>
      <button class="btn btn-primary" data-fs-act="apply-merge" style="padding:10px;">🔀 IDで統合（同じIDは上書き・新しいIDは追加・他は残す）</button>
      <button class="btn btn-secondary" data-fs-act="apply-replace" style="padding:10px;">🔄 置き換え（ファイルの内容で丸ごと置き換え）</button>
      <button class="btn btn-ghost" data-fs-act="back" style="padding:8px;">キャンセル</button>`;
  }

  function showErrors(fileName, errors) {
    openModal().then(() => {
      const shown = errors.slice(0, 30);
      const eb = document.getElementById('fs-body');
      eb.dataset.view = 'error';
      eb.innerHTML = `
        <p class="fs-warn">❌「${esc(fileName)}」は形式が正しくないため、読み込みませんでした。データは変更されていません。</p>
        <ul class="fs-errors">${shown.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
        ${errors.length > shown.length ? `<p class="fs-note">ほか ${errors.length - shown.length} 件</p>` : ''}
        <button class="btn btn-ghost" data-fs-act="back" style="padding:8px;">戻る</button>`;
    });
  }

  async function applyLoad(mode) {
    const p = pendingLoad;
    pendingLoad = null;
    if (!p) return;
    const backup = await writeBackup(state);
    const inc = normalize(p.data);
    if (mode === 'replace') {
      Object.assign(state, inc);
    } else {
      LIST_KEYS.forEach(k => {
        const idx = new Map(state[k].map((x, i) => [x.id, i]));
        inc[k].forEach(item => {
          if (idx.has(item.id)) state[k][idx.get(item.id)] = item;
          else state[k].push(item);
        });
      });
      TABS.forEach(t => inc.groups[t].forEach(g => { if (!state.groups[t].includes(g)) state.groups[t].push(g); }));
      if (inc.projectTitle) state.projectTitle = inc.projectTitle;
    }
    applyStateCompat();
    // 統合した場合はファイルと内容が一致しないので、未保存の変更として残す
    const fileHash = hashOf(p.data);
    await setLink(getActiveId(), { fileName: p.link.fileName, lastModified: p.lastModified, hash: fileHash });
    document.getElementById('project-title-input').value = state.projectTitle || '';
    save();
    relNodes = {};
    renderChars(); renderPlaces(); renderPlot(); renderTerms(); renderNotes();
    updateBadges(); renderTimeline();
    closeFsModal();
    showToast(`✅ ${mode === 'replace' ? '置き換え' : 'IDで統合し'}ました（バックアップ：${backup}）`);
    refreshUI();
  }

  // ---------- 外部での更新の検知 ----------
  async function checkExternal() {
    if (busy || permission !== 'granted' || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      if (!(await checkPermission(false))) { refreshUI(); return; }
      const link = await getLink(getActiveId());
      if (!link || !link.lastModified) return;
      const fh = await getFileHandle(link.fileName, false);
      if (!fh) return;
      const file = await fh.getFile();
      if (file.lastModified === link.lastModified) return;
      if (ignoredLastModified[link.fileName] === file.lastModified) return;
      let fileHash;
      try { fileHash = hashOf(parseJSONText(await file.text())); } catch { fileHash = 'broken'; }
      if (fileHash === link.hash) {
        // 中身が同じ（保存し直されただけ）なら静かに記録を更新
        await setLink(getActiveId(), { ...link, lastModified: file.lastModified });
        return;
      }
      await notifyExternal(link, file, link.hash !== hashOf(state));
    } catch (e) {
      console.warn('Folder check failed:', e);
    } finally { busy = false; }
  }

  async function notifyExternal(link, file, bothChanged) {
    pendingLoad = null;
    await openModal();
    const body = document.getElementById('fs-body');
    body.dataset.view = 'external';
    body.dataset.lastModified = file.lastModified;
    body.innerHTML = bothChanged ? `
      <p class="fs-warn">⚠️「${esc(link.fileName)}」が外部で更新されていますが、アプリ側にもまだ保存していない変更があります。どちらを残しますか？</p>
      <button class="btn btn-primary" data-fs-act="ext-load" style="padding:10px;">📥 ファイルの内容を読み込む（変更点を確認してから反映）</button>
      <button class="btn btn-secondary" data-fs-act="ext-keep-app" style="padding:10px;">💾 アプリの内容でファイルを上書き（ファイルは _backup に保存）</button>
      <button class="btn btn-ghost" data-fs-act="ext-later" style="padding:8px;">あとで決める</button>` : `
      <p class="fs-note">📥 フォルダのファイル「${esc(link.fileName)}」が外部で更新されています。読み込みますか？</p>
      <button class="btn btn-primary" data-fs-act="ext-load" style="padding:10px;">変更点を確認して読み込む</button>
      <button class="btn btn-ghost" data-fs-act="ext-later" style="padding:8px;">あとで</button>`;
    body.dataset.fileName = link.fileName;
  }

  // ---------- モーダル ----------
  function injectUI() {
    const style = document.createElement('style');
    style.textContent = `
      .fs-note { font-size:0.85rem; color:var(--text2); line-height:1.6; margin:0; }
      .fs-note small { margin-left:4px; }
      .fs-warn { font-size:0.85rem; line-height:1.6; margin:0; padding:8px 12px; border-radius:8px; background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.4); }
      .fs-status { font-size:0.85rem; padding:8px 12px; background:var(--bg); border-radius:8px; border:1px solid var(--border); line-height:1.7; word-break:break-all; }
      .fs-file-list { display:flex; flex-direction:column; gap:6px; max-height:260px; overflow-y:auto; }
      .fs-file-row { display:flex; align-items:center; gap:8px; justify-content:space-between; padding:6px 10px; background:var(--bg); border:1px solid var(--border); border-radius:8px; }
      .fs-file-name { font-size:0.85rem; word-break:break-all; }
      .fs-diff { width:100%; border-collapse:collapse; font-size:0.85rem; }
      .fs-diff th, .fs-diff td { padding:4px 6px; border-bottom:1px solid var(--border); text-align:center; }
      .fs-diff td:first-child { text-align:left; }
      .fs-errors { margin:0; padding-left:20px; font-size:0.82rem; max-height:240px; overflow-y:auto; line-height:1.6; }
      .fs-row { display:flex; gap:8px; flex-wrap:wrap; }
      .fs-row .btn { flex:1; padding:10px; }
      .fs-dot { color:var(--accent); font-size:0.7rem; margin-left:2px; }
    `;
    document.head.appendChild(style);

    const tools = document.querySelector('.header-tools');
    const exportBtn = tools.querySelector('[onclick="exportData()"]');
    const rec = document.createElement('button');
    rec.id = 'fs-reconnect-btn';
    rec.className = 'btn btn-primary btn-sm';
    rec.style.display = 'none';
    rec.textContent = '🔌 フォルダに再接続';
    rec.onclick = reconnect;
    const btn = document.createElement('button');
    btn.id = 'fs-btn';
    btn.className = 'btn btn-ghost btn-sm';
    btn.style.display = 'none';
    btn.innerHTML = '📁<span class="tool-label">同期</span><span class="fs-dot" style="display:none">●</span>';
    btn.onclick = openModal;
    tools.insertBefore(rec, exportBtn);
    tools.insertBefore(btn, exportBtn);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay hidden';
    overlay.id = 'modal-fsync';
    overlay.innerHTML = `
      <div class="modal" style="max-width:480px;gap:12px;">
        <h2>📁 フォルダ同期</h2>
        <div id="fs-body" style="display:flex;flex-direction:column;gap:10px;"></div>
        <button class="btn btn-ghost" data-fs-act="close" style="padding:8px;">閉じる</button>
      </div>`;
    overlay.addEventListener('click', e => {
      if (e.target === overlay) { closeFsModal(); return; }
      const el = e.target.closest('[data-fs-act],[data-fs-link],[data-fs-link-new]');
      if (el) handleAction(el).catch(err => alert('エラー：' + err.message));
    });
    document.body.appendChild(overlay);
  }

  async function handleAction(el) {
    if (el.dataset.fsLink !== undefined) return linkFile(el.dataset.fsLink, false);
    if (el.dataset.fsLinkNew !== undefined) return linkFile(el.dataset.fsLinkNew, true);
    const body = document.getElementById('fs-body');
    switch (el.dataset.fsAct) {
      case 'close': return closeFsModal();
      case 'back': pendingLoad = null; return renderModal();
      case 'pick': return pickFolder();
      case 'reconnect': return reconnect();
      case 'link': return openLinkChooser();
      case 'load': return loadFromFolder();
      case 'save': return saveToFolder();
      case 'apply-merge': return applyLoad('merge');
      case 'apply-replace': return applyLoad('replace');
      case 'ext-load': return loadFromFolder();
      case 'ext-keep-app': await saveToFolder({ force: true }); return closeFsModal();
      case 'ext-later':
        ignoredLastModified[body.dataset.fileName] = Number(body.dataset.lastModified);
        return closeFsModal();
    }
  }

  async function openModal() {
    document.getElementById('modal-fsync').classList.remove('hidden');
    await renderModal();
  }
  function closeFsModal() {
    pendingLoad = null;
    document.getElementById('modal-fsync').classList.add('hidden');
  }

  async function renderModal() {
    const body = document.getElementById('fs-body');
    const link = await getLink(getActiveId());
    const dirty = permission === 'granted' && link && link.hash !== hashOf(state);
    const auto = localStorage.getItem(AUTOSAVE_KEY) === '1';
    body.dataset.view = 'main';
    let status;
    if (!dirHandle) status = '同期フォルダ：<b>未選択</b>';
    else if (permission !== 'granted') status = `同期フォルダ：<b>${esc(dirHandle.name)}</b>（⚠️ 再接続が必要）`;
    else status = `同期フォルダ：<b>${esc(dirHandle.name)}</b>`;
    status += `<br>この作品のファイル：<b>${link ? esc(link.fileName) : '未紐付け'}</b>`;
    if (dirty) status += '<br><span style="color:var(--accent);">● アプリ側に、まだフォルダへ保存していない変更があります</span>';
    body.innerHTML = `
      <div class="fs-status">${status}</div>
      <div class="fs-row">
        <button class="btn btn-secondary" data-fs-act="pick">📂 同期フォルダを選択</button>
        ${dirHandle && permission !== 'granted' ? '<button class="btn btn-primary" data-fs-act="reconnect">🔌 フォルダに再接続</button>' : ''}
      </div>
      ${dirHandle && permission === 'granted' ? `
      <button class="btn btn-ghost" data-fs-act="link" style="padding:8px;">🔗 ${link ? '紐付けるファイルを変更' : 'この作品とファイルを紐付け'}</button>
      <div class="fs-row">
        <button class="btn btn-primary" data-fs-act="load">📥 フォルダから読み込む</button>
        <button class="btn btn-primary" data-fs-act="save">💾 フォルダに保存</button>
      </div>
      <label class="fs-note" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
        <input type="checkbox" id="fs-autosave" ${auto ? 'checked' : ''}> 自動保存（変更から2秒後にフォルダへ保存）
      </label>` : ''}
      <p class="fs-note" style="font-size:0.75rem;">※ 読み込んで反映する前に、今のデータを同期フォルダの _backup に保存します。<br>※ ファイル名は紐付けた時点のまま固定です（作品タイトルを変えても変わりません）。</p>`;
    const cb = document.getElementById('fs-autosave');
    if (cb) cb.onchange = () => {
      localStorage.setItem(AUTOSAVE_KEY, cb.checked ? '1' : '0');
      if (cb.checked) scheduleAutosave();
    };
  }

  // ---------- 起動 ----------
  async function init() {
    injectUI();
    try {
      dirHandle = (await idbGet('dir')) || null;
      if (dirHandle) await checkPermission(false);
    } catch (e) { console.warn('Folder sync init failed:', e); }
    await refreshUI();
    checkExternal();
    document.addEventListener('visibilitychange', checkExternal);
    window.addEventListener('focus', checkExternal);
  }

  // save() から呼ばれる
  window.fsOnLocalChange = scheduleAutosave;
  init();
})();
