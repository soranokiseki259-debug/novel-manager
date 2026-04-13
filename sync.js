// ===== Novel Manager - Firebase Cloud Sync =====

// Firebase Config
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC7mi1a40P_a3Elei2BD47Bqs6Cb4vuHzU",
  authDomain: "novel-manager-ae7ff.firebaseapp.com",
  projectId: "novel-manager-ae7ff",
  storageBucket: "novel-manager-ae7ff.firebasestorage.app",
  messagingSenderId: "108575754503",
  appId: "1:108575754503:web:840c4bf1cefddf7fc35da2"
};

// State
let _fb = null;       // firebase app
let _auth = null;     // auth instance
let _db = null;       // firestore instance
let _user = null;     // current user
let _syncDebounce = null;

// ===== Firebase SDK Loader =====
function loadFirebaseSDK() {
  return new Promise((resolve, reject) => {
    if (window._firebaseLoaded) { resolve(); return; }
    const modules = [
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js'
    ];
    let loaded = 0;
    modules.forEach(src => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => { loaded++; if (loaded === modules.length) { window._firebaseLoaded = true; resolve(); } };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  });
}

// ===== Init =====
async function initSync() {
  try {
    await loadFirebaseSDK();
    _fb = firebase.initializeApp(FIREBASE_CONFIG);
    _auth = firebase.auth();
    _db = firebase.firestore();

    // Listen auth state
    _auth.onAuthStateChanged(user => {
      _user = user;
      updateSyncUI();
      if (user) {
        pullFromCloud();
      }
    });
  } catch (e) {
    console.warn('Firebase init failed:', e);
  }
}

// ===== Auth =====
async function syncLogin() {
  if (!_auth) return;
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await _auth.signInWithPopup(provider);
  } catch (e) {
    // Try redirect for mobile
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/popup-closed-by-user') {
      const provider = new firebase.auth.GoogleAuthProvider();
      await _auth.signInWithRedirect(provider);
    } else {
      console.warn('Login failed:', e);
      syncToast('ログインに失敗しました');
    }
  }
}

function syncLogout() {
  if (_auth) _auth.signOut();
}

// ===== Cloud Read =====
async function pullFromCloud() {
  if (!_user || !_db) return;
  try {
    const uid = _user.uid;

    // Pull settings projects
    const projSnap = await _db.collection('users').doc(uid).collection('settings_projects').get();
    if (!projSnap.empty) {
      const projects = [];
      projSnap.forEach(doc => {
        const data = doc.data();
        projects.push({ id: doc.id, title: data.projectTitle || '無題' });
        // Merge: cloud wins if local doesn't exist or cloud is newer
        const localRaw = localStorage.getItem('nb_proj_' + doc.id);
        const localData = localRaw ? JSON.parse(localRaw) : null;
        const cloudTime = data._syncTime || 0;
        const localTime = localData?._syncTime || 0;
        if (!localData || cloudTime >= localTime) {
          localStorage.setItem('nb_proj_' + doc.id, JSON.stringify(data));
        }
      });
      // Merge project list
      const localProjects = JSON.parse(localStorage.getItem('nb_projects') || '[]');
      const merged = [...localProjects];
      projects.forEach(cp => {
        if (!merged.find(lp => lp.id === cp.id)) {
          merged.push(cp);
        }
      });
      localStorage.setItem('nb_projects', JSON.stringify(merged));
    }

    // Pull editor data
    const editorDoc = await _db.collection('users').doc(uid).collection('editor_data').doc('main').get();
    if (editorDoc.exists) {
      const cloudData = editorDoc.data();
      const localRaw = localStorage.getItem('novel_editor_data');
      const localData = localRaw ? JSON.parse(localRaw) : null;
      const cloudTime = cloudData._syncTime || 0;
      const localTime = localData?._syncTime || 0;
      if (!localData || cloudTime >= localTime) {
        localStorage.setItem('novel_editor_data', JSON.stringify(cloudData));
      }
    }

    syncToast('クラウドから同期しました');
    // Reload page to reflect new data
    if (typeof loadProjects === 'function') loadProjects();
    if (typeof loadState === 'function') loadState();
    if (typeof init === 'function' && document.title.includes('エディタ')) location.reload();

  } catch (e) {
    console.warn('Pull failed:', e);
  }
}

