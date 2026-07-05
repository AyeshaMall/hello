
        (function() {
            const AyeshaApp = {};
            window.AyeshaApp = AyeshaApp;

            // ─── State ────────────────────────────────────────────────────────────────
            const state = {
                projectName: 'Untitled Project',
                theme: 'dark',
                fontSize: 14,
                tabSize: 4,
                wordWrap: 'on',
                minimap: 'on',
                lineNumbers: 'on',
                fileTree: {},
                openTabs: [],
                activeTabPath: null,
                selectedFiles: [],
                clipboard: null,
                clipboardIndicatorTimeout: null,
                monacoEditor: null,
                monacoModelCache: {},
                activePanel: 'explorer',
                undoStack: [],
                redoStack: [],
                recentFiles: [],
                isPreviewOpen: false,
                projectHistory: [],
            };

            window.MONACO_INITIALIZED = false;
            window.MONACO_LOADING = false;
            window.COMPLETION_PROVIDER_REGISTERED = false;
            window.APP_INITIALIZED = false;

            const STORAGE_KEY = 'ayeshamall_editor_project';
            const HISTORY_KEY = 'ayeshamall_editor_history';
            const MEDIA_DB_NAME = 'AyeshaMallMedia';
            const MEDIA_STORE = 'media';

            let mediaDB = null;
            const loader = document.getElementById("loader");

            // ─── IndexedDB Helpers ──────────────────────────────────────────────────
            function openMediaDB() {
                return new Promise((resolve, reject) => {
                    if (mediaDB) return resolve(mediaDB);
                    const req = indexedDB.open(MEDIA_DB_NAME, 1);
                    req.onupgradeneeded = (e) => {
                        const db = e.target.result;
                        if (!db.objectStoreNames.contains(MEDIA_STORE)) {
                            db.createObjectStore(MEDIA_STORE, { keyPath: 'path' });
                        }
                    };
                    req.onsuccess = (e) => {
                        mediaDB = e.target.result;
                        resolve(mediaDB);
                    };
                    req.onerror = () => reject(req.error);
                });
            }

            async function saveMediaToDB(path, blob) {
                const db = await openMediaDB();
                return new Promise((resolve, reject) => {
                    const tx = db.transaction(MEDIA_STORE, 'readwrite');
                    const store = tx.objectStore(MEDIA_STORE);
                    store.put({ path, blob });
                    tx.oncomplete = resolve;
                    tx.onerror = reject;
                });
            }

            async function loadMediaFromDB(path) {
                if (!path) return null;
                const db = await openMediaDB();
                return new Promise((resolve, reject) => {
                    const tx = db.transaction(MEDIA_STORE, 'readonly');
                    const store = tx.objectStore(MEDIA_STORE);
                    const req = store.get(path);
                    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
                    req.onerror = () => reject(req.error);
                });
            }

            async function getAllMediaFromDB() {
                const db = await openMediaDB();
                return new Promise((resolve, reject) => {
                    const tx = db.transaction(MEDIA_STORE, 'readonly');
                    const store = tx.objectStore(MEDIA_STORE);
                    const req = store.getAll();
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = reject;
                });
            }

            function normalizePath(path) {

    if (!path) return "";

    path = path.replace(/\\/g, "/");

    // Remove virtual root folder
    path = path.replace(/^root\//, "");

    // Ensure leading slash
    if (!path.startsWith("/")) {
        path = "/" + path;
    }

    return path;
}

            function joinPath(...parts) {
                return parts.map(p => normalizePath(p)).filter(Boolean).join('/');
            }

            // ─── Serialization / Deserialization ──────────────────────────────────
            function serializeFileTree(node) {
                const s = { name: node.name, type: node.type };
                if (node.type === 'file') {
                    if (node.blobData) {
                        s.hasBlob = true;
                        s.mediaType = node.mediaType || '';
                    } else {
                        s.content = node.content || '';
                    }
                } else if (node.type === 'folder' && node.children) {
                    s.children = {};
                    for (const [key, child] of Object.entries(node.children)) {
                        s.children[key] = serializeFileTree(child);
                    }
                }
                return s;
            }

            async function deserializeFileTree(sNode, currentPath = '') {
                const node = {
                    name: sNode.name,
                    type: sNode.type,
                    content: '',
                    children: {},
                    blobUrl: null,
                    blobData: null,
                    mediaType: '',
                };
                const fullPath = currentPath ? `${currentPath}/${sNode.name}` : sNode.name;
                const normPath = normalizePath(fullPath);

                if (node.type === 'file') {
                    if (sNode.hasBlob) {
                        node.mediaType = sNode.mediaType || '';
                        try {
                            const blob = await loadMediaFromDB(normPath);
                            if (blob) {
                                node.blobData = blob;
                                node.blobUrl = URL.createObjectURL(blob);
                            } else {
                                console.warn('Blob not found for path:', normPath);
                            }
                        } catch (err) {
                            console.error('Failed to load blob for path:', normPath, err);
                        }
                    } else {
                        node.content = sNode.content || '';
                    }
                } else {
                    for (const [key, child] of Object.entries(sNode.children || {})) {
                        node.children[key] = await deserializeFileTree(child, fullPath);
                    }
                }
                return node;
            }

            // ─── Save / Load Project ──────────────────────────────────────────────
            function saveProject() {
                saveCurrentFile();
                const toSave = {
                    projectName: state.projectName,
                    theme: state.theme,
                    fontSize: state.fontSize,
                    tabSize: state.tabSize,
                    wordWrap: state.wordWrap,
                    minimap: state.minimap,
                    lineNumbers: state.lineNumbers,
                    fileTree: serializeFileTree(state.fileTree),
                    openTabs: state.openTabs.map(t => ({ path: t.path, dirty: false })),
                    activeTabPath: state.activeTabPath,
                    recentFiles: state.recentFiles,
                };
                localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
                updateProjectHistory();
                showToast('Project saved!', 'success');
            }

            async function loadProject() {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (raw) {
                    try {
                        const data = JSON.parse(raw);
                        state.projectName = data.projectName || 'Untitled Project';
                        state.theme = data.theme || 'dark';
                        state.fontSize = data.fontSize || 14;
                        state.tabSize = data.tabSize || 4;
                        state.wordWrap = data.wordWrap || 'on';
                        state.minimap = data.minimap || 'on';
                        state.lineNumbers = data.lineNumbers || 'on';
                        state.recentFiles = data.recentFiles || [];

                        if (data.fileTree) {
                            state.fileTree = await deserializeFileTree(data.fileTree, '');
                        } else {
                            initDefaultProject();
                        }

                        state.openTabs = (data.openTabs || []).map(t => ({
                            ...t,
                            dirty: false,
                            cursorState: null,
                            scrollState: null,
                        }));
                        state.activeTabPath = data.activeTabPath || null;

                        renderImageGrid();
                    } catch (e) {
                        console.error('Load project error:', e);
                        initDefaultProject();
                    }
                } else {
                    initDefaultProject();
                }
                applySettings();
            }

            function initDefaultProject() {
                state.fileTree = {
                    name: 'root',
                    type: 'folder',
                    children: {
                        'index.html': {
                            name: 'index.html',
                            type: 'file',
                            content: [
                                '<!DOCTYPE html>',
                                '<html lang="en">',
                                '<head>',
                                '    <meta charset="UTF-8">',
                                '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
                                '    <title>My Project</title>',
                                '    <link rel="stylesheet" href="style.css">',
                                '</head>',
                                '<body>',
                                '    <h1>Hello World!</h1>',
                                '</body>',
                                '</html>'
                            ].join('\n'),
                            children: {},
                            blobUrl: null,
                            blobData: null,
                            mediaType: '',
                        },
                        'style.css': {
                            name: 'style.css',
                            type: 'file',
                            content: [
                                'body {',
                                '    margin: 40px;',
                                '    font-family: Arial, sans-serif;',
                                '    background: #f0f0f0;',
                                '}',
                                'h1 {',
                                '    color: #333;',
                                '    cursor: pointer;',
                                '}'
                            ].join('\n'),
                            children: {},
                            blobUrl: null,
                            blobData: null,
                            mediaType: '',
                        },
                        'script.js': {
                            name: 'script.js',
                            type: 'file',
                            content: [
                                "console.log('Hello from AyeshaMall Editor!');",
                                "const heading = document.querySelector('h1');",
                                "if (heading) {",
                                "    heading.addEventListener('click', () => {",
                                "        alert('Clicked!');",
                                "    });",
                                "}"
                            ].join('\n'),
                            children: {},
                            blobUrl: null,
                            blobData: null,
                            mediaType: '',
                        },
                    },
                };
                state.openTabs = [];
                state.activeTabPath = null;
                state.recentFiles = [];
            }

            function updateProjectHistory() {
                const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
                const entry = { name: state.projectName, date: new Date().toISOString(), fileCount: countFiles(state
                        .fileTree) };
                const idx = history.findIndex(h => h.name === entry.name);
                if (idx >= 0) history[idx] = entry;
                else history.unshift(entry);
                if (history.length > 20) history.length = 20;
                localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
                state.projectHistory = history;
            }

            function countFiles(node) {
                if (node.type === 'file') return 1;
                if (node.children) return Object.values(node.children).reduce((sum, c) => sum + countFiles(c), 0);
                return 0;
            }

            // ─── Tree Helpers ──────────────────────────────────────────────────────
            function getNodeByPath(path, root = state.fileTree) {
                if (!path || path === '/' || path === '') return root;
                const parts = normalizePath(path).split('/').filter(Boolean);
                let current = root;
                for (const part of parts) {
                    if (current.type !== 'folder' || !current.children || !current.children[part]) return null;
                    current = current.children[part];
                }
                return current;
            }

            function getParentPath(path) {
                const parts = normalizePath(path).split('/').filter(Boolean);
                parts.pop();
                return '/' + parts.join('/');
            }

            function getFullPath(node, root = state.fileTree, currentPath = '') {
                if (node === root) return '/';
                for (const [key, child] of Object.entries(root.children || {})) {
                    const childPath = currentPath + '/' + key;
                    if (child === node) return childPath;
                    if (child.type === 'folder') {
                        const found = getFullPath(node, child, childPath);
                        if (found) return found;
                    }
                }
                return null;
            }

            function getNodeName(path) {
                const parts = normalizePath(path).split('/').filter(Boolean);
                return parts[parts.length - 1] || 'root';
            }

            function getAllFilePaths(node = state.fileTree, base = '') {
                let paths = [];
                if (node.type === 'file') {
                    paths.push((base + '/' + node.name).replace(/^\/+/, ''));
                } else if (node.children) {
                    for (const [key, child] of Object.entries(node.children)) {
                        paths = paths.concat(getAllFilePaths(child, base + '/' + key));
                    }
                }
                return paths;
            }

            function getAllFolderPaths(node = state.fileTree, base = '') {
                let paths = ['/'];
                if (node.type === 'folder' && node.children) {
                    for (const [key, child] of Object.entries(node.children)) {
                        if (child.type === 'folder') {
                            const p = base + '/' + key;
                            paths.push(p);
                            paths = paths.concat(getAllFolderPaths(child, p));
                        }
                    }
                }
                return paths;
            }

            function ensureFolderPath(path) {
                const parts = normalizePath(path).split('/').filter(Boolean);
                let current = state.fileTree;
                for (const part of parts) {
                    if (!current.children) current.children = {};
                    if (!current.children[part]) {
                        current.children[part] = { name: part, type: 'folder', children: {}, blobUrl: null, blobData: null,
                            mediaType: '' };
                    }
                    current = current.children[part];
                }
                return current;
            }

            // ─── Monaco Editor ─────────────────────────────────────────────────────
            function initMonaco() {
                if (window.MONACO_INITIALIZED) return;
                if (window.MONACO_LOADING) return;
                if (window.monaco && window.monaco.editor) {
                    window.MONACO_INITIALIZED = true;
                    setupMonacoEditor();
                    return;
                }
                if (typeof require === 'undefined') {
                    setTimeout(initMonaco, 2000);
                    return;
                }
                window.MONACO_LOADING = true;
                require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' } });
                require(['vs/editor/editor.main'], function() {
                    window.MONACO_INITIALIZED = true;
                    window.MONACO_LOADING = false;
                    setupMonacoEditor();
                }, function(err) {
                    window.MONACO_LOADING = false;
                    console.error('Monaco load error:', err);
                    setTimeout(initMonaco, 2000);
                });
            }

            function setupMonacoEditor() {
                if (state.monacoEditor) return;
                const container = document.getElementById('monaco-container');
                if (!container) return;
                try {
                    state.monacoEditor = monaco.editor.create(container, {
                        value: '',
                        language: 'plaintext',
                        theme: state.theme === 'light' ? 'vs' : state.theme === 'high-contrast' ? 'hc-black' :
                            'vs-dark',
                        fontSize: state.fontSize,
                        tabSize: state.tabSize,
                        wordWrap: state.wordWrap,
                        minimap: { enabled: state.minimap === 'on' },
                        lineNumbers: state.lineNumbers,
                        automaticLayout: true,
                        scrollBeyondLastLine: false,
                        renderWhitespace: 'selection',
                        bracketPairColorization: { enabled: true },
                        autoClosingBrackets: 'always',
                        autoClosingQuotes: 'always',
                        autoIndent: 'full',
                        formatOnPaste: true,
                        suggest: { showWords: true, showSnippets: true },
                    });

                    if (!window.COMPLETION_PROVIDER_REGISTERED) {
                        window.COMPLETION_PROVIDER_REGISTERED = true;
                        monaco.languages.registerCompletionItemProvider(['html', 'css', 'javascript', 'typescript'], {
                            provideCompletionItems: (model, position) => {
                                const word = model.getWordUntilPosition(position);
                                const range = new monaco.Range(
                                    position.lineNumber, word.startColumn,
                                    position.lineNumber, word.endColumn
                                );
                                const suggestions = [];
                                const allMedia = getAllMediaPaths();
                                allMedia.forEach(mp => {
                                    const fileName = mp.split('/').pop();
                                    suggestions.push({
                                        label: mp,
                                        kind: monaco.languages.CompletionItemKind.File,
                                        insertText: mp,
                                        range,
                                        detail: 'Media file',
                                    });
                                });
                                return { suggestions: suggestions.slice(0, 50) };
                            }
                        });
                    }

                    state.monacoEditor.onDidChangeCursorPosition((e) => {
                        const statusEl = document.getElementById('status-position');
                        if (statusEl) statusEl.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
                    });

                    state.monacoEditor.onDidChangeModelContent(() => {
                        if (state.activeTabPath) {
                            const tab = state.openTabs.find(t => t.path === state.activeTabPath);
                            if (tab && state.monacoEditor.getModel()) {
                                const currentContent = state.monacoEditor.getModel().getValue();
                                const node = getNodeByPath(state.activeTabPath);
                                if (node && node.type === 'file' && !node.blobData) {
                                    tab.dirty = (currentContent !== (node.content || ''));
                                }
                            }
                            updateTabBar();
                        }
                    });

                    applySettings();
                    refreshEditor();

                    const welcomeScreen = document.getElementById('welcome-screen');
                    if (welcomeScreen) welcomeScreen.classList.add('hidden');
                } catch (e) {
                    console.error('Monaco setup error:', e);
                }
            }

            function getLanguageFromPath(path) {
                const ext = (path || '').split('.').pop().toLowerCase();
                const map = { html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less', js: 'javascript',
                    jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown',
                    xml: 'xml', svg: 'xml', py: 'python', rb: 'ruby', php: 'php', sql: 'sql', yaml: 'yaml',
                    yml: 'yaml', toml: 'toml' };
                return map[ext] || 'plaintext';
            }

            function refreshEditor() {
                if (!state.monacoEditor) return;
                const tab = state.openTabs.find(t => t.path === state.activeTabPath);
                if (!tab) {
                    state.monacoEditor.setModel(null);
                    document.getElementById('welcome-screen').classList.remove('hidden');
                    document.getElementById('status-language').textContent = '--';
                    return;
                }
                document.getElementById('welcome-screen').classList.add('hidden');
                const node = getNodeByPath(tab.path);
                if (!node || node.type !== 'file') return;
                if (node.blobData) {
                    state.monacoEditor.setModel(null);
                    document.getElementById('status-language').textContent = 'Binary';
                    return;
                }
                let model = state.monacoModelCache[tab.path];
                if (!model) {
                    model = monaco.editor.createModel(node.content || '', getLanguageFromPath(tab.path));
                    state.monacoModelCache[tab.path] = model;
                }
                if (state.monacoEditor.getModel() !== model) {
                    if (state.monacoEditor.getModel() && state.activeTabPath) {
                        const prevTab = state.openTabs.find(t => t.path === state.activeTabPath);
                        if (prevTab) {
                            prevTab.cursorState = state.monacoEditor.getPosition();
                            prevTab.scrollState = state.monacoEditor.getScrollTop();
                        }
                    }
                    state.monacoEditor.setModel(model);
                    if (tab.cursorState) state.monacoEditor.setPosition(tab.cursorState);
                    if (tab.scrollState) state.monacoEditor.setScrollTop(tab.scrollState);
                }
                document.getElementById('status-language').textContent = getLanguageFromPath(tab.path).toUpperCase();
                updateTabBar();
                updatePropertiesPanel();
            }

            function getAllMediaPaths(node = state.fileTree, base = '') {
                let paths = [];
                if (node.type === 'file' && node.blobUrl) {
                    paths.push((base + '/' + node.name).replace(/^\/+/, ''));
                } else if (node.children) {
                    for (const [key, child] of Object.entries(node.children)) {
                        paths = paths.concat(getAllMediaPaths(child, base + '/' + key));
                    }
                }
                return paths;
            }

            function collectMediaNodes(node, base, result) {
                if (node.type === 'file' && node.blobUrl) {
                    result.push({ path: (base + '/' + node.name).replace(/^\/+/, ''), name: node.name, blobUrl: node
                            .blobUrl, mediaType: node.mediaType });
                }
                if (node.children) {
                    for (const [key, child] of Object.entries(node.children)) {
                        collectMediaNodes(child, base + '/' + key, result);
                    }
                }
            }

            // ─── Tab Management ────────────────────────────────────────────────────
            function openFile(path) {
                const node = getNodeByPath(path);
                if (!node || node.type !== 'file') return;
                if (node.blobData) { previewMedia(path); return; }
                let tab = state.openTabs.find(t => t.path === path);
                if (!tab) {
                    tab = { path, dirty: false, cursorState: null, scrollState: null };
                    state.openTabs.push(tab);
                }
                state.activeTabPath = path;
                if (!state.recentFiles.includes(path)) {
                    state.recentFiles.unshift(path);
                    if (state.recentFiles.length > 30) state.recentFiles.length = 30;
                }
                refreshEditor();
                updateTabBar();
                updateRecentFilesList();
            }

            function closeTab(path) {
                const idx = state.openTabs.findIndex(t => t.path === path);
                if (idx < 0) return;
                const tab = state.openTabs[idx];
                if (tab.dirty) {
                    const node = getNodeByPath(tab.path);
                    if (node && node.type === 'file' && state.monacoEditor.getModel() &&
                        state.monacoEditor.getModel() === state.monacoModelCache[tab.path]) {
                        node.content = state.monacoEditor.getModel().getValue();
                        tab.dirty = false;
                    }
                }
                if (state.monacoModelCache[tab.path]) {
                    state.monacoModelCache[tab.path].dispose();
                    delete state.monacoModelCache[tab.path];
                }
                state.openTabs.splice(idx, 1);
                if (state.activeTabPath === path) {
                    state.activeTabPath = state.openTabs.length > 0 ? state.openTabs[Math.min(idx, state.openTabs.length -
                        1)].path : null;
                }
                refreshEditor();
                updateTabBar();
            }

            function closeAllTabs() {
                [...state.openTabs].forEach(t => closeTab(t.path));
            }

            function closeOtherTabs(path) {
                state.openTabs.filter(t => t.path !== path).forEach(t => closeTab(t.path));
            }

            function updateTabBar() {
                const tabBar = document.getElementById('tab-bar');
                tabBar.innerHTML = '';
                state.openTabs.forEach(tab => {
                    const el = document.createElement('div');
                    el.className = 'tab' + (tab.path === state.activeTabPath ? ' active' : '');
                    el.draggable = true;
                    el.innerHTML = `
                        <span class="tab-name">${getNodeName(tab.path)}</span>
                        ${tab.dirty ? '<span class="tab-dirty">●</span>' : ''}
                        <span class="tab-close material-icons" data-close="${tab.path}">close</span>
                    `;
                    el.addEventListener('click', (e) => {
                        if (e.target.dataset.close) { e.stopPropagation();
                            closeTab(tab.path); } else { state.activeTabPath = tab.path;
                            refreshEditor();
                            updateTabBar(); }
                    });
                    el.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        showTabContextMenu(e.clientX, e.clientY, tab.path);
                    });
                    el.addEventListener('dragstart', (e) => {
                        e.dataTransfer.setData('text/plain', tab.path);
                        el.style.opacity = '0.5';
                    });
                    el.addEventListener('dragend', () => { el.style.opacity = '1'; });
                    el.addEventListener('dragover', (e) => { e.preventDefault();
                        el.classList.add('drag-over'); });
                    el.addEventListener('dragleave', () => { el.classList.remove('drag-over'); });
                    el.addEventListener('drop', (e) => {
                        e.preventDefault();
                        el.classList.remove('drag-over');
                        const fromPath = e.dataTransfer.getData('text/plain');
                        const fromIdx = state.openTabs.findIndex(t => t.path === fromPath);
                        const toIdx = state.openTabs.findIndex(t => t.path === tab.path);
                        if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
                            const [moved] = state.openTabs.splice(fromIdx, 1);
                            state.openTabs.splice(toIdx, 0, moved);
                            updateTabBar();
                        }
                    });
                    tabBar.appendChild(el);
                });
            }

            function showTabContextMenu(x, y, path) {
                removeContextMenu();
                const menu = document.createElement('div');
                menu.className = 'context-menu';
                menu.style.left = x + 'px';
                menu.style.top = y + 'px';
                menu.innerHTML = `
                    <div class="menu-item" data-action="close">Close<span class="shortcut">Ctrl+W</span></div>
                    <div class="menu-item" data-action="closeOthers">Close Others</div>
                    <div class="menu-item" data-action="closeAll">Close All</div>
                    <div class="menu-separator"></div>
                    <div class="menu-item" data-action="download">Download File</div>
                `;
                menu.addEventListener('click', (e) => {
                    const action = e.target.closest('.menu-item')?.dataset.action;
                    if (action === 'close') closeTab(path);
                    if (action === 'closeOthers') closeOtherTabs(path);
                    if (action === 'closeAll') closeAllTabs();
                    if (action === 'download') downloadSingleFile(path);
                    removeContextMenu();
                });
                document.body.appendChild(menu);
                menu._contextMenu = true;
                setTimeout(() => document.addEventListener('click', removeContextMenu, { once: true }), 50);
            }

            function closeTabSilent(path) {
                const idx = state.openTabs.findIndex(t => t.path === path);
                if (idx >= 0) {
                    if (state.monacoModelCache[path]) { state.monacoModelCache[path].dispose();
                        delete state.monacoModelCache[path]; }
                    state.openTabs.splice(idx, 1);
                }
                if (state.activeTabPath === path) state.activeTabPath = null;
            }

            function downloadSingleFile(path) {
                const node = getNodeByPath(path);
                if (!node || node.type !== 'file') return;
                if (node.blobData) {
                    const a = document.createElement('a');
                    a.href = node.blobUrl;
                    a.download = node.name;
                    a.click();
                } else {
                    const blob = new Blob([node.content || ''], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = node.name;
                    a.click();
                    URL.revokeObjectURL(url);
                }
                showToast('File downloaded: ' + node.name, 'success');
            }

            // ─── File Tree Rendering ──────────────────────────────────────────────
            function renderFileTree(node = state.fileTree, container = document.getElementById('file-tree'), depth = 0,
                parentPath = '') {
                container.innerHTML = '';
                renderTreeNode(node, container, depth, parentPath);
            }

            function renderTreeNode(node, container, depth, parentPath) {
                if (!node || node.type !== 'folder' || !node.children) return;
                const sortedKeys = Object.keys(node.children).sort((a, b) => {
                    const na = node.children[a];
                    const nb = node.children[b];
                    if (na.type !== nb.type) return na.type === 'folder' ? -1 : 1;
                    return a.localeCompare(b);
                });
                sortedKeys.forEach(key => {
                    const child = node.children[key];
                    const childPath = (parentPath + '/' + key).replace(/^\/+/, '');
                    const itemEl = document.createElement('div');
                    itemEl.className = 'tree-item';
                    itemEl.dataset.path = childPath;
                    itemEl.dataset.type = child.type;
                    if (state.selectedFiles.includes(childPath)) {
                        itemEl.classList.add(state.selectedFiles.length > 1 ? 'multi-selected' : 'selected');
                    }
                    itemEl.style.paddingLeft = (depth * 16 + 8) + 'px';
                    itemEl.draggable = true;
                    const isExpanded = child._expanded !== false;
                    if (child.type === 'folder') {
                        const toggle = document.createElement('span');
                        toggle.className = 'tree-toggle material-icons' + (isExpanded ? ' expanded' : '');
                        toggle.textContent = 'chevron_right';
                        toggle.addEventListener('click', (e) => {
                            e.stopPropagation();
                            child._expanded = !(child._expanded !== false);
                            renderFileTree();
                        });
                        itemEl.appendChild(toggle);
                        itemEl.innerHTML +=
                            `<span class="tree-icon material-icons">${isExpanded ? 'folder_open' : 'folder'}</span>`;
                    } else {
                        itemEl.innerHTML += '<span style="width:16px;flex-shrink:0;"></span>';
                        const ext = key.split('.').pop().toLowerCase();
                        const iconMap = { html: 'code', css: 'style', js: 'javascript', json: 'data_object',
                            md: 'article', svg: 'image', png: 'image', jpg: 'image', jpeg: 'image',
                            gif: 'gif', webp: 'image', mp4: 'movie', webm: 'movie', mp3: 'audiotrack',
                            wav: 'music_note' };
                        const icon = child.blobUrl ? (child.mediaType?.startsWith('video') ? 'movie' : child
                            .mediaType?.startsWith('audio') ? 'audiotrack' : 'image') : (iconMap[ext] ||
                            'description');
                        itemEl.innerHTML += `<span class="tree-icon material-icons">${icon}</span>`;
                    }
                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'tree-name';
                    nameSpan.textContent = key;
                    itemEl.appendChild(nameSpan);

                    itemEl.addEventListener('click', (e) => {
                        if (e.ctrlKey || e.metaKey) {
                            e.preventDefault();
                            toggleFileSelection(childPath);
                        } else if (e.shiftKey && state.selectedFiles.length > 0) {
                            e.preventDefault();
                            rangeSelectFiles(childPath);
                        } else {
                            state.selectedFiles = [childPath];
                            if (child.type === 'folder') {
                                child._expanded = !(child._expanded !== false);
                                renderFileTree();
                            } else {
                                openFile(childPath);
                            }
                            updateFileTreeSelection();
                        }
                    });

                    itemEl.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!state.selectedFiles.includes(childPath)) {
                            state.selectedFiles = [childPath];
                            updateFileTreeSelection();
                        }
                        showFileContextMenu(e.clientX, e.clientY, childPath, child);
                    });

                    itemEl.addEventListener('dragstart', (e) => {
                        if (!state.selectedFiles.includes(childPath)) {
                            state.selectedFiles = [childPath];
                            updateFileTreeSelection();
                        }
                        e.dataTransfer.setData('text/plain', JSON.stringify(state.selectedFiles));
                        e.dataTransfer.effectAllowed = 'move';
                    });

                    itemEl.addEventListener('dragover', (e) => {
                        e.preventDefault();
                        if (child.type === 'folder') itemEl.classList.add('drag-over');
                        e.dataTransfer.dropEffect = 'move';
                    });
                    itemEl.addEventListener('dragleave', () => { itemEl.classList.remove('drag-over'); });
                    itemEl.addEventListener('drop', (e) => {
                        e.preventDefault();
                        itemEl.classList.remove('drag-over');
                        const data = e.dataTransfer.getData('text/plain');
                        let paths;
                        try { paths = JSON.parse(data); } catch (err) { paths = [data]; }
                        if (child.type === 'folder' && paths.length > 0 && !paths.includes(childPath)) {
                            moveFilesToFolder(paths, childPath);
                        }
                    });

                    container.appendChild(itemEl);
                    if (child.type === 'folder' && isExpanded && child.children) {
                        const childrenContainer = document.createElement('div');
                        childrenContainer.className = 'tree-children';
                        renderTreeNode(child, childrenContainer, depth + 1, childPath);
                        container.appendChild(childrenContainer);
                    }
                });
            }

            function updateFileTreeSelection() {
                document.querySelectorAll('#file-tree .tree-item').forEach(el => {
                    el.classList.remove('selected', 'multi-selected');
                    if (state.selectedFiles.includes(el.dataset.path)) {
                        el.classList.add(state.selectedFiles.length > 1 ? 'multi-selected' : 'selected');
                    }
                });
                updatePropertiesPanel();
                updateClipboardIndicator();
            }

            function toggleFileSelection(path) {
                const idx = state.selectedFiles.indexOf(path);
                if (idx >= 0) state.selectedFiles.splice(idx, 1);
                else state.selectedFiles.push(path);
                updateFileTreeSelection();
            }

            function rangeSelectFiles(targetPath) {
                const allPaths = getAllFilePaths(state.fileTree);
                const lastSelected = state.selectedFiles[state.selectedFiles.length - 1];
                const idx1 = allPaths.indexOf(lastSelected);
                const idx2 = allPaths.indexOf(targetPath);
                if (idx1 >= 0 && idx2 >= 0) {
                    const start = Math.min(idx1, idx2);
                    const end = Math.max(idx1, idx2);
                    state.selectedFiles = allPaths.slice(start, end + 1);
                }
                updateFileTreeSelection();
            }

            function showFileContextMenu(x, y, path, node) {
                removeContextMenu();
                const menu = document.createElement('div');
                menu.className = 'context-menu';
                menu.style.left = x + 'px';
                menu.style.top = y + 'px';
                const isFolder = node.type === 'folder';
                const isMedia = node.blobUrl ? true : false;
                let html = '';
                if (isFolder) {
                    html += `
                        <div class="menu-item" data-action="newFile">📄 New File</div>
                        <div class="menu-item" data-action="newFolder">📁 New Folder</div>
                        <div class="menu-separator"></div>`;
                }
                html += `
                    <div class="menu-item" data-action="rename">✏️ Rename</div>
                    <div class="menu-item" data-action="copy">📋 Copy</div>
                    <div class="menu-item" data-action="cut">✂️ Cut</div>
                    <div class="menu-item" data-action="duplicate">📄 Duplicate</div>
                    <div class="menu-separator"></div>
                    <div class="menu-item" data-action="download">⬇️ Download</div>
                    ${isMedia ? `<div class="menu-item" data-action="preview">👁️ Preview</div><div class="menu-item" data-action="insert">📌 Insert into Code</div><div class="menu-item" data-action="copyPath">📎 Copy Path</div>` : ''}
                    <div class="menu-separator"></div>
                    <div class="menu-item" data-action="delete" style="color:var(--danger);">🗑️ Delete</div>
                `;
                menu.innerHTML = html;
                menu.addEventListener('click', (e) => {
                    const action = e.target.closest('.menu-item')?.dataset.action;
                    handleContextAction(action, path, node);
                    removeContextMenu();
                });
                document.body.appendChild(menu);
                menu._contextMenu = true;
                setTimeout(() => document.addEventListener('click', removeContextMenu, { once: true }), 50);
            }

            function handleContextAction(action, path, node) {
                switch (action) {
                    case 'newFile':
                        state.selectedFiles = [path];
                        createFile(path);
                        break;
                    case 'newFolder':
                        state.selectedFiles = [path];
                        createFolder(path);
                        break;
                    case 'rename':
                        renameFile(path);
                        break;
                    case 'copy':
                        copyFiles();
                        break;
                    case 'cut':
                        cutFiles();
                        break;
                    case 'duplicate':
                        duplicateFile();
                        break;
                    case 'download':
                        downloadSingleFile(path);
                        break;
                    case 'preview':
                        previewMedia(path);
                        break;
                    case 'insert':
                        insertMediaAtCursor(path);
                        break;
                    case 'copyPath':
                        navigator.clipboard.writeText(path).then(() => showToast('Path copied!', 'info'));
                        break;
                    case 'delete':
                        deleteFile(path);
                        break;
                }
            }

            function removeContextMenu() {
                document.querySelectorAll('.context-menu').forEach(m => m.remove());
            }

            // ─── File Operations ──────────────────────────────────────────────────
            function createFile(parentFolderPath) {
                const targetPath = parentFolderPath || (state.selectedFiles.length === 1 && getNodeByPath(state
                    .selectedFiles[0])?.type === 'folder' ? state.selectedFiles[0] : '/');
                showModal('Create New File', `
                    <input type="text" id="modal-filename" placeholder="filename.html" value="">
                    <select id="modal-folder">${generateFolderOptions(targetPath)}</select>
                    <div class="btn-row">
                        <button class="btn-secondary" onclick="AyeshaApp.closeModal()">Cancel</button>
                        <button class="btn-primary" onclick="AyeshaApp.confirmCreateFile()">Create</button>
                    </div>
                `);
                document.getElementById('modal-folder').value = targetPath;
                document.getElementById('modal-filename').focus();
            }

            function generateFolderOptions(selectedPath) {
                const paths = getAllFolderPaths();
                return paths.map(p => `<option value="${p}" ${p === selectedPath ? 'selected' : ''}>${p}</option>`).join('');
            }

            function confirmCreateFile() {
                const name = document.getElementById('modal-filename').value.trim();
                const folder = document.getElementById('modal-folder').value;
                if (!name) { showToast('Please enter a filename', 'warning'); return; }
                const folderNode = getNodeByPath(folder);
                if (!folderNode || folderNode.type !== 'folder') { showToast('Invalid folder', 'error'); return; }
                if (!folderNode.children) folderNode.children = {};
                if (folderNode.children[name]) { showToast('File already exists', 'warning'); return; }
                folderNode.children[name] = { name, type: 'file', content: '', children: {}, blobUrl: null, blobData: null,
                    mediaType: '' };
                const newPath = (folder + '/' + name).replace(/^\/+/, '');
                saveProject();
                renderFileTree();
                openFile(newPath);
                closeModal();
                showToast('File created: ' + name, 'success');
            }

            function createFolder(parentFolderPath) {
                const targetPath = parentFolderPath || (state.selectedFiles.length === 1 && getNodeByPath(state
                    .selectedFiles[0])?.type === 'folder' ? state.selectedFiles[0] : '/');
                showModal('Create New Folder', `
                    <input type="text" id="modal-foldername" placeholder="folder-name" value="">
                    <select id="modal-folder">${generateFolderOptions(targetPath)}</select>
                    <div class="btn-row">
                        <button class="btn-secondary" onclick="AyeshaApp.closeModal()">Cancel</button>
                        <button class="btn-primary" onclick="AyeshaApp.confirmCreateFolder()">Create</button>
                    </div>
                `);
                document.getElementById('modal-folder').value = targetPath;
                document.getElementById('modal-foldername').focus();
            }

            function confirmCreateFolder() {
                const name = document.getElementById('modal-foldername').value.trim();
                const folder = document.getElementById('modal-folder').value;
                if (!name) { showToast('Please enter a folder name', 'warning'); return; }
                const folderNode = getNodeByPath(folder);
                if (!folderNode || folderNode.type !== 'folder') { showToast('Invalid parent folder', 'error'); return; }
                if (!folderNode.children) folderNode.children = {};
                if (folderNode.children[name]) { showToast('Already exists', 'warning'); return; }
                folderNode.children[name] = { name, type: 'folder', children: {}, blobUrl: null, blobData: null,
                    mediaType: '' };
                saveProject();
                renderFileTree();
                closeModal();
                showToast('Folder created: ' + name, 'success');
            }

            function renameFile(path) {
                const node = getNodeByPath(path);
                if (!node) return;
                showModal('Rename', `
                    <input type="text" id="modal-rename" value="${node.name}" placeholder="New name">
                    <div class="btn-row">
                        <button class="btn-secondary" onclick="AyeshaApp.closeModal()">Cancel</button>
                        <button class="btn-primary" onclick="AyeshaApp.confirmRename('${path}')">Rename</button>
                    </div>
                `);
                document.getElementById('modal-rename').focus();
                document.getElementById('modal-rename').select();
            }

            function confirmRename(oldPath) {
                const newName = document.getElementById('modal-rename').value.trim();
                if (!newName) { showToast('Please enter a name', 'warning'); return; }
                const parentPath = getParentPath(oldPath);
                const parent = getNodeByPath(parentPath);
                const oldName = getNodeName(oldPath);
                if (!parent || !parent.children || !parent.children[oldName]) { showToast('File not found', 'error'); return; }
                if (parent.children[newName] && newName !== oldName) { showToast('Name already exists', 'warning'); return; }
                const node = parent.children[oldName];
                node.name = newName;
                parent.children[newName] = node;
                delete parent.children[oldName];
                const newPath = (parentPath + '/' + newName).replace(/^\/+/, '');
                state.openTabs.forEach(t => { if (t.path === oldPath) t.path = newPath; });
                if (state.activeTabPath === oldPath) state.activeTabPath = newPath;
                if (state.monacoModelCache[oldPath]) {
                    state.monacoModelCache[newPath] = state.monacoModelCache[oldPath];
                    delete state.monacoModelCache[oldPath];
                }
                state.selectedFiles = state.selectedFiles.map(p => p === oldPath ? newPath : p);
                state.recentFiles = state.recentFiles.map(p => p === oldPath ? newPath : p);
                saveProject();
                renderFileTree();
                updateTabBar();
                closeModal();
                showToast('Renamed to: ' + newName, 'success');
            }

            function deleteFile(path) {
                const node = getNodeByPath(path);
                if (!node) return;
                showModal('Delete', `
                    <p>Are you sure you want to delete <strong>${node.name}</strong>?</p>
                    ${node.type === 'folder' ? '<p style="color:var(--warning);font-size:12px;">This will delete all contents inside this folder.</p>' : ''}
                    <div class="btn-row">
                        <button class="btn-secondary" onclick="AyeshaApp.closeModal()">Cancel</button>
                        <button class="btn-danger" onclick="AyeshaApp.confirmDelete('${path}')">Delete</button>
                    </div>
                `);
            }

            function confirmDelete(path) {
                const parentPath = getParentPath(path);
                const parent = getNodeByPath(parentPath);
                const name = getNodeName(path);
                if (!parent || !parent.children || !parent.children[name]) { showToast('File not found', 'error'); return; }
                const node = parent.children[name];
                state.undoStack.push({ action: 'delete', path, node: JSON.parse(JSON.stringify(serializeFileTree(node))),
                    parentPath });
                state.redoStack = [];
                cleanupNodeBlobs(node);
                const pathsToClose = getAllFilePaths(node, path);
                pathsToClose.forEach(p => {
                    const idx = state.openTabs.findIndex(t => t.path === p);
                    if (idx >= 0) {
                        if (state.monacoModelCache[p]) { state.monacoModelCache[p].dispose();
                            delete state.monacoModelCache[p]; }
                        state.openTabs.splice(idx, 1);
                    }
                });
                delete parent.children[name];
                state.selectedFiles = state.selectedFiles.filter(p => !p.startsWith(path));
                if (state.activeTabPath && pathsToClose.includes(state.activeTabPath)) state.activeTabPath = null;
                saveProject();
                renderFileTree();
                updateTabBar();
                refreshEditor();
                closeModal();
                showToast('Deleted: ' + name, 'success');
            }

            function cleanupNodeBlobs(node) {
                if (node.blobUrl) URL.revokeObjectURL(node.blobUrl);
                if (node.children) Object.values(node.children).forEach(cleanupNodeBlobs);
            }

            // ─── Clipboard Operations ─────────────────────────────────────────────
            function cutFiles() {
                if (state.selectedFiles.length === 0) { showToast('No files selected', 'warning'); return; }
                state.clipboard = { action: 'cut', paths: [...state.selectedFiles] };
                updateClipboardIndicator();
                showToast('Cut ' + state.selectedFiles.length + ' file(s)', 'info');
            }

            function copyFiles() {
                if (state.selectedFiles.length === 0) { showToast('No files selected', 'warning'); return; }
                state.clipboard = { action: 'copy', paths: [...state.selectedFiles] };
                updateClipboardIndicator();
                showToast('Copied ' + state.selectedFiles.length + ' file(s)', 'info');
            }

            async function pasteFiles() {
                if (!state.clipboard || state.clipboard.paths.length === 0) { showToast('Clipboard empty', 'warning'); return; }
                const targetFolder = state.selectedFiles.length === 1 && getNodeByPath(state.selectedFiles[0])?.type ===
                    'folder' ? state.selectedFiles[0] : '/';
                const targetNode = getNodeByPath(targetFolder);
                if (!targetNode || targetNode.type !== 'folder') { showToast('Invalid target', 'error'); return; }
                if (!targetNode.children) targetNode.children = {};
                let pastedCount = 0;
                for (const srcPath of state.clipboard.paths) {
                    const srcNode = getNodeByPath(srcPath);
                    if (!srcNode) continue;
                    const srcName = srcNode.name;
                    let destName = srcName;
                    let counter = 1;
                    while (targetNode.children[destName]) {
                        const parts = srcName.split('.');
                        destName = parts.length > 1 ? parts.slice(0, -1).join('.') + '_' + counter + '.' + parts[parts
                            .length - 1] : srcName + '_' + counter;
                        counter++;
                    }
                    const cloned = await deepCloneNode(srcNode);
                    cloned.name = destName;
                    targetNode.children[destName] = cloned;
                    pastedCount++;
                }
                if (state.clipboard.action === 'cut') {
                    for (const srcPath of state.clipboard.paths) {
                        const srcParent = getNodeByPath(getParentPath(srcPath));
                        const srcName = getNodeName(srcPath);
                        if (srcParent && srcParent.children) delete srcParent.children[srcName];
                        closeTabSilent(srcPath);
                    }
                    state.clipboard = null;
                }
                updateClipboardIndicator();
                saveProject();
                renderFileTree();
                updateTabBar();
                refreshEditor();
                showToast('Pasted ' + pastedCount + ' file(s)', 'success');
            }

            async function deepCloneNode(node) {
                const clone = { name: node.name, type: node.type, content: node.content || '', children: {}, blobUrl: null,
                    blobData: null, mediaType: node.mediaType || '' };
                if (node.blobData) {
                    clone.blobData = node.blobData.slice ? node.blobData.slice(0, node.blobData.size, node.blobData
                        .type) : node.blobData;
                    clone.blobUrl = URL.createObjectURL(clone.blobData);
                }
                if (node.children) {
                    for (const [key, child] of Object.entries(node.children)) {
                        clone.children[key] = await deepCloneNode(child);
                    }
                }
                return clone;
            }

            function duplicateFile() {
                if (state.selectedFiles.length !== 1) { showToast('Select one file to duplicate', 'warning'); return; }
                const path = state.selectedFiles[0];
                const node = getNodeByPath(path);
                if (!node) return;
                const parentPath = getParentPath(path);
                const parent = getNodeByPath(parentPath);
                if (!parent || !parent.children) return;
                let destName = node.name;
                const parts = node.name.split('.');
                let counter = 1;
                while (parent.children[destName]) {
                    destName = parts.length > 1 ? parts.slice(0, -1).join('.') + '_copy' + counter + '.' + parts[parts
                        .length - 1] : node.name + '_copy' + counter;
                    counter++;
                }
                deepCloneNode(node).then(cloned => {
                    cloned.name = destName;
                    parent.children[destName] = cloned;
                    saveProject();
                    renderFileTree();
                    showToast('Duplicated: ' + destName, 'success');
                });
            }

            function moveFile() {
                if (state.selectedFiles.length === 0) { showToast('Select files to move', 'warning'); return; }
                showModal('Move Files', `
                    <p>Move ${state.selectedFiles.length} file(s) to:</p>
                    <select id="modal-move-target">${generateFolderOptions('/')}</select>
                    <div class="btn-row">
                        <button class="btn-secondary" onclick="AyeshaApp.closeModal()">Cancel</button>
                        <button class="btn-primary" onclick="AyeshaApp.confirmMove()">Move</button>
                    </div>
                `);
            }

            function confirmMove() {
                const targetFolder = document.getElementById('modal-move-target').value;
                moveFilesToFolder(state.selectedFiles, targetFolder);
                closeModal();
            }

            function moveFilesToFolder(paths, targetFolder) {
                const targetNode = getNodeByPath(targetFolder);
                if (!targetNode || targetNode.type !== 'folder') { showToast('Invalid target', 'error'); return; }
                if (!targetNode.children) targetNode.children = {};
                let movedCount = 0;
                for (const srcPath of paths) {
                    if (srcPath === targetFolder) continue;
                    const srcParent = getNodeByPath(getParentPath(srcPath));
                    const srcName = getNodeName(srcPath);
                    if (!srcParent || !srcParent.children || !srcParent.children[srcName]) continue;
                    if (targetNode.children[srcName]) { showToast('Name conflict: ' + srcName, 'warning'); continue; }
                    targetNode.children[srcName] = srcParent.children[srcName];
                    delete srcParent.children[srcName];
                    const newPath = (targetFolder + '/' + srcName).replace(/^\/+/, '');
                    state.openTabs.forEach(t => { if (t.path === srcPath) t.path = newPath; });
                    if (state.activeTabPath === srcPath) state.activeTabPath = newPath;
                    if (state.monacoModelCache[srcPath]) { state.monacoModelCache[newPath] = state.monacoModelCache[
                        srcPath];
                        delete state.monacoModelCache[srcPath]; }
                    state.selectedFiles = state.selectedFiles.map(p => p === srcPath ? newPath : p);
                    state.recentFiles = state.recentFiles.map(p => p === srcPath ? newPath : p);
                    movedCount++;
                }
                saveProject();
                renderFileTree();
                updateTabBar();
                refreshEditor();
                showToast('Moved ' + movedCount + ' file(s)', 'success');
            }

            function updateClipboardIndicator() {
                const indicator = document.getElementById('clipboard-indicator');
                const textEl = document.getElementById('clipboard-text');
                if (state.clipboard && state.clipboard.paths.length > 0) {
                    indicator.style.display = 'flex';
                    textEl.textContent = state.clipboard.action === 'cut' ? 'Cut: ' + state.clipboard.paths.length +
                        ' file(s)' : 'Copied: ' + state.clipboard.paths.length + ' file(s)';
                } else {
                    indicator.style.display = 'none';
                }
                if (state.clipboardIndicatorTimeout) clearTimeout(state.clipboardIndicatorTimeout);
                if (state.clipboard) {
                    state.clipboardIndicatorTimeout = setTimeout(() => {
                        document.getElementById('clipboard-indicator').style.display = 'none';
                    }, 5000);
                }
            }

            // ─── Media Upload ─────────────────────────────────────────────────────
            function uploadMedia() { document.getElementById('media-file-input').click(); }

            async function handleMediaUpload(event) {
                const files = event.target.files;
                if (!files || files.length === 0) return;
                const targetFolder = state.selectedFiles.length === 1 && getNodeByPath(state.selectedFiles[0])?.type ===
                    'folder' ? state.selectedFiles[0] : '/media';
                const cleanFolder = normalizePath(targetFolder);
                ensureFolderPath(cleanFolder);
                const folderNode = getNodeByPath(cleanFolder);
                if (!folderNode || !folderNode.children) folderNode.children = {};
                let uploaded = 0;
                for (const file of files) {
                    let name = file.name;
                    let counter = 1;
                    while (folderNode.children[name]) {
                        const parts = name.split('.');
                        name = parts.length > 1 ? parts.slice(0, -1).join('.') + '_' + counter + '.' + parts[parts.length -
                            1] : name + '_' + counter;
                        counter++;
                    }
                    const blob = new Blob([file], { type: file.type });
                    const blobUrl = URL.createObjectURL(blob);
                    const path = (cleanFolder + '/' + name).replace(/^\/+/, '');
                    folderNode.children[name] = { name, type: 'file', content: '', children: {}, blobUrl, blobData: blob,
                        mediaType: file.type };
                    await saveMediaToDB(path, blob);
                    uploaded++;
                }
                saveProject();
                renderFileTree();
                renderImageGrid();
                showToast('Uploaded ' + uploaded + ' media file(s)', 'success');
                event.target.value = '';
            }

            // ─── Media Preview ────────────────────────────────────────────────────
            function previewMedia(path) {
                const node = getNodeByPath(path);
                if (!node || !node.blobUrl) return;
                const isVideo = node.mediaType?.startsWith('video');
                const isAudio = node.mediaType?.startsWith('audio');
                let mediaHTML = '';
                if (isVideo) {
                    mediaHTML =
                        `<video controls autoplay style="max-width:100%;max-height:70vh;border-radius:8px;"><source src="${node.blobUrl}" type="${node.mediaType}"></video>`;
                } else if (isAudio) {
                    mediaHTML =
                        `<audio controls autoplay style="width:100%;"><source src="${node.blobUrl}" type="${node.mediaType}"></audio>`;
                } else {
                    mediaHTML =
                        `<img src="${node.blobUrl}" alt="${node.name}" style="max-width:100%;max-height:70vh;border-radius:8px;object-fit:contain;">`;
                }
                showModal('Media Preview: ' + node.name, `
                    <div style="text-align:center;">${mediaHTML}</div>
                    <div class="btn-row">
                        <button class="btn-secondary" onclick="AyeshaApp.copyMediaPath('${path}')">📎 Copy Path</button>
                        <button class="btn-primary" onclick="AyeshaApp.insertMediaAtCursor('${path}');AyeshaApp.closeModal();">📌 Insert</button>
                        <button class="btn-secondary" onclick="AyeshaApp.closeModal()">Close</button>
                    </div>
                `, true);
            }

            function insertMediaAtCursor(path) {
                if (!state.monacoEditor || !state.activeTabPath) { showToast('Open a file first', 'warning'); return; }
                const node = getNodeByPath(path);
                if (!node || !node.blobUrl) return;
                const lang = getLanguageFromPath(state.activeTabPath);
                const relPath = './' + path;
                let insertText = '';
                if (lang === 'html') {
                    if (node.mediaType?.startsWith('video')) insertText = `<video src="${relPath}" controls></video>`;
                    else if (node.mediaType?.startsWith('audio')) insertText = `<audio src="${relPath}" controls></audio>`;
                    else insertText = `<img src="${relPath}" alt="${node.name}">`;
                } else if (lang === 'css') {
                    insertText = `url('${relPath}')`;
                } else {
                    insertText = `'${relPath}'`;
                }
                const selection = state.monacoEditor.getSelection();
                state.monacoEditor.executeEdits('insert-media', [{ range: selection, text: insertText }]);
                showToast('Media inserted!', 'success');
            }

            function copyMediaPath(path) {
                navigator.clipboard.writeText(path).then(() => showToast('Path copied!', 'info'));
            }

            // ─── Image Grid ───────────────────────────────────────────────────────
            function renderImageGrid() {
                const grid = document.getElementById('image-grid');
                if (!grid) return;
                const allMedia = [];
                collectMediaNodes(state.fileTree, '', allMedia);
                if (allMedia.length === 0) {
                    grid.innerHTML =
                        '<div style="padding:20px;text-align:center;color:var(--text-muted);">No media files uploaded</div>';
                    return;
                }
                grid.innerHTML = allMedia.map(m => `
                    <div class="img-card" onclick="AyeshaApp.previewMedia('${m.path}')" title="${m.name}">
                        ${m.mediaType?.startsWith('video') ? `<video src="${m.blobUrl}" muted></video><span class="img-type">VID</span>` :
                        m.mediaType?.startsWith('audio') ? `<span style="font-size:32px;">🎵</span><span class="img-type">AUD</span>` :
                        `<img src="${m.blobUrl}" alt="${m.name}" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2280%22%3E%3Crect fill=%22%23333%22 width=%2280%22 height=%2280%22/%3E%3Ctext x=%2250%25%22 y=%2250%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2212%22 dy=%22.3em%22%3E${m.name.split('.').pop()}%3C/text%3E%3C/svg%3E'"><span class="img-type">IMG</span>`}
                    </div>
                `).join('');
            }

            // ─── Preview ──────────────────────────────────────────────────────────
            function runPreview() {
                let htmlPath = state.activeTabPath;
                if (!htmlPath || !(htmlPath.endsWith('.html') || htmlPath.endsWith('.htm'))) {
                    const allPaths = getAllFilePaths();
                    htmlPath = allPaths.find(p => p.endsWith('.html') || p.endsWith('.htm'));
                }
                if (!htmlPath) {
                    showToast('No HTML file found to preview', 'warning');
                    return;
                }
                const htmlNode = getNodeByPath(htmlPath);
                if (!htmlNode || htmlNode.type !== 'file') return;
                saveCurrentFile();
                let htmlContent = htmlNode.content || '';

                // ── Collect all media ──
                const allMedia = [];
                collectMediaNodes(state.fileTree, '', allMedia);

                // ── Build a map of path variants to blob URL ──
                const replaceMap = {};
                allMedia.forEach(m => {
                    const variants = [
                        m.path,
                        './' + m.path,
                        '/' + m.path,
                        '../' + m.path,
                        m.path.replace(/^\/+/, ''),
                        m.name,
                        './' + m.name,
                        '/' + m.name,
                    ];
                    // Also add variants with encoded versions
                    const enc = encodeURI(m.path);
                    variants.push(enc, './' + enc, '/' + enc);
                    // Also add with backslashes (Windows style)
                    variants.push(m.path.replace(/\//g, '\\'));
                    variants.push('./' + m.path.replace(/\//g, '\\'));
                    variants.push('/' + m.path.replace(/\//g, '\\'));

                    variants.forEach(v => {
                        // Use the actual path (including slashes) as key
                        replaceMap[v] = m.blobUrl;
                    });
                });

                // ── Replace in HTML using regex ──
                // First, match all src="..." and src='...' and url(...) and href="..."
                // We'll do a more robust approach: find all quoted strings and url() calls
                const quotedRegex = /(src|href|poster|data|background|srcset)\s*=\s*["']([^"']+)["']/gi;
                const urlRegex = /url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi;

                // Replace in src/href attributes
                htmlContent = htmlContent.replace(quotedRegex, (match, attr, value) => {
                    const trimmed = value.trim();
                    // Check if this value is a media path
                    for (const [key, blobUrl] of Object.entries(replaceMap)) {
                        if (trimmed === key || trimmed.endsWith('/' + key) || trimmed === './' + key || trimmed ===
                            '/' + key) {
                            return `${attr}="${blobUrl}"`;
                        }
                        // Also check if the filename matches
                        const fileName = key.split('/').pop();
                        if (trimmed === fileName || trimmed === './' + fileName || trimmed === '/' + fileName) {
                            return `${attr}="${blobUrl}"`;
                        }
                    }
                    return match;
                });

                // Replace in url() calls
                htmlContent = htmlContent.replace(urlRegex, (match, value) => {
                    const trimmed = value.trim();
                    for (const [key, blobUrl] of Object.entries(replaceMap)) {
                        if (trimmed === key || trimmed.endsWith('/' + key) || trimmed === './' + key || trimmed ===
                            '/' + key) {
                            return `url("${blobUrl}")`;
                        }
                        const fileName = key.split('/').pop();
                        if (trimmed === fileName || trimmed === './' + fileName || trimmed === '/' + fileName) {
                            return `url("${blobUrl}")`;
                        }
                    }
                    return match;
                });

                // ── Also handle srcset (simple case) ──
                const srcsetRegex = /srcset\s*=\s*["']([^"']+)["']/gi;
                htmlContent = htmlContent.replace(srcsetRegex, (match, value) => {
                    const parts = value.split(',').map(p => p.trim());
                    const replaced = parts.map(p => {
                        const [url, size] = p.split(/\s+/);
                        for (const [key, blobUrl] of Object.entries(replaceMap)) {
                            if (url === key || url === './' + key || url === '/' + key || url === key.split('/')
                                .pop()) {
                                return blobUrl + (size ? ' ' + size : '');
                            }
                        }
                        return p;
                    });
                    return `srcset="${replaced.join(', ')}"`;
                });

                // ── Linked CSS/JS inlining ──
                const linkedFiles = findLinkedFiles(htmlContent, htmlPath);
                linkedFiles.forEach(lf => {
                    const node = getNodeByPath(lf.path);
                    if (node && node.type === 'file' && !node.blobData) {
                        htmlContent = htmlContent.replace(lf.original, lf.replaceWith(node.content));
                    }
                });

                // ── Console capture script ──
                const captureScript = `<script>(function(){var origLog=console.log,origErr=console.error,origWarn=console.warn;function send(type,args){try{var msg=Array.from(args).map(function(a){try{return typeof a==='object'?JSON.stringify(a):String(a);}catch(e){return String(a);}}).join(' ');window.parent.postMessage({type:'console',level:type,message:msg},'*');}catch(e){}}console.log=function(){send('log',arguments);origLog.apply(console,arguments);};console.error=function(){send('error',arguments);origErr.apply(console,arguments);};console.warn=function(){send('warn',arguments);origWarn.apply(console,arguments);};window.onerror=function(msg,src,line,col,err){window.parent.postMessage({type:'console',level:'error',message:msg+' at line '+line},'*');};})();<\/script>`;
                htmlContent = htmlContent.replace('</body>', captureScript + '</body>');
                if (!htmlContent.includes('</body>')) htmlContent += captureScript;

                // ── Show preview ──
                const previewContainer = document.getElementById('preview-container');
                previewContainer.classList.add('active');
                state.isPreviewOpen = true;
                const blob = new Blob([htmlContent], { type: 'text/html' });
                const url = URL.createObjectURL(blob);
                const iframe = document.getElementById('preview-iframe');
                iframe.src = url;
                iframe.onload = () => setTimeout(() => URL.revokeObjectURL(url), 5000);
                showToast('Preview running...', 'info');
            }

            function findLinkedFiles(htmlContent, basePath) {
                const links = [];
                const baseDir = getParentPath(basePath);
                const cssRegex = /<link[^>]*href=["']([^"']+\.css)["'][^>]*>/gi;
                let match;
                while ((match = cssRegex.exec(htmlContent)) !== null) {
                    const href = match[1];
                    const resolved = resolveRelativePath(href, baseDir);
                    links.push({ original: match[0], path: resolved, replaceWith: (c) => '<style>' + c + '</style>' });
                }
                const jsRegex = /<script[^>]*src=["']([^"']+\.js)["'][^>]*><\/script>/gi;
                while ((match = jsRegex.exec(htmlContent)) !== null) {
                    const src = match[1];
                    const resolved = resolveRelativePath(src, baseDir);
                    links.push({ original: match[0], path: resolved, replaceWith: (c) => '' });
                }
                return links;
            }

            function resolveRelativePath(relativePath, baseDir) {
                if (relativePath.startsWith('./')) return (baseDir + relativePath.substring(1)).replace(/^\/+/, '');
                if (relativePath.startsWith('../')) {
                    const parts = baseDir.split('/').filter(Boolean);
                    let rel = relativePath;
                    while (rel.startsWith('../')) { parts.pop();
                        rel = rel.substring(3); }
                    return (parts.join('/') + '/' + rel).replace(/^\/+/, '');
                }
                if (relativePath.startsWith('/')) return normalizePath(relativePath);
                return (baseDir + '/' + relativePath).replace(/^\/+/, '');
            }

            function closePreview() {
                document.getElementById('preview-container').classList.remove('active');
                state.isPreviewOpen = false;
                document.getElementById('preview-iframe').src = 'about:blank';
            }

            // ─── Console ──────────────────────────────────────────────────────────
            function clearConsole() { document.getElementById('console-output').innerHTML = ''; }

            function appendConsole(level, message) {
                const output = document.getElementById('console-output');
                const line = document.createElement('div');
                line.className = 'log-line log-' + level;
                line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
                output.appendChild(line);
                output.scrollTop = output.scrollHeight;
            }

            window.addEventListener('message', (e) => {
                if (e.data && e.data.type === 'console') appendConsole(e.data.level, e.data.message);
            });

            // ─── Modals ────────────────────────────────────────────────────────────
            function showModal(title, content, wide = false) {
                closeModal();
                const overlay = document.createElement('div');
                overlay.className = 'modal-overlay';
                overlay.id = 'modal-overlay';
                overlay.innerHTML =
                    `<div class="modal" style="${wide ? 'min-width:500px;' : ''}"><h3>${title}</h3><div id="modal-content">${content}</div></div>`;
                overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
                document.body.appendChild(overlay);
            }

            function closeModal() { const overlay = document.getElementById('modal-overlay'); if (overlay) overlay.remove(); }

            // ─── Toast ─────────────────────────────────────────────────────────────
            function showToast(message, type = 'info') {
                const container = document.getElementById('toast-container');
                const toast = document.createElement('div');
                toast.className = 'toast ' + type;
                const icons = { success: 'check_circle', error: 'error', warning: 'warning', info: 'info' };
                toast.innerHTML =
                    `<span class="material-icons" style="font-size:18px;">${icons[type] || 'info'}</span> ${message}`;
                container.appendChild(toast);
                setTimeout(() => { if (toast.parentNode) toast.remove(); }, 3000);
            }

            // ─── Project Management ──────────────────────────────────────────────
            function newProject() {
                if (state.openTabs.some(t => t.dirty)) {
                    showModal('New Project', `
                        <p>You have unsaved changes. Create a new project anyway?</p>
                        <div class="btn-row">
                            <button class="btn-secondary" onclick="AyeshaApp.closeModal()">Cancel</button>
                            <button class="btn-primary" onclick="AyeshaApp.confirmNewProject()">New Project</button>
                        </div>
                    `);
                } else confirmNewProject();
            }

            function confirmNewProject() {
                closeAllTabs();
                initDefaultProject();
                state.projectName = 'Untitled Project';
                state.openTabs = [];
                state.activeTabPath = null;
                state.selectedFiles = [];
                state.clipboard = null;
                state.undoStack = [];
                state.redoStack = [];
                state.recentFiles = [];
                Object.values(state.monacoModelCache).forEach(m => m.dispose());
                state.monacoModelCache = {};
                saveProject();
                renderFileTree();
                updateTabBar();
                refreshEditor();
                closeModal();
                showToast('New project created', 'success');
            }

            function saveCurrentFile() {
                if (!state.activeTabPath || !state.monacoEditor) return;
                const tab = state.openTabs.find(t => t.path === state.activeTabPath);
                if (!tab || !tab.dirty) return;
                const node = getNodeByPath(state.activeTabPath);
                if (!node || node.type !== 'file' || node.blobData) return;
                const model = state.monacoEditor.getModel();
                if (model && model === state.monacoModelCache[state.activeTabPath]) {
                    node.content = model.getValue();
                    tab.dirty = false;
                    updateTabBar();
                }
            }

            function openRecent() {
                const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
                if (history.length === 0) { showToast('No recent projects', 'info'); return; }
                let listHTML = history.map((h, i) => `
                    <div style="padding:8px;cursor:pointer;border-radius:6px;margin:4px 0;transition:var(--transition);" 
                         onmouseover="this.style.background='var(--bg-hover)'" 
                         onmouseout="this.style.background='transparent'" 
                         onclick="AyeshaApp.loadRecentProject(${i});AyeshaApp.closeModal();">
                        <strong>${h.name}</strong><br>
                        <small style="color:var(--text-muted);">${new Date(h.date).toLocaleString()} · ${h.fileCount} files</small>
                    </div>
                `).join('');
                showModal('Open Recent Project', listHTML +
                    '<div class="btn-row"><button class="btn-secondary" onclick="AyeshaApp.closeModal()">Cancel</button></div>',
                    true);
            }

            function loadRecentProject(index) {
                const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
                if (index >= 0 && index < history.length) {
                    state.projectName = history[index].name;
                    loadProject().then(() => {
                        renderFileTree();
                        updateTabBar();
                        refreshEditor();
                        renderImageGrid();
                        showToast('Project loaded: ' + state.projectName, 'success');
                    });
                }
            }

            // ─── Export ───────────────────────────────────────────────────────────
            async function exportProject() {
                saveCurrentFile();
                showModal('Export Project', `
                    <p>Choose export format:</p>
                    <select id="export-format" style="width:100%;margin-bottom:10px;">
                        <option value="asha">.asha (AyeshaMall Project)</option>
                        <option value="zip">.zip (ZIP Archive)</option>
                        <option value="json">.json (JSON)</option>
                        <option value="folder">Folder (File System API)</option>
                    </select>
                    <div class="btn-row">
                        <button class="btn-secondary" onclick="AyeshaApp.closeModal()">Cancel</button>
                        <button class="btn-primary" onclick="AyeshaApp.confirmExport()">Export</button>
                    </div>
                `);
            }

            async function confirmExport() {
                const format = document.getElementById('export-format').value;
                closeModal();
                if (format === 'asha') await exportAsha();
                else if (format === 'zip') await exportZip();
                else if (format === 'json') exportJson();
                else if (format === 'folder') await exportFolder();
            }

            async function exportAsha() {
                const ashaData = {
                    version: '1.0',
                    metadata: { projectName: state.projectName, theme: state.theme, exportDate: new Date().toISOString(),
                        app: 'AyeshaMall Online Code Editor' },
                    fileTree: serializeFileTree(state.fileTree),
                    openTabs: state.openTabs.map(t => ({ path: t.path, dirty: false })),
                    activeTabPath: state.activeTabPath,
                };
                const blob = new Blob([JSON.stringify(ashaData, null, 2)], { type: 'application/json' });
                downloadBlob(blob, (state.projectName || 'project') + '.asha');
                showToast('Exported as .asha', 'success');
            }

            async function exportZip() {
                try {
                    const zip = new JSZip();
                    await addFilesToZip(zip, state.fileTree, '');
                    const blob = await zip.generateAsync({ type: 'blob' });
                    downloadBlob(blob, (state.projectName || 'project') + '.zip');
                    showToast('Exported as .zip', 'success');
                } catch (err) {
                    console.error('Export error:', err);
                    showToast('Export failed: ' + err.message, 'error');
                }
            }

            async function addFilesToZip(zip, node, path) {
                if (node.type === 'file') {
                    if (node.blobData) zip.file(path + node.name, node.blobData);
                    else zip.file(path + node.name, node.content || '');
                } else if (node.children) {
                    const folderPath = path + (node.name === 'root' ? '' : node.name + '/');
                    for (const [key, child] of Object.entries(node.children)) {
                        await addFilesToZip(zip, child, folderPath);
                    }
                }
            }

            function exportJson() {
                const data = { projectName: state.projectName, fileTree: serializeFileTree(state.fileTree) };
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                downloadBlob(blob, (state.projectName || 'project') + '.json');
                showToast('Exported as JSON', 'success');
            }

            async function exportFolder() {
                if (!window.showDirectoryPicker) { showToast('File System API not supported', 'error'); return; }
                try {
                    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                    await writeNodeToFS(dirHandle, state.fileTree);
                    showToast('Exported to folder!', 'success');
                } catch (e) {
                    if (e.name !== 'AbortError') showToast('Export failed: ' + e.message, 'error');
                }
            }

            async function writeNodeToFS(dirHandle, node) {
                if (node.type === 'file') {
                    const fileHandle = await dirHandle.getFileHandle(node.name, { create: true });
                    const writable = await fileHandle.createWritable();
                    if (node.blobData) await writable.write(node.blobData);
                    else await writable.write(node.content || '');
                    await writable.close();
                } else if (node.type === 'folder' && node.children) {
                    if (node.name !== 'root') dirHandle = await dirHandle.getDirectoryHandle(node.name, { create: true });
                    for (const [key, child] of Object.entries(node.children)) {
                        await writeNodeToFS(dirHandle, child);
                    }
                }
            }

            function downloadBlob(blob, filename) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }

            // ─── Import ───────────────────────────────────────────────────────────
            function importProject() { document.getElementById('import-file-input').click(); }

            async function handleImportFile(event) {
                const file = event.target.files[0];
                if (!file) return;
                const ext = file.name.split('.').pop().toLowerCase();
                try {
                    if (ext === 'asha' || ext === 'json') {
                        const text = await file.text();
                        const data = JSON.parse(text);
                        if (data.fileTree) {
                            state.fileTree = await deserializeFileTree(data.fileTree, '');
                            state.projectName = data.metadata?.projectName || data.projectName || file.name.replace(
                                /\.\w+$/, '');
                            if (data.theme) state.theme = data.theme;
                            if (data.openTabs) {
                                state.openTabs = data.openTabs.map(t => ({ ...t, dirty: false, cursorState: null,
                                    scrollState: null }));
                                state.activeTabPath = data.activeTabPath || null;
                            } else { state.openTabs = [];
                                state.activeTabPath = null; }
                        }
                    } else if (ext === 'zip') {
                        if (typeof JSZip === 'undefined') { showToast('JSZip not loaded', 'error'); return; }
                        const zip = await JSZip.loadAsync(file);
                        state.fileTree = { name: 'root', type: 'folder', children: {}, blobUrl: null, blobData: null,
                            mediaType: '' };
                        state.projectName = file.name.replace(/\.zip$/, '');
                        for (const [zipPath, zipEntry] of Object.entries(zip.files)) {
                            if (zipEntry.dir) continue;
                            const parts = zipPath.split('/').filter(Boolean);
                            const fileName = parts.pop();
                            let current = state.fileTree;
                            for (const part of parts) {
                                if (!current.children) current.children = {};
                                if (!current.children[part]) {
                                    current.children[part] = { name: part, type: 'folder', children: {}, blobUrl: null,
                                        blobData: null, mediaType: '' };
                                }
                                current = current.children[part];
                            }
                            if (!current.children) current.children = {};
                            const blob = await zipEntry.async('blob');
                            const isMedia = blob.type.startsWith('image/') || blob.type.startsWith('video/') || blob
                                .type.startsWith('audio/');
                            const path = (parts.join('/') + '/' + fileName).replace(/^\/+/, '');
                            current.children[fileName] = {
                                name: fileName,
                                type: 'file',
                                content: '',
                                children: {},
                                blobUrl: isMedia ? URL.createObjectURL(blob) : null,
                                blobData: isMedia ? blob : null,
                                mediaType: isMedia ? blob.type : '',
                            };
                            if (!isMedia) current.children[fileName].content = await blob.text();
                            if (isMedia) await saveMediaToDB(path, blob);
                        }
                        state.openTabs = [];
                        state.activeTabPath = null;
                    }
                    saveProject();
                    renderFileTree();
                    updateTabBar();
                    refreshEditor();
                    renderImageGrid();
                    applySettings();
                    showToast('Project imported: ' + state.projectName, 'success');
                } catch (e) {
                    console.error('Import error:', e);
                    showToast('Import failed: ' + e.message, 'error');
                }
                event.target.value = '';
            }

            // ─── Settings ─────────────────────────────────────────────────────────
            function applySettings() {
                document.documentElement.setAttribute('data-theme', state.theme);
                document.getElementById('setting-theme').value = state.theme;
                document.getElementById('setting-fontsize').value = state.fontSize;
                document.getElementById('fontsize-val').textContent = state.fontSize + 'px';
                document.getElementById('setting-tabsize').value = state.tabSize;
                document.getElementById('setting-wordwrap').value = state.wordWrap;
                document.getElementById('setting-minimap').value = state.minimap;
                document.getElementById('setting-linenumbers').value = state.lineNumbers;
                document.getElementById('status-theme').textContent = state.theme.charAt(0).toUpperCase() + state.theme
                    .slice(1);
                if (state.monacoEditor) {
                    state.monacoEditor.updateOptions({
                        fontSize: state.fontSize,
                        tabSize: state.tabSize,
                        wordWrap: state.wordWrap,
                        minimap: { enabled: state.minimap === 'on' },
                        lineNumbers: state.lineNumbers,
                    });
                }
            }

            function setTheme(theme) {
                state.theme = theme;
                applySettings();
                if (state.monacoEditor) {
                    monaco.editor.setTheme(theme === 'light' ? 'vs' : theme === 'high-contrast' ? 'hc-black' :
                    'vs-dark');
                }
                saveProject();
                showToast('Theme: ' + theme, 'info');
            }

            function setFontSize(size) { state.fontSize = parseInt(size);
                document.getElementById('fontsize-val').textContent = size + 'px';
                applySettings();
                saveProject(); }

            function setTabSize(size) { state.tabSize = parseInt(size);
                applySettings();
                saveProject(); }

            function setWordWrap(val) { state.wordWrap = val;
                applySettings();
                saveProject(); }

            function setMinimap(val) { state.minimap = val;
                applySettings();
                saveProject(); }

            function setLineNumbers(val) { state.lineNumbers = val;
                applySettings();
                saveProject(); }

            function toggleTheme() {
                const themes = ['dark', 'light', 'high-contrast'];
                const idx = themes.indexOf(state.theme);
                setTheme(themes[(idx + 1) % themes.length]);
            }

            // ─── Panel Switching ──────────────────────────────────────────────────
            function switchPanel(panelName) {
                if (state.activePanel === panelName && document.getElementById('left-panel').classList.contains(
                    'collapsed')) {
                    document.getElementById('left-panel').classList.remove('collapsed');
                } else if (state.activePanel === panelName) {
                    document.getElementById('left-panel').classList.toggle('collapsed');
                } else {
                    document.getElementById('left-panel').classList.remove('collapsed');
                }
                state.activePanel = panelName;
                ['explorer', 'search', 'images', 'settings', 'git'].forEach(name => {
                    const panel = document.getElementById('panel-' + name);
                    if (panel) panel.classList.add('hidden');
                });
                const activePanel = document.getElementById('panel-' + panelName);
                if (activePanel) activePanel.classList.remove('hidden');
                document.querySelectorAll('.activity-icon').forEach(icon => {
                    icon.classList.remove('active');
                    if (icon.dataset.panel === panelName) icon.classList.add('active');
                });
                if (panelName === 'images') renderImageGrid();
                if (panelName === 'git') showToast('Git integration coming soon!', 'info');
            }

            // ─── Search ───────────────────────────────────────────────────────────
            function searchFiles(query) {
                const resultsContainer = document.getElementById('search-results');
                if (!query || query.trim().length < 2) {
                    resultsContainer.innerHTML = '<div style="padding:10px;color:var(--text-muted);">Type to search...</div>';
                    return;
                }
                const q = query.toLowerCase();
                const results = [];
                const allPaths = getAllFilePaths();
                allPaths.forEach(path => {
                    const node = getNodeByPath(path);
                    if (!node || node.type !== 'file') return;
                    if (path.toLowerCase().includes(q)) {
                        results.push({ path, type: 'name', match: path });
                    } else if (node.content && node.content.toLowerCase().includes(q)) {
                        const lines = node.content.split('\n');
                        lines.forEach((line, i) => {
                            if (line.toLowerCase().includes(q)) {
                                results.push({ path, type: 'content', match: line.trim(), line: i + 1 });
                            }
                        });
                    }
                });
                resultsContainer.innerHTML = results.slice(0, 50).map(r => {
                    let onclick = `AyeshaApp.openFile('${r.path}')`;
                    if (r.type === 'content') onclick += `;AyeshaApp.goToLine(${r.line})`;
                    return `<div class="search-result-item" onclick="${onclick}">
                        <span style="color:var(--accent);">${r.path}</span>
                        ${r.type === 'content' ? `<br><span style="color:var(--text-muted);font-size:11px;">Ln ${r.line}: ${r.match.substring(0, 80)}</span>` : ''}
                    </div>`;
                }).join('');
            }

            function goToLine(line) {
                if (state.monacoEditor && state.activeTabPath) {
                    state.monacoEditor.revealLineInCenter(line);
                    state.monacoEditor.setPosition({ lineNumber: line, column: 1 });
                }
            }

            function showGlobalSearch() { switchPanel('search');
                document.getElementById('search-input')?.focus(); }

            // ─── Undo / Redo ──────────────────────────────────────────────────────
            function undoFileOperation() {
                if (state.undoStack.length === 0) { showToast('Nothing to undo', 'info'); return; }
                const action = state.undoStack.pop();
                state.redoStack.push(action);
                if (action.action === 'delete') {
                    const parent = getNodeByPath(action.parentPath);
                    if (parent && parent.children) {
                        const node = action.node;
                        parent.children[node.name] = node;
                        saveProject();
                        renderFileTree();
                        showToast('Undo: restored ' + node.name, 'info');
                    }
                }
            }

            function redoFileOperation() {
                if (state.redoStack.length === 0) { showToast('Nothing to redo', 'info'); return; }
                const action = state.redoStack.pop();
                state.undoStack.push(action);
                if (action.action === 'delete') {
                    const parent = getNodeByPath(action.parentPath);
                    if (parent && parent.children && parent.children[action.node.name]) {
                        delete parent.children[action.node.name];
                        saveProject();
                        renderFileTree();
                        showToast('Redo: deleted ' + action.node.name, 'info');
                    }
                }
            }

            // ─── Properties Panel ────────────────────────────────────────────────
            function updatePropertiesPanel() {
                const typeEl = document.getElementById('prop-type');
                const pathEl = document.getElementById('prop-path');
                const sizeEl = document.getElementById('prop-size');
                const dimEl = document.getElementById('prop-dimensions');
                if (state.selectedFiles.length === 1) {
                    const path = state.selectedFiles[0];
                    const node = getNodeByPath(path);
                    if (node) {
                        typeEl.textContent = node.type === 'folder' ? 'Folder' : (node.mediaType || getLanguageFromPath(
                        path));
                        pathEl.textContent = path;
                        if (node.type === 'file') {
                            if (node.blobData) {
                                sizeEl.textContent = formatBytes(node.blobData.size);
                                if (node.mediaType?.startsWith('image')) {
                                    const img = new Image();
                                    img.onload = () => { dimEl.textContent = img.naturalWidth + '×' + img
                                            .naturalHeight; };
                                    img.src = node.blobUrl;
                                } else dimEl.textContent = node.mediaType?.startsWith('video') ? 'Video' : node
                                    .mediaType?.startsWith('audio') ? 'Audio' : '-';
                            } else {
                                sizeEl.textContent = formatBytes(new Blob([node.content || '']).size);
                                dimEl.textContent = (node.content || '').split('\n').length + ' lines';
                            }
                        } else { sizeEl.textContent = '-';
                            dimEl.textContent = '-'; }
                    }
                } else if (state.selectedFiles.length > 1) {
                    typeEl.textContent = state.selectedFiles.length + ' items';
                    pathEl.textContent = 'Multiple selection';
                    sizeEl.textContent = '-';
                    dimEl.textContent = '-';
                } else {
                    typeEl.textContent = '-';
                    pathEl.textContent = '-';
                    sizeEl.textContent = '-';
                    dimEl.textContent = '-';
                }
            }

            function formatBytes(bytes) {
                if (bytes < 1024) return bytes + ' B';
                if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
                return (bytes / 1048576).toFixed(1) + ' MB';
            }

            // ─── Recent Files ─────────────────────────────────────────────────────
            function updateRecentFilesList() {
                const container = document.getElementById('recent-files-list');
                if (!container) return;
                if (state.recentFiles.length === 0) {
                    container.innerHTML = '<div style="padding:10px;color:var(--text-muted);">No recent files</div>';
                    return;
                }
                container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Recent Files:</div>' +
                    state.recentFiles.slice(0, 10).map(p =>
                        `<div style="padding:3px 8px;cursor:pointer;border-radius:3px;font-size:12px;" 
                              onmouseover="this.style.background='var(--bg-hover)'" 
                              onmouseout="this.style.background='transparent'" 
                              onclick="AyeshaApp.openFile('${p}')">📄 ${p}</div>`
                    ).join('');
            }

            // ─── Format Code ──────────────────────────────────────────────────────
            function formatCode() {
                if (!state.monacoEditor || !state.activeTabPath) {
                    showToast('Open a file first', 'warning');
                    return;
                }
                state.monacoEditor.getAction('editor.action.formatDocument')?.run()
                    .then(() => showToast('Code formatted!', 'success'))
                    .catch(() => showToast('Formatting not available', 'warning'));
            }

            // ─── Command Palette ──────────────────────────────────────────────────
            function showCommandPalette() {
                const commands = [
                    { name: 'New File', action: 'createFile' },
                    { name: 'New Folder', action: 'createFolder' },
                    { name: 'Save Project', action: 'saveProject' },
                    { name: 'Export Project', action: 'exportProject' },
                    { name: 'Import Project', action: 'importProject' },
                    { name: 'Run Preview', action: 'runPreview' },
                    { name: 'Close Preview', action: 'closePreview' },
                    { name: 'Toggle Theme', action: 'toggleTheme' },
                    { name: 'Format Code', action: 'formatCode' },
                    { name: 'Global Search', action: 'showGlobalSearch' },
                    { name: 'Upload Media', action: 'uploadMedia' },
                    { name: 'Close All Tabs', action: 'closeAllTabs' },
                    { name: 'New Project', action: 'newProject' },
                ];
                let html = `<input type="text" id="command-palette-input" placeholder="Type a command..." style="width:100%;margin-bottom:8px;" autofocus>
                           <div id="command-list">`;
                html += commands.map(c =>
                    `<div class="search-result-item" data-action="${c.action}" style="display:flex;justify-content:space-between;"><span>${c.name}</span></div>`
                ).join('');
                html += '</div>';
                showModal('Command Palette', html, true);
                const input = document.getElementById('command-palette-input');
                input.addEventListener('input', () => {
                    const q = input.value.toLowerCase();
                    document.querySelectorAll('#command-list .search-result-item').forEach(el => {
                        el.style.display = el.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
                    });
                });
                document.querySelectorAll('#command-list .search-result-item').forEach(el => {
                    el.addEventListener('click', () => {
                        const action = el.dataset.action;
                        if (AyeshaApp[action]) AyeshaApp[action]();
                        closeModal();
                    });
                });
                input.focus();
            }

            function showAuthModal() {
                showModal('Sign In',
                    '<p style="text-align:center;padding:20px;">🔐 Cloud sync coming soon!<br><small style="color:var(--text-muted);">Your projects are saved locally for now.</small></p><div class="btn-row"><button class="btn-primary" onclick="AyeshaApp.closeModal()">OK</button></div>'
                    );
            }

            function showShortcutHelp() {
                showModal('Keyboard Shortcuts',
                    `<div style="font-size:12px;line-height:2;">Ctrl+S - Save | Ctrl+Shift+P - Command Palette | Ctrl+W - Close Tab | Ctrl+Tab - Next Tab | Ctrl+Shift+Tab - Prev Tab | Ctrl+Z - Undo | Ctrl+Y - Redo | Shift+Alt+F - Format | F1 - Help | Escape - Close Preview</div><div class="btn-row"><button class="btn-primary" onclick="AyeshaApp.closeModal()">Close</button></div>`,
                    true);
            }

            function collapseAll() { collapseAllNodes(state.fileTree);
                renderFileTree(); }

            function collapseAllNodes(node) {
                if (node.type === 'folder') { node._expanded = false; if (node.children) Object.values(node.children)
                        .forEach(collapseAllNodes); }
            }

            // ─── Keyboard Shortcuts ──────────────────────────────────────────────
            document.addEventListener('keydown', (e) => {
                const ctrl = e.ctrlKey || e.metaKey;
                if (ctrl && e.key === 's') { e.preventDefault();
                    saveProject(); return; }
                if (ctrl && e.shiftKey && e.key === 'P') { e.preventDefault();
                    showCommandPalette(); return; }
                if (ctrl && e.key === 'w') { e.preventDefault();
                    closeTab(state.activeTabPath); return; }
                if (ctrl && e.key === 'Tab') { e.preventDefault();
                    cycleTab(1); return; }
                if (ctrl && e.shiftKey && e.key === 'Tab') { e.preventDefault();
                    cycleTab(-1); return; }
                if (e.key === 'F1') { e.preventDefault();
                    showShortcutHelp(); return; }
                if (e.key === 'Escape') {
                    if (state.isPreviewOpen) closePreview();
                    else { state.selectedFiles = [];
                        updateFileTreeSelection();
                        removeContextMenu(); }
                    return;
                }
                if (ctrl && e.key === 'z') { e.preventDefault();
                    undoFileOperation(); return; }
                if (ctrl && e.key === 'y') { e.preventDefault();
                    redoFileOperation(); return; }
                if (ctrl && e.shiftKey && e.key === 'F') { e.preventDefault();
                    formatCode(); return; }
            });

            function cycleTab(direction) {
                if (state.openTabs.length < 2) return;
                const idx = state.openTabs.findIndex(t => t.path === state.activeTabPath);
                state.activeTabPath = state.openTabs[(idx + direction + state.openTabs.length) % state.openTabs.length]
                    .path;
                refreshEditor();
                updateTabBar();
            }

            // ─── Drag & Drop on Editor Area ──────────────────────────────────────
            const editorArea = document.getElementById('editor-area');
            editorArea.addEventListener('dragover', (e) => {
                if (e.dataTransfer.types.includes('Files')) { e.preventDefault();
                    editorArea.style.outline = '2px dashed var(--accent)'; }
            });
            editorArea.addEventListener('dragleave', () => { editorArea.style.outline = ''; });
            editorArea.addEventListener('drop', async (e) => {
                e.preventDefault();
                editorArea.style.outline = '';
                if (e.dataTransfer.files.length > 0) {
                    await handleMediaUpload({ target: { files: e.dataTransfer.files } });
                }
            });

            // ─── Resize Handles ──────────────────────────────────────────────────
            (function initResize() {
                const handle = document.getElementById('resize-handle');
                const leftPanel = document.getElementById('left-panel');
                let isResizing = false,
                    startX, startWidth;
                handle.addEventListener('mousedown', (e) => {
                    isResizing = true;
                    startX = e.clientX;
                    startWidth = leftPanel.offsetWidth;
                    handle.classList.add('active');
                    document.body.style.cursor = 'col-resize';
                    document.body.style.userSelect = 'none';
                });
                document.addEventListener('mousemove', (e) => {
                    if (!isResizing) return;
                    const w = Math.max(160, Math.min(500, startWidth + e.clientX - startX));
                    leftPanel.style.width = w + 'px';
                    document.documentElement.style.setProperty('--sidebar-width', w + 'px');
                });
                document.addEventListener('mouseup', () => {
                    if (isResizing) { isResizing = false;
                        handle.classList.remove('active');
                        document.body.style.cursor = '';
                        document.body.style.userSelect = '';
                        if (state.monacoEditor) state.monacoEditor.layout(); }
                });

                const bHandle = document.getElementById('bottom-resize-handle');
                const bPanel = document.getElementById('bottom-panel');
                let bResizing = false,
                    startY, startH;
                bHandle.addEventListener('mousedown', (e) => {
                    bResizing = true;
                    startY = e.clientY;
                    startH = bPanel.offsetHeight;
                    document.body.style.cursor = 'row-resize';
                    document.body.style.userSelect = 'none';
                });
                document.addEventListener('mousemove', (e) => {
                    if (!bResizing) return;
                    const h = Math.max(80, Math.min(400, startH + startY - e.clientY));
                    bPanel.style.height = h + 'px';
                    document.documentElement.style.setProperty('--bottom-panel-height', h + 'px');
                });
                document.addEventListener('mouseup', () => {
                    if (bResizing) { bResizing = false;
                        document.body.style.cursor = '';
                        document.body.style.userSelect = '';
                        if (state.monacoEditor) state.monacoEditor.layout(); }
                });
            })();

            // ─── Auto-save ────────────────────────────────────────────────────────
            setInterval(() => {
                saveCurrentFile();
                localStorage.setItem(STORAGE_KEY, JSON.stringify({
                    projectName: state.projectName,
                    theme: state.theme,
                    fontSize: state.fontSize,
                    tabSize: state.tabSize,
                    wordWrap: state.wordWrap,
                    minimap: state.minimap,
                    lineNumbers: state.lineNumbers,
                    fileTree: serializeFileTree(state.fileTree),
                    openTabs: state.openTabs.map(t => ({ path: t.path, dirty: t.dirty })),
                    activeTabPath: state.activeTabPath,
                    recentFiles: state.recentFiles,
                }));
            }, 30000);

            // ─── Expose public API ──────────────────────────────────────────────
            AyeshaApp.newProject = newProject;
            AyeshaApp.openRecent = openRecent;
            AyeshaApp.saveProject = saveProject;
            AyeshaApp.exportProject = exportProject;
            AyeshaApp.importProject = importProject;
            AyeshaApp.uploadMedia = uploadMedia;
            AyeshaApp.toggleTheme = toggleTheme;
            AyeshaApp.runPreview = runPreview;
            AyeshaApp.closePreview = closePreview;
            AyeshaApp.createFile = createFile;
            AyeshaApp.createFolder = createFolder;
            AyeshaApp.refreshFileTree = () => { renderFileTree();
                updateRecentFilesList(); };
            AyeshaApp.collapseAll = collapseAll;
            AyeshaApp.cutFiles = cutFiles;
            AyeshaApp.copyFiles = copyFiles;
            AyeshaApp.pasteFiles = pasteFiles;
            AyeshaApp.duplicateFile = duplicateFile;
            AyeshaApp.moveFile = moveFile;
            AyeshaApp.confirmCreateFile = confirmCreateFile;
            AyeshaApp.confirmCreateFolder = confirmCreateFolder;
            AyeshaApp.confirmRename = confirmRename;
            AyeshaApp.confirmDelete = confirmDelete;
            AyeshaApp.confirmMove = confirmMove;
            AyeshaApp.confirmNewProject = confirmNewProject;
            AyeshaApp.confirmExport = confirmExport;
            AyeshaApp.closeModal = closeModal;
            AyeshaApp.handleMediaUpload = handleMediaUpload;
            AyeshaApp.handleImportFile = handleImportFile;
            AyeshaApp.previewMedia = previewMedia;
            AyeshaApp.insertMediaAtCursor = insertMediaAtCursor;
            AyeshaApp.copyMediaPath = copyMediaPath;
            AyeshaApp.openFile = openFile;
            AyeshaApp.closeTab = closeTab;
            AyeshaApp.closeOtherTabs = closeOtherTabs;
            AyeshaApp.closeAllTabs = closeAllTabs;
            AyeshaApp.searchFiles = searchFiles;
            AyeshaApp.goToLine = goToLine;
            AyeshaApp.setTheme = setTheme;
            AyeshaApp.setFontSize = setFontSize;
            AyeshaApp.setTabSize = setTabSize;
            AyeshaApp.setWordWrap = setWordWrap;
            AyeshaApp.setMinimap = setMinimap;
            AyeshaApp.setLineNumbers = setLineNumbers;
            AyeshaApp.switchPanel = switchPanel;
            AyeshaApp.clearConsole = clearConsole;
            AyeshaApp.loadRecentProject = loadRecentProject;
            AyeshaApp.showAuthModal = showAuthModal;
            AyeshaApp.showCommandPalette = showCommandPalette;
            AyeshaApp.formatCode = formatCode;
            AyeshaApp.showGlobalSearch = showGlobalSearch;
            AyeshaApp.downloadSingleFile = downloadSingleFile;
            AyeshaApp.undoFileOperation = undoFileOperation;
            AyeshaApp.redoFileOperation = redoFileOperation;

            // ─── Init ─────────────────────────────────────────────────────────────
            async function init() {
                if (window.APP_INITIALIZED) return;
                window.APP_INITIALIZED = true;
                try {
                    await loadProject();
                    state.projectHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
                    renderFileTree();
                    updateTabBar();
                    updateRecentFilesList();
                    renderImageGrid();
                    applySettings();
                    document.getElementById('status-theme').textContent = state.theme.charAt(0).toUpperCase() + state
                        .theme.slice(1);
                    if (!window.MONACO_INITIALIZED) initMonaco();
                    window.addEventListener('resize', () => { if (state.monacoEditor) state.monacoEditor.layout(); });
                    appendConsole('log', 'Editor ready. Welcome! 🚀');
                } catch (e) {
                    console.error('Init error:', e);
                    initDefaultProject();
                    renderFileTree();
                    renderImageGrid();
                    if (!window.MONACO_INITIALIZED) initMonaco();
                }
            }

            init().catch(err => {
                console.error('Init error:', err);
                initDefaultProject();
                renderFileTree();
                renderImageGrid();
                if (!window.MONACO_INITIALIZED) initMonaco();
            });

        })();
   