// ===== Cloud Write =====
function pushToCloud(type, key, data) {
  if (!_user || !_db) return;

  // Add sync timestamp
  data._syncTime = Date.now();

  // Also update localStorage with timestamp
  if (type === 'settings') {
    localStorage.setItem('nb_proj_' + key, JSON.stringify(data));
  } else if (type === 'editor') {
    localStorage.setItem('novel_editor_data', JSON.stringify(data));
  }

  // Debounced cloud push
  clearTimeout(_syncDebounce);
  _syncDebounce = setTimeout(async () => {
    try {
      const uid = _user.uid;
      if (type === 'settings') {
        await _db.collection('users').doc(uid).collection('settings_projects').doc(key).set(data);
        // Also update project list
        const projects = JSON.parse(localStorage.getItem('nb_projects') || '[]');
        await _db.collection('users').doc(uid).set({ projectList: projects }, { merge: true });
      } else if (type === 'editor') {
        await _db.collection('users').doc(uid).collection('editor_data').doc('main').set(data);
      }
      updateSyncIndicator('synced');
    } catch (e) {
      console.warn('Push failed:', e);
      updateSyncIndicator('error');
    }
  }, 2000);

  updateSyncIndicator('syncing');
}

// ===== Sync Settings Project (helper) =====
function syncSettingsProject(projectId, data) {
  pushToCloud('settings', projectId, data);
}

function syncEditorData(data) {
  pushToCloud('editor', 'main', data);
}

// ===== UI =====
function createSyncUI() {
  const container = document.createElement('div');
  container.id = 'sync-ui';
  container.innerHTML = `
    <style>
      #sync-ui {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #sync-status {
        font-size: 0.72rem;
        color: var(--text2, #94a3b8);
        white-space: nowrap;
      }
      #sync-login-btn {
        padding: 5px 12px;
        font-size: 0.75rem;
        font-weight: 600;
        border: 1px solid var(--border, #2d3748);
        border-radius: 6px;
        background: var(--card, #1e2a3a);
        color: var(--text, #e2e8f0);
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.15s;
      }
      #sync-login-btn:hover { border-color: var(--accent, #e94560); }
      #sync-user-info {
        display: none;
        align-items: center;
        gap: 6px;
        font-size: 0.75rem;
        color: var(--text2, #94a3b8);
      }
      #sync-user-info.show { display: flex; }
      #sync-avatar {
        width: 22px;
        height: 22px;
        border-radius: 50%;
      }
      #sync-logout-btn {
        padding: 3px 8px;
        font-size: 0.68rem;
        border: 1px solid var(--border, #2d3748);
        border-radius: 4px;
        background: transparent;
        color: var(--text2, #94a3b8);
        cursor: pointer;
      }
      #sync-toast {
        position: fixed;
        top: 60px;
        right: 16px;
        background: var(--card2, #253347);
        color: var(--text, #e2e8f0);
        padding: 8px 16px;
        border-radius: 8px;
        font-size: 0.8rem;
        opacity: 0;
        transition: opacity 0.3s;
        z-index: 9999;
        border: 1px solid var(--border, #2d3748);
        pointer-events: none;
      }
      #sync-toast.show { opacity: 1; }
    </style>
    <span id="sync-status"></span>
    <button id="sync-login-btn" onclick="syncLogin()">&#x2601; ログイン</button>
    <div id="sync-user-info">
      <img id="sync-avatar" src="" alt="">
      <span id="sync-username"></span>
      <button id="sync-logout-btn" onclick="syncLogout()">ログアウト</button>
    </div>
  `;

  // Insert toast
  const toast = document.createElement('div');
  toast.id = 'sync-toast';
  document.body.appendChild(toast);

  return container;
}

function updateSyncUI() {
  const loginBtn = document.getElementById('sync-login-btn');
  const userInfo = document.getElementById('sync-user-info');
  const avatar = document.getElementById('sync-avatar');
  const username = document.getElementById('sync-username');

  if (!loginBtn) return;

  if (_user) {
    loginBtn.style.display = 'none';
    userInfo.classList.add('show');
    if (_user.photoURL) avatar.src = _user.photoURL;
    else avatar.style.display = 'none';
    username.textContent = _user.displayName || 'ログイン中';
  } else {
    loginBtn.style.display = '';
    userInfo.classList.remove('show');
  }
}

function updateSyncIndicator(state) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  switch (state) {
    case 'syncing': el.textContent = '同期中…'; break;
    case 'synced': el.textContent = '同期済み ✓'; setTimeout(() => { el.textContent = ''; }, 3000); break;
    case 'error': el.textContent = '同期エラー'; break;
    default: el.textContent = '';
  }
}

function syncToast(msg) {
  const el = document.getElementById('sync-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// ===== Auto-init =====
document.addEventListener('DOMContentLoaded', () => {
  // Insert sync UI into header
  const syncUI = createSyncUI();
  const header = document.querySelector('header');
  if (header) {
    // Insert before the last element or spacer
    const spacer = header.querySelector('.header-spacer');
    if (spacer) {
      spacer.after(syncUI);
    } else {
      header.appendChild(syncUI);
    }
  }
  initSync();
});
