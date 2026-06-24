// ==UserScript==
// @name         PTA pintia 学习助手 (MiMo 增强版)
// @namespace    a jjjjjjjjjjjjun.
// @version      3.5-mimo
// @description  自动识别题型，支持判断、单选、函数、编程题。预填 MiMo 模型 API，开箱即用。新增：单题答题、错误题目跳转、复制破解。
// @author       A Jun (MiMo 增强 by 小龙)
// @match        *://*.pintia.cn/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    // --- 0. 配置管理 ---
    let isRunning = false;
    let solveCount = 0;
    let currentMode = 'solve'; // 'solve' = 自动答题, 'check' = 检查答案
    let isMinimized = true; // 默认最小化
    let wrongQuestions = []; // 记录检查模式下错误的题目
    let targetQuestionNum = null; // 目标题号，null表示全部

    // PTA 题目内容干扰元素选择器
    const TRASH_SELECTORS = [
        '.ln', '.lnBorder', '.ln-border', '.function_HJSmz', '.foldIcon_V3Ad2',
        'button', '.cm-gutters', '.cm-panels', '.cm-announced',
        '.language_E7263', '.languageName_cZYHa', '.toolbar_SkQeK',
        '.pc-button', '.select-none.bd-left-1',
        '.action_ZO2qN', '.cm-panel',
        '.pc-icon', '.select-none.bd-left-1',
        'span[class*="rounded-r-sm"]',
        'span.select-none'
    ];

    const CONFIG = {
        get autoNext() { return GM_getValue('pta_auto_next', false); },
        set autoNext(v) { GM_setValue('pta_auto_next', v); },
        get funcLang() { return GM_getValue('pta_func_lang', 'C'); },
        set funcLang(v) { GM_setValue('pta_func_lang', v); },
        get progLang() { return GM_getValue('pta_prog_lang', 'C'); },
        set progLang(v) { GM_setValue('pta_prog_lang', v); },
        get removeComments() { return GM_getValue('pta_remove_comments', true); },
        set removeComments(v) { GM_setValue('pta_remove_comments', v); },
        get showAnalysis() { return GM_getValue('pta_show_analysis', true); },
        set showAnalysis(v) { GM_setValue('pta_show_analysis', v); },
        get apiUrl() { return GM_getValue('pta_api_url', 'https://api.xiaomimimo.com/v1/chat/completions'); },
        set apiUrl(v) { GM_setValue('pta_api_url', v); },
        get apiKey() { return GM_getValue('pta_api_key', ''); },
        set apiKey(v) { GM_setValue('pta_api_key', v); },
        get apiModel() { return GM_getValue('pta_api_model', 'mimo-v2.5-pro'); },
        set apiModel(v) { GM_setValue('pta_api_model', v); }
    };

    // 语言映射表
    const LANG_MAP = {
        'C': 'C (gcc)',
        'C++': 'C++ (g++)',
        'Java': 'Java (javac)',
        'Python': 'Python (python3)'
    };

    // --- 1. 复制破解功能 ---
    function unlockCopy() {
        console.log('[PTA Helper] 正在解除复制限制...');

        // 方法1: 覆盖 addEventListener，阻止注册 copy/cut/paste 等事件
        const originalAddEventListener = EventTarget.prototype.addEventListener;
        const blockedEvents = ['copy', 'cut', 'paste', 'selectstart', 'contextmenu', 'dragstart'];

        EventTarget.prototype.addEventListener = function(type, listener, options) {
            if (blockedEvents.includes(type)) {
                console.log(`[PTA Helper] 已阻止注册 ${type} 事件监听器`);
                return;
            }
            return originalAddEventListener.call(this, type, listener, options);
        };

        // 方法2: 在捕获阶段拦截并阻止事件传播
        blockedEvents.forEach(eventType => {
            document.addEventListener(eventType, function(e) {
                e.stopImmediatePropagation();
                e.stopPropagation();
                // 对于某些事件，还需要阻止默认行为
                if (eventType === 'selectstart') {
                    // 不阻止默认行为，允许选择
                }
            }, true); // 使用捕获阶段
        });

        // 方法3: 移除元素上的 onXXX 属性
        function removeInlineHandlers() {
            const elements = [document, document.body, ...document.querySelectorAll('*')];
            elements.forEach(el => {
                blockedEvents.forEach(eventType => {
                    if (el[`on${eventType}`]) {
                        el[`on${eventType}`] = null;
                    }
                });
            });
        }
        removeInlineHandlers();

        // 方法4: 添加 CSS 强制允许选择
        const style = document.createElement('style');
        style.id = 'pta-helper-unlock-copy';
        style.textContent = `
            *, *::before, *::after {
                -webkit-user-select: text !important;
                -moz-user-select: text !important;
                -ms-user-select: text !important;
                user-select: text !important;
                -webkit-touch-callout: default !important;
                pointer-events: auto !important;
            }
            input, textarea, [contenteditable] {
                -webkit-user-modify: read-write !important;
                user-modify: read-write !important;
            }
            /* 移除可能的事件阻止层 */
            [class*="lock"], [class*="prevent"], [class*="disable"] {
                pointer-events: auto !important;
            }
        `;
        if (!document.getElementById('pta-helper-unlock-copy')) {
            document.head.appendChild(style);
        }

        // 方法5: 定期检查并移除新添加的限制
        setInterval(() => {
            removeInlineHandlers();

            // 移除 data 属性中的事件处理
            document.querySelectorAll('[data-copy], [data-cut], [data-paste]').forEach(el => {
                el.removeAttribute('data-copy');
                el.removeAttribute('data-cut');
                el.removeAttribute('data-paste');
            });
        }, 1000);

        // 方法6: 覆盖 document.execCommand 以确保复制可用
        const originalExecCommand = document.execCommand;
        document.execCommand = function(command) {
            if (command === 'copy' || command === 'cut' || command === 'paste') {
                console.log(`[PTA Helper] 允许执行 ${command} 命令`);
            }
            return originalExecCommand.apply(this, arguments);
        };

        console.log('[PTA Helper] 复制限制已解除');
    }

    // 立即执行
    unlockCopy();

    // 页面加载完成后再执行一次
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', unlockCopy);
    } else {
        // 已经加载完成，延迟再执行一次确保生效
        setTimeout(unlockCopy, 500);
    }

    // 页面完全加载后再次执行
    window.addEventListener('load', () => {
        unlockCopy();
        console.log('[PTA Helper] 页面加载完成，再次解除复制限制');
    });

    // --- 2. 样式定义 ---
    GM_addStyle(`
        #pta-helper-window {
            position: fixed;
            top: 100px;
            right: 20px;
            width: 420px;
            height: 620px;
            background: #fff;
            border: 1px solid #ccc;
            border-radius: 12px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.15);
            z-index: 99999;
            display: flex;
            flex-direction: column;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden;
            transition: all 0.3s ease;
        }
        #pta-helper-window.minimized {
            width: 60px;
            height: 60px;
            border-radius: 50%;
            top: auto;
            bottom: 20px;
            right: 20px;
            left: auto;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        #pta-helper-window.minimized > *:not(.minimized-icon) {
            display: none !important;
        }
        #pta-helper-window.minimized .minimized-icon {
            display: flex !important;
            width: 100%;
            height: 100%;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 24px;
            font-weight: bold;
        }
        .minimized-icon {
            display: none;
        }
        #pta-helper-header {
            padding: 12px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            cursor: move;
            border-bottom: 1px solid #eee;
            font-weight: 600;
            display: flex;
            justify-content: space-between;
            align-items: center;
            color: white;
            flex-shrink: 0;
        }
        #pta-helper-header .header-left {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        #pta-helper-header .header-right {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .header-btn {
            background: rgba(255,255,255,0.2);
            border: none;
            color: white;
            width: 28px;
            height: 28px;
            border-radius: 6px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            transition: background 0.2s;
        }
        .header-btn:hover {
            background: rgba(255,255,255,0.35);
        }
        #mode-switch {
            display: flex;
            background: #f8f9fa;
            border-bottom: 1px solid #eee;
            padding: 8px;
            gap: 8px;
        }
        .mode-btn {
            flex: 1;
            padding: 10px 12px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            text-align: center;
            transition: all 0.2s;
            background: white;
            color: #666;
        }
        .mode-btn.active-solve {
            border-color: #667eea;
            background: #f0f2ff;
            color: #667eea;
        }
        .mode-btn.active-check {
            border-color: #48bb78;
            background: #f0fff4;
            color: #48bb78;
        }
        .mode-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        .mode-btn .mode-icon {
            font-size: 18px;
            margin-bottom: 4px;
        }
        #pta-helper-tabs {
            display: flex;
            background: #f8f9fa;
            border-bottom: 1px solid #eee;
            flex-shrink: 0;
        }
        .pta-tab {
            flex: 1;
            padding: 10px;
            text-align: center;
            cursor: pointer;
            font-size: 13px;
            color: #666;
            transition: all 0.2s;
        }
        .pta-tab.active {
            color: #667eea;
            border-bottom: 2px solid #667eea;
            background: #fff;
            font-weight: bold;
        }
        #api-tab, #settings-tab {
            padding: 15px;
            font-size: 13px;
            color: #444;
            line-height: 1.6;
            overflow-y: auto;
        }
        .api-input-group {
            margin-bottom: 15px;
            text-align: left;
        }
        .api-input-group label {
            display: block;
            margin-bottom: 6px;
            font-weight: 500;
            color: #333;
        }
        .api-input-group input {
            width: 100%;
            padding: 8px;
            border: 1px solid #ddd;
            border-radius: 6px;
            box-sizing: border-box;
            font-size: 13px;
        }
        .api-tips {
            font-size: 11px;
            color: #888;
            margin-top: 15px;
            background: #fdf6ec;
            color: #e6a23c;
            padding: 10px;
            border-radius: 6px;
            border-left: 3px solid #e6a23c;
        }
        #pta-tab-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .tab-pane {
            display: none;
            flex: 1;
            flex-direction: column;
            overflow: hidden;
        }
        .tab-pane.active {
            display: flex;
        }
        #pta-helper-settings {
            padding: 15px;
            font-size: 13px;
            overflow-y: auto;
        }
        .setting-item { margin-bottom: 15px; }
        .setting-item label { display: block; margin-bottom: 6px; color: #444; font-weight: 500; }
        .setting-item input[type="text"], .setting-item select {
            width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #ddd; border-radius: 6px;
            font-size: 13px;
        }
        .setting-item.checkbox-item { display: flex; align-items: center; gap: 10px; cursor: pointer; }
        .setting-item.checkbox-item label { display: inline; margin-bottom: 0; color: #333; cursor: pointer; }
        .setting-item.checkbox-item input { width: auto; margin: 0; cursor: pointer; }

        #pta-helper-log {
            flex: 1;
            padding: 12px;
            font-size: 12px;
            overflow-y: auto;
            background: #fff;
            color: #333;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .log-item {
            border-left: 3px solid #eee;
            padding: 8px 10px;
            background: #fcfcfc;
            border-radius: 4px;
        }
        .log-item.info { border-left-color: #667eea; background: #f0f2ff; color: #4a5568; font-weight: 500; text-align: center; border-left: none; border-radius: 4px; }
        .log-item.correct { border-left-color: #48bb78; background: #f0fff4; }
        .log-item.wrong { border-left-color: #f56565; background: #fff5f5; }
        .log-item.mode-info { border-left-color: #667eea; background: linear-gradient(135deg, #f0f2ff, #e6e9ff); font-weight: bold; text-align: center; }
        .log-item.summary { border-left-color: #f56565; background: #fff5f5; padding: 12px; }
        .log-item.summary-title { border-left-color: #e53e3e; background: #fff5f5; font-weight: bold; font-size: 14px; color: #e53e3e; }
        .log-item.summary-item { border-left-color: #f56565; background: #fff5f5; font-size: 12px; color: #4a5568; margin-left: 10px; }
        .log-item.summary-correct { border-left-color: #48bb78; background: #f0fff4; font-weight: bold; font-size: 14px; color: #38a169; }
        .log-q { color: #555; font-weight: 600; margin-bottom: 4px; white-space: pre-wrap; word-break: break-all; }
        .log-a { color: #28a745; white-space: pre-wrap; line-height: 1.4; font-size: 11px; }
        .log-answer { color: #667eea; font-weight: bold; font-size: 13px; margin-top: 4px; }
        .log-user-answer { color: #e53e3e; font-weight: bold; font-size: 13px; margin-top: 4px; }
        .log-correct-answer { color: #38a169; font-weight: bold; font-size: 13px; margin-top: 4px; }
        .log-analysis { color: #718096; font-size: 11px; margin-top: 4px; padding: 6px; background: #f7fafc; border-radius: 4px; display: none; }
        .log-analysis.show { display: block; }
        .log-err { color: #dc3545; }
        .log-status { color: #999; font-style: italic; font-size: 11px; }

        #pta-helper-footer {
            padding: 12px;
            border-top: 1px solid #eee;
            background: #fff;
            display: flex;
            gap: 8px;
            flex-shrink: 0;
            flex-wrap: wrap;
        }
        #single-question-input {
            width: 60px;
            padding: 6px 8px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 12px;
            text-align: center;
        }
        #single-question-input::placeholder {
            color: #aaa;
        }
        .log-item.clickable {
            cursor: pointer;
            transition: all 0.2s;
        }
        .log-item.clickable:hover {
            transform: translateX(4px);
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        .jump-icon {
            display: inline-block;
            margin-left: 6px;
            color: #667eea;
            font-size: 12px;
            opacity: 0;
            transition: opacity 0.2s;
        }
        .log-item.clickable:hover .jump-icon {
            opacity: 1;
        }
        .pta-btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 8px 12px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            flex: 1;
            transition: all 0.3s;
        }
        .pta-btn.check-btn {
            background: linear-gradient(135deg, #48bb78 0%, #38a169 100%);
        }
        .pta-btn.danger { background: linear-gradient(135deg, #f56565 0%, #ed64a6 100%); }
        .pta-btn.secondary { background: #6c757d; }
        .pta-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .pta-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }

        .analysis-toggle {
            color: #667eea;
            cursor: pointer;
            font-size: 11px;
            margin-top: 4px;
            user-select: none;
        }
        .analysis-toggle:hover {
            text-decoration: underline;
        }
    `);

    // --- 3. 创建 UI ---
    const helperWin = document.createElement('div');
    helperWin.id = 'pta-helper-window';
    helperWin.classList.add('minimized'); // 默认最小化
    helperWin.innerHTML = `
        <div class="minimized-icon">🐉</div>
        <div id="pta-helper-header">
            <div class="header-left">
                <span>PTA 学习助手</span>
                <span style="font-size: 10px; opacity: 0.8;">v3.0</span>
            </div>
            <div class="header-right">
                <button class="header-btn" id="minimize-btn" title="最小化">—</button>
            </div>
        </div>
        <div id="mode-switch">
            <div class="mode-btn active-solve" data-mode="solve" title="自动答题模式">
                <div class="mode-icon">🤖</div>
                <div>自动答题</div>
            </div>
            <div class="mode-btn" data-mode="check" title="检查答案模式">
                <div class="mode-icon">✅</div>
                <div>检查答案</div>
            </div>
        </div>
        <div id="pta-helper-tabs">
            <div class="pta-tab active" data-tab="home">主页</div>
            <div class="pta-tab" data-tab="settings">设置</div>
            <div class="pta-tab" data-tab="api">API设置</div>
        </div>
        <div id="pta-tab-content">
            <div id="home-tab" class="tab-pane active">
                <div id="pta-helper-log"></div>
                <div id="pta-helper-footer">
                    <input type="number" id="single-question-input" placeholder="题号" min="1" title="留空答全部，输入数字答单题">
                    <button id="start-btn" class="pta-btn">开始答题</button>
                    <button id="stop-btn" class="pta-btn danger" style="display:none;">停止</button>
                    <button id="clear-btn" class="pta-btn secondary">清空日志</button>
                </div>
            </div>
            <div id="settings-tab" class="tab-pane">
                <div id="pta-helper-settings">
                    <div class="setting-item checkbox-item">
                        <input type="checkbox" id="auto-next-input" ${CONFIG.autoNext ? 'checked' : ''}>
                        <label for="auto-next-input">完成后自动切换下一题型</label>
                    </div>
                    <div class="setting-item checkbox-item">
                        <input type="checkbox" id="show-analysis-input" ${CONFIG.showAnalysis ? 'checked' : ''}>
                        <label for="show-analysis-input" style="color: #48bb78; font-weight: bold;">显示答案解析</label>
                    </div>
                    <div class="setting-item checkbox-item">
                        <input type="checkbox" id="remove-comments-input" ${CONFIG.removeComments ? 'checked' : ''}>
                        <label for="remove-comments-input">提交前自动清除代码注释</label>
                    </div>
                    <div class="setting-item">
                        <label>函数题语言:</label>
                        <select id="func-lang-select">
                            <option value="C" ${CONFIG.funcLang === 'C' ? 'selected' : ''}>C</option>
                            <option value="C++" ${CONFIG.funcLang === 'C++' ? 'selected' : ''}>C++</option>
                            <option value="Java" ${CONFIG.funcLang === 'Java' ? 'selected' : ''}>Java</option>
                            <option value="Python" ${CONFIG.funcLang === 'Python' ? 'selected' : ''}>Python</option>
                        </select>
                    </div>
                    <div class="setting-item">
                        <label>编程题语言:</label>
                        <select id="prog-lang-select">
                            <option value="C" ${CONFIG.progLang === 'C' ? 'selected' : ''}>C</option>
                            <option value="C++" ${CONFIG.progLang === 'C++' ? 'selected' : ''}>C++</option>
                            <option value="Java" ${CONFIG.progLang === 'Java' ? 'selected' : ''}>Java</option>
                            <option value="Python" ${CONFIG.progLang === 'Python' ? 'selected' : ''}>Python</option>
                        </select>
                    </div>
                    <div style="font-size: 11px; color: #999; text-align: center; margin-top: 20px;">
                        设置将自动保存<br><br>
                        本脚本已自动解除网站复制限制
                    </div>
                </div>
            </div>
            <div id="api-tab" class="tab-pane">
                <div class="api-input-group">
                    <label>API URL:</label>
                    <input type="text" id="api-url-input" value="${CONFIG.apiUrl}" placeholder="https://api.xiaomimimo.com/v1/chat/completions">
                </div>
                <div class="api-input-group">
                    <label>API Key:</label>
                    <input type="password" id="api-key-input" value="${CONFIG.apiKey}" placeholder="sk-... (MiMo 平台申请)">
                </div>
                <div class="api-input-group">
                    <label>模型 (Model):</label>
                    <input type="text" id="api-model-input" value="${CONFIG.apiModel}" placeholder="mimo-v2.5-pro 或 mimo-v2-flash">
                </div>
                <div class="api-tips">
                    请填写支持 OpenAI 格式的 API 接口。<br>
                    如果您使用中转 API，请确保填写的 URL 包含完整路径（通常以 /v1/chat/completions 结尾）。
                </div>
                <div style="margin-top: 15px; padding: 12px; background: #f0f9eb; border-radius: 8px; font-size: 12px; border: 1px solid #e1f3d8; color: #67c23a;">
                    <strong>当前默认已预填小米 MiMo：</strong>
                    <div style="margin-top: 5px; font-family: monospace; background: #fff; padding: 8px; border-radius: 4px; border: 1px solid #e1f3d8; line-height: 1.5;">
                        API URL: https://api.xiaomimimo.com/v1/chat/completions<br>
                        模型 (Model): mimo-v2.5-pro（强）或 mimo-v2-flash（快）
                    </div>
                    <span style="font-size: 11px; color: #999; display: block; margin-top: 5px;">* 填好 API Key 即可使用。Key 申请: platform.xiaomimimo.com</span>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(helperWin);

    const logContainer = document.getElementById('pta-helper-log');
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    const minimizedIcon = helperWin.querySelector('.minimized-icon');

    // --- 4. 最小化功能 ---
    function toggleMinimize() {
        isMinimized = !isMinimized;
        if (isMinimized) {
            helperWin.classList.add('minimized');
        } else {
            helperWin.classList.remove('minimized');
        }
    }

    minimizedIcon.addEventListener('click', toggleMinimize);
    document.getElementById('minimize-btn').addEventListener('click', toggleMinimize);

    // --- 5. 模式切换 ---
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            currentMode = mode;
            document.querySelectorAll('.mode-btn').forEach(b => {
                b.classList.remove('active-solve', 'active-check');
            });
            btn.classList.add(mode === 'solve' ? 'active-solve' : 'active-check');

            // 更新按钮文字
            startBtn.textContent = mode === 'solve' ? '开始答题' : '检查答案';
            startBtn.className = mode === 'solve' ? 'pta-btn' : 'pta-btn check-btn';

            addInfoLog(`已切换到${mode === 'solve' ? '自动答题' : '检查答案'}模式`);
        });
    });

    // --- 6. 日志功能 ---
    function addLog(question, questionIndex = -1) {
        const div = document.createElement('div');
        div.className = 'log-item';
        div.innerHTML = `<div class="log-q">题: ${question}</div><div class="log-status">AI 思考中...</div>`;

        // 如果是检查模式，添加点击跳转功能
        if (currentMode === 'check' && questionIndex >= 0) {
            div.classList.add('clickable');
            div.dataset.questionIndex = questionIndex;
            div.addEventListener('click', () => {
                jumpToQuestion(questionIndex);
            });
        }

        logContainer.appendChild(div);
        logContainer.scrollTop = logContainer.scrollHeight;
        return div;
    }

    // 跳转到指定题目
    function jumpToQuestion(index) {
        const questions = document.querySelectorAll('div.pc-x[id]');
        if (questions[index]) {
            questions[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
            // 添加高亮效果
            questions[index].style.transition = 'background-color 0.3s';
            questions[index].style.backgroundColor = '#fff3cd';
            setTimeout(() => {
                questions[index].style.backgroundColor = '';
            }, 2000);
        }
    }

    function addInfoLog(message) {
        const div = document.createElement('div');
        div.className = 'log-item info';
        div.innerText = message;
        logContainer.appendChild(div);
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    function addModeInfoLog(message) {
        const div = document.createElement('div');
        div.className = 'log-item mode-info';
        div.innerText = message;
        logContainer.appendChild(div);
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    function updateLogSolve(logItem, answerText, analysis = '', success = true) {
        const statusDiv = logItem.querySelector('.log-status');
        if (statusDiv) {
            statusDiv.className = success ? 'log-a' : 'log-err';
            statusDiv.innerText = success ? `答: ${answerText}` : `错误: ${answerText}`;
        }

        if (success && answerText) {
            const answerDiv = document.createElement('div');
            answerDiv.className = 'log-answer';
            answerDiv.innerText = `✓ 答案: ${answerText}`;
            logItem.appendChild(answerDiv);

            if (analysis && CONFIG.showAnalysis) {
                const analysisDiv = document.createElement('div');
                analysisDiv.className = 'log-analysis show';
                analysisDiv.innerHTML = `<strong>解析：</strong><br>${analysis}`;
                logItem.appendChild(analysisDiv);

                const toggleBtn = document.createElement('div');
                toggleBtn.className = 'analysis-toggle';
                toggleBtn.innerText = '收起解析';
                toggleBtn.onclick = function() {
                    if (analysisDiv.classList.contains('show')) {
                        analysisDiv.classList.remove('show');
                        toggleBtn.innerText = '展开解析';
                    } else {
                        analysisDiv.classList.add('show');
                        toggleBtn.innerText = '收起解析';
                    }
                };
                logItem.appendChild(toggleBtn);
            }
        }

        if (success) {
            solveCount++;
            logItem.classList.add('correct');
        } else {
            logItem.classList.add('wrong');
        }
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    function updateLogCheck(logItem, userAnswer, aiAnswer, analysis = '', isCorrect = false, questionNum = 0) {
        const statusDiv = logItem.querySelector('.log-status');
        if (statusDiv) {
            statusDiv.className = isCorrect ? 'log-a' : 'log-err';
            statusDiv.innerText = isCorrect ? '✓ 正确' : '✗ 错误';
        }

        const userAnswerDiv = document.createElement('div');
        userAnswerDiv.className = 'log-user-answer';
        userAnswerDiv.innerText = `你的答案: ${userAnswer}`;
        logItem.appendChild(userAnswerDiv);

        if (!isCorrect) {
            const correctAnswerDiv = document.createElement('div');
            correctAnswerDiv.className = 'log-correct-answer';
            correctAnswerDiv.innerText = `正确答案: ${aiAnswer}`;
            logItem.appendChild(correctAnswerDiv);

            // 记录错误题目
            wrongQuestions.push({
                num: questionNum,
                userAnswer: userAnswer,
                correctAnswer: aiAnswer
            });

            // 只在错误答案时显示解析
            if (analysis && CONFIG.showAnalysis) {
                const analysisDiv = document.createElement('div');
                analysisDiv.className = 'log-analysis show';
                analysisDiv.innerHTML = `<strong>解析：</strong><br>${analysis}`;
                logItem.appendChild(analysisDiv);

                const toggleBtn = document.createElement('div');
                toggleBtn.className = 'analysis-toggle';
                toggleBtn.innerText = '收起解析';
                toggleBtn.onclick = function() {
                    if (analysisDiv.classList.contains('show')) {
                        analysisDiv.classList.remove('show');
                        toggleBtn.innerText = '展开解析';
                    } else {
                        analysisDiv.classList.add('show');
                        toggleBtn.innerText = '收起解析';
                    }
                };
                logItem.appendChild(toggleBtn);
            }
        }

        if (isCorrect) {
            logItem.classList.add('correct');
        } else {
            logItem.classList.add('wrong');
        }
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    // 显示检查结果总结
    function showCheckSummary() {
        if (currentMode !== 'check') return;

        // 分隔线
        const divider = document.createElement('div');
        divider.className = 'log-item info';
        divider.innerHTML = '<hr style="border: none; border-top: 2px dashed #667eea; margin: 5px 0;">';
        logContainer.appendChild(divider);

        if (wrongQuestions.length === 0) {
            // 全部正确
            const summaryDiv = document.createElement('div');
            summaryDiv.className = 'log-item summary-correct';
            summaryDiv.innerHTML = '🎉 恭喜！所有题目全部正确！';
            logContainer.appendChild(summaryDiv);
        } else {
            // 有错误题目
            const titleDiv = document.createElement('div');
            titleDiv.className = 'log-item summary-title';
            titleDiv.innerHTML = `📋 检查完成，共发现 ${wrongQuestions.length} 道错题：`;
            logContainer.appendChild(titleDiv);

            // 列出所有错误题目
            wrongQuestions.forEach((q, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'log-item summary-item';
                itemDiv.innerHTML = `<strong>第 ${q.num} 题：</strong>你的答案 "${q.userAnswer}" → 正确答案 "${q.correctAnswer}"`;
                logContainer.appendChild(itemDiv);
            });
        }

        // 清空错误题目记录
        wrongQuestions = [];
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    // --- 7. Tab 切换逻辑 ---
    document.querySelectorAll('.pta-tab').forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('.pta-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`${tab.dataset.tab}-tab`).classList.add('active');
        };
    });

    // --- 8. 设置保存逻辑 ---
    document.getElementById('auto-next-input').onchange = (e) => CONFIG.autoNext = e.target.checked;
    document.getElementById('show-analysis-input').onchange = (e) => CONFIG.showAnalysis = e.target.checked;
    document.getElementById('remove-comments-input').onchange = (e) => CONFIG.removeComments = e.target.checked;
    document.getElementById('func-lang-select').onchange = (e) => CONFIG.funcLang = e.target.value;
    document.getElementById('prog-lang-select').onchange = (e) => CONFIG.progLang = e.target.value;
    document.getElementById('api-url-input').onchange = (e) => CONFIG.apiUrl = e.target.value;
    document.getElementById('api-key-input').onchange = (e) => CONFIG.apiKey = e.target.value;
    document.getElementById('api-model-input').onchange = (e) => CONFIG.apiModel = e.target.value;

    document.getElementById('clear-btn').onclick = () => { logContainer.innerHTML = ''; };

    stopBtn.onclick = () => {
        isRunning = false;
        addInfoLog("正在停止...");
    };

    // --- 9. 拖拽逻辑 ---
    let isDragging = false;
    let offset = { x: 0, y: 0 };
    const header = document.getElementById('pta-helper-header');
    header.onmousedown = (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
        isDragging = true;
        offset.x = e.clientX - helperWin.offsetLeft;
        offset.y = e.clientY - helperWin.offsetTop;
    };
    document.onmousemove = (e) => {
        if (!isDragging) return;
        helperWin.style.left = (e.clientX - offset.x) + 'px';
        helperWin.style.top = (e.clientY - offset.y) + 'px';
        helperWin.style.right = 'auto';
    };
    document.onmouseup = () => { isDragging = false; };

    // --- 10. AI 调用 ---
    function getUsername() {
        const nameElem = document.querySelector('.space-y-0 .text-normal.text-base');
        return nameElem ? nameElem.innerText.trim() : 'Unknown';
    }

    async function askAI(question, type = 'TF', lang = 'C') {
        return new Promise((resolve, reject) => {
            if (!CONFIG.apiKey) {
                reject('请先在 [API设置] 中配置 API Key');
                return;
            }

            let systemPrompt = "";

            if (type === 'TF') {
                systemPrompt = "你是一个答题助手。请直接给出判断结果。\n回复格式：\n【答案】：[T/F]";
            } else if (type === 'MC') {
                systemPrompt = "你是一个答题助手。请直接给出正确选项标号字母。\n回复格式：\n【答案】：[选项字母]";
            } else if (type === 'MC_MORE') {
                systemPrompt = "你是一个答题助手。请直接给出所有正确选项标号字母。\n回复格式：\n【答案】：[所有正确选项字母连写]";
            } else if (type === 'FIB' || type === 'FIB_PROG') {
                systemPrompt = `你是一个程序设计专家。请按格式提供填空答案。
回复格式：
【最终答案】：
[空1] 第一个空的答案内容 [/空1]
[空2] 第二个空的答案内容 [/空2]
...依此类推。`;
            } else if (type === 'FUNC') {
                systemPrompt = `你是一个程序设计竞赛专家。请根据题目描述写出缺失的函数实现代码。使用 ${lang} 语言。

请在编写代码时严格遵守以下要求：
1. **深度分析题目**：仔细阅读题目描述，识别出所有的特殊条件和约束。
2. **边界与极端情况**：特别注意处理边界条件（如最大/最小值）、重复输入、正负数切换、大规模数据带来的性能问题以及空白或非法输入。
3. **输入输出规范**：严格按照题目要求的格式读取输入和产生输出，不要多输或少输任何字符。
4. **通过注释思考**：请在代码内部编写详细的注释，解释你的算法思路、关键变量的含义以及如何处理特殊边界。这不仅有助于确保逻辑正确，也能展示你的思考过程。
5. **严禁在代码外回复**：你的所有内容必须包含在代码块内，严禁在代码块外写任何文字、解释、提示或 Markdown 标记（除了包裹代码的 \`\`\`）。
6. **纯净输出**：只输出代码块，不要有任何开场白或结束语。`;
            } else if (type === 'PROG') {
                systemPrompt = `你是一个程序设计竞赛专家。请根据要求写出完整的程序代码。使用 ${lang} 语言。

请在编写代码时严格遵守以下要求：
1. **深度分析题目**：仔细阅读题目描述，识别出所有的特殊条件和约束。
2. **边界与极端情况**：特别注意处理边界条件（如最大/最小值）、重复输入、正负数切换、大规模数据带来的性能问题以及空白或非法输入。
3. **输入输出规范**：严格按照题目要求的格式读取输入和产生输出，不要多输或少输任何字符。
4. **通过注释思考**：请在代码内部编写详细的注释，解释你的算法思路、关键变量的含义以及如何处理特殊边界。这不仅有助于确保逻辑正确，也能展示你的思考过程。
5. **严禁在代码外回复**：你的所有内容必须包含在代码块内，严禁在代码块外写任何文字、解释、提示或 Markdown 标记（除了包裹代码的 \`\`\`）。
6. **纯净输出**：只输出代码块，不要有任何开场白或结束语。`;
            }

            GM_xmlhttpRequest({
                method: "POST",
                url: CONFIG.apiUrl,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${CONFIG.apiKey}`,
                    "api-key": CONFIG.apiKey
                },
                data: JSON.stringify({
                    model: CONFIG.apiModel,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: question }
                    ],
                    temperature: 0.7,
                    max_completion_tokens: 4096
                }),
                onload: function(response) {
                    try {
                        const res = JSON.parse(response.responseText);
                        if (res.error) {
                            const errMsg = res.error.message || JSON.stringify(res.error);
                            const errType = res.error.type || '';
                            let hint = '';
                            if (/Authentication|invalid api key|401/i.test(errType + errMsg)) {
                                hint = '\n\n👉 API Key 无效或失效，请到 platform.xiaomimimo.com 重新申请';
                            } else if (/insufficient|balance|402/i.test(errType + errMsg)) {
                                hint = '\n\n👉 账户余额不足，请充值后重试';
                            } else if (/model|404/i.test(errType + errMsg)) {
                                hint = '\n\n👉 Model 名称错误：建议 mimo-v2.5-pro 或 mimo-v2-flash';
                            } else if (/rate|429/i.test(errType + errMsg)) {
                                hint = '\n\n👉 请求频率过高，稍等再试';
                            }
                            reject(errMsg + hint);
                            return;
                        }
                        const fullContent = res.choices[0].message.content.trim();
                        const cleanedContent = fullContent.replace(/^```[a-z]*\n/i, '').replace(/\n```$/i, '').trim();

                        let analysis = '';
                        const analysisMatch = cleanedContent.match(/【思考】[：:\s]*([\s\S]*?)(?=【答案】|$)/i);
                        if (analysisMatch) {
                            analysis = analysisMatch[1].trim();
                        }

                        if (type === 'TF' || type === 'MC' || type === 'MC_MORE' || type === 'FIB' || type === 'FIB_PROG') {
                            if (type === 'FIB' || type === 'FIB_PROG') {
                                const sections = cleanedContent.split(/【最终答案】[：:\n\s]*/i);
                                let targetContent = sections[sections.length - 1].trim();

                                if (targetContent.length < 5 && sections.length > 1) {
                                    targetContent = sections[sections.length - 2].trim();
                                }

                                let answers = [];

                                for (let i = 1; i <= 50; i++) {
                                    const markerRegex = new RegExp(`\\[空${i}\\]([\\s\\S]*?)(?=\\[空\\d+\\]|$)`, 'gi');
                                    const matches = targetContent.match(markerRegex);

                                    if (matches) {
                                        const lastMatch = matches[matches.length - 1];
                                        const contentMatch = lastMatch.match(new RegExp(`\\[空${i}\\]([\\s\\S]*)`, 'i'));
                                        if (contentMatch) {
                                            let val = contentMatch[1].trim();
                                            val = val.replace(/\[\/空\d+\]/gi, '')
                                                     .replace(/^[:：\s|]+/, '')
                                                     .trim();
                                            answers.push(val);
                                        }
                                    } else {
                                        break;
                                    }
                                }

                                if (answers.length > 0) {
                                    resolve({ choice: 'FIB', full: cleanedContent, answers: answers, analysis: analysis });
                                    return;
                                }

                                const lines = targetContent.split('\n')
                                    .map(l => l.trim())
                                    .filter(l => l !== "" && !l.includes('【') && !l.includes('应该'));
                                resolve({ choice: 'FIB', full: cleanedContent, answers: lines, analysis: analysis });
                                return;
                            }

                            let answerText = cleanedContent;
                            const answerMatch = cleanedContent.match(/【答案】[：:\s]*([A-Z/TF]+)/i);
                            if (answerMatch) {
                                answerText = answerMatch[1].trim();
                            }

                            const firstPart = answerText.split(/[.。\n：:]/)[0].trim().toUpperCase();
                            let parsedAnswer = '';
                            if (type === 'TF') {
                                if (firstPart.startsWith('T') || firstPart.includes('正确')) parsedAnswer = 'T';
                                else if (firstPart.startsWith('F') || firstPart.includes('错误')) parsedAnswer = 'F';
                            } else if (type === 'MC') {
                                const match = firstPart.match(/[A-Z]/);
                                if (match) parsedAnswer = match[0];
                            } else if (type === 'MC_MORE') {
                                parsedAnswer = firstPart.replace(/[^A-Z]/g, '');
                            }
                            resolve({ choice: parsedAnswer || '?', full: cleanedContent, analysis: analysis });
                        } else {
                            resolve({ choice: 'CODE', full: cleanedContent, analysis: analysis });
                        }
                    } catch (e) { reject('解析失败: ' + e.message); }
                },
                onerror: function(err) { reject('API 请求网络错误，请检查 API URL 是否正确。'); }
            });
        });
    }

    // --- 11. 代码编辑器操作 ---
    async function switchLanguage(targetLang) {
        const ptaLangName = LANG_MAP[targetLang];
        if (!ptaLangName) return false;

        const currentLangElem = document.querySelector('.select__single-value .pc-text-raw');
        const currentText = currentLangElem ? currentLangElem.innerText : "";

        if (currentLangElem) {
            if (targetLang === 'Python') {
                if (currentText.includes('Python (python3)')) {
                    addInfoLog(`当前语言已是 ${currentText}，无需切换。`);
                    return true;
                }
            } else if (currentText.includes(targetLang)) {
                addInfoLog(`当前语言已是 ${currentText}，无需切换。`);
                return true;
            }
        }

        addInfoLog(`正在尝试打开菜单并切换至 ${ptaLangName}...`);

        const triggerElements = [
            document.querySelector('.select__dropdown-indicator svg'),
            document.querySelector('.select__dropdown-indicator'),
            document.querySelector('.select__control'),
            document.querySelector('input[id^="react-select-"][role="combobox"]')
        ];

        let opened = false;
        for (const el of triggerElements) {
            if (el) {
                try {
                    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    if (typeof el.click === 'function') {
                        el.click();
                    } else {
                        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    }
                    await new Promise(r => setTimeout(r, 600));
                } catch (e) {
                    console.error("触发切换失败:", e);
                }

                if (document.querySelectorAll('.select__option').length > 0) {
                    opened = true;
                    break;
                }
            }
        }

        if (!opened) {
            addInfoLog("提示：菜单可能未通过常规点击打开，尝试最后一次强行扫描...", false);
            await new Promise(r => setTimeout(r, 1000));
        }

        let options = Array.from(document.querySelectorAll('.select__option'));
        let targetOption = null;

        if (targetLang === 'Python') {
            const priorities = ['Python (python3)', 'Python (python2)', 'Python'];
            for (const p of priorities) {
                targetOption = options.find(opt => {
                    const label = opt.getAttribute('aria-label') || opt.innerText;
                    return label.includes(p);
                });
                if (targetOption) break;
            }
        } else {
            targetOption = options.find(opt => {
                const label = opt.getAttribute('aria-label') || opt.innerText;
                return label.includes(targetLang);
            });
        }

        if (targetOption) {
            const finalLangName = targetOption.innerText.trim();
            addInfoLog(`找到选项: ${finalLangName}，正在执行选择...`);
            targetOption.scrollIntoView({ block: 'nearest' });
            targetOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            targetOption.click();

            await new Promise(r => setTimeout(r, 1000));
            addInfoLog(`语言已成功切换为: ${targetLang}`);
            return true;
        } else {
            addInfoLog(`错误：无法在菜单中找到 ${targetLang} (检测到 ${options.length} 个选项)`, false);
            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            return false;
        }
    }

    async function fillCodeEditor(code) {
        unlockCopy();

        const container = document.querySelector('[data-e2e="code-editor-input"]');
        let editors = container ?
            Array.from(container.querySelectorAll('.cm-content[contenteditable="true"]')) :
            Array.from(document.querySelectorAll('.cm-content[contenteditable="true"]'));

        if (editors.length === 0) {
            const anyEditor = document.querySelector('.cm-content');
            if (anyEditor) editors = [anyEditor];
        }

        if (editors.length === 0) return false;

        const editor = editors[editors.length - 1];

        editor.focus();

        try {
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            await new Promise(r => setTimeout(r, 100));

            const dataTransfer = new DataTransfer();
            dataTransfer.setData('text/plain', code);
            const pasteEvent = new ClipboardEvent('paste', {
                clipboardData: dataTransfer,
                bubbles: true,
                cancelable: true
            });
            editor.dispatchEvent(pasteEvent);

            await new Promise(r => setTimeout(r, 200));
            if (editor.innerText.trim().length < 5) {
                document.execCommand('insertText', false, code);
            }

            if (editor.innerText.trim().length < 5) {
                editor.innerText = code;
                editor.dispatchEvent(new Event('input', { bubbles: true }));
            }

            if (editor.innerText.trim().length < 5) {
                const chars = code.split('');
                for (const char of chars) {
                    editor.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
                    document.execCommand('insertText', false, char);
                    editor.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
                }
            }

            return true;
        } catch (e) {
            console.error("代码填充失败:", e);
            return false;
        }
    }

    // --- 12. 代码注释处理函数 ---
    function removeComments(code, lang) {
        if (!code) return "";
        let result = "";
        if (lang === 'Python') {
            let lines = code.split('\n');
            let processedLines = lines.map(line => {
                let inString = false;
                let quoteChar = '';
                for (let i = 0; i < line.length; i++) {
                    if ((line[i] === '"' || line[i] === "'") && (i === 0 || line[i-1] !== '\\')) {
                        if (!inString) {
                            inString = true;
                            quoteChar = line[i];
                        } else if (line[i] === quoteChar) {
                            inString = false;
                        }
                    }
                    if (line[i] === '#' && !inString) {
                        return line.substring(0, i).trimEnd();
                    }
                }
                return line;
            });
            result = processedLines.filter(line => line.trim() !== "").join('\n').trim();
        } else {
            let cleaned = code.replace(/\/\*[\s\S]*?\*\//g, '');
            let lines = cleaned.split('\n');
            let processedLines = lines.map(line => {
                let inString = false;
                let quoteChar = '';
                for (let i = 0; i < line.length; i++) {
                    if ((line[i] === '"' || line[i] === "'") && (i === 0 || line[i-1] !== '\\')) {
                        if (!inString) {
                            inString = true;
                            quoteChar = line[i];
                        } else if (line[i] === quoteChar) {
                            inString = false;
                        }
                    }
                    if (line[i] === '/' && line[i+1] === '/' && !inString) {
                        return line.substring(0, i).trimEnd();
                    }
                }
                return line;
            });
            result = processedLines.filter(line => line.trim() !== "").join('\n').trim();
        }
        return result;
    }

    // --- 13. 核心功能：跳转与保存 ---
    async function saveAndNext() {
        const submitBtn = Array.from(document.querySelectorAll('button')).find(b =>
            b.innerText.includes('提交本题作答') ||
            b.innerText.includes('Submit For This Problem')
        );
        if (submitBtn) {
            addInfoLog("编程类题型当前页已处理。");
        } else {
            const saveBtn = document.querySelector('button[data-e2e="problem-set-bottom-submit-btn"]');
            if (saveBtn) {
                addInfoLog("正在保存答案...");
                saveBtn.click();
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        if (!CONFIG.autoNext) {
            addInfoLog("自动切换已关闭，任务结束。");
            return false;
        }

        const navIds = ['TRUE_OR_FALSE', 'MULTIPLE_CHOICE', 'MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER', 'FILL_IN_THE_BLANK', 'FILL_IN_THE_BLANKS', 'FILL_IN_THE_BLANK_FOR_PROGRAMMING', 'CODE_COMPLETION', 'PROGRAMMING', 'CODE_PROGRAMMING'];
        const activeTab = document.querySelector('a.active-anchor, a.active');
        if (activeTab) {
            const currentId = activeTab.id;
            const currentIndex = navIds.indexOf(currentId);
            if (currentIndex !== -1) {
                for (let i = currentIndex + 1; i < navIds.length; i++) {
                    const nextTab = document.getElementById(navIds[i]);
                    if (nextTab) {
                        addInfoLog(`切换题型: ${nextTab.innerText.split('\n')[0]}`);
                        nextTab.click();
                        return true;
                    }
                }
            }
        }
        addInfoLog("所有题型已完成！");
        return false;
    }

    // --- 14. 各类题型解决逻辑 ---
    // 获取用户已选答案
    function getUserAnswerTF(qBlock) {
        const labels = Array.from(qBlock.querySelectorAll('label'));
        for (const label of labels) {
            const radio = label.querySelector('input[type="radio"]');
            if (radio && radio.checked) {
                const text = label.innerText.trim().toUpperCase();
                if (text.includes('T') || text.includes('正确')) return 'T';
                if (text.includes('F') || text.includes('错误')) return 'F';
            }
        }
        return null;
    }

    function getUserAnswerMC(qBlock) {
        const labels = Array.from(qBlock.querySelectorAll('label'));
        for (const label of labels) {
            const radio = label.querySelector('input[type="radio"]');
            if (radio && radio.checked) {
                const indicator = label.querySelector('span')?.innerText.trim() || '';
                if (indicator) return indicator[0].toUpperCase();
            }
        }
        return null;
    }

    function getUserAnswerMCM(qBlock) {
        const labels = Array.from(qBlock.querySelectorAll('label'));
        let answers = [];
        for (const label of labels) {
            const checkbox = label.querySelector('input[type="checkbox"]');
            if (checkbox && checkbox.checked) {
                const indicator = label.querySelector('span')?.innerText.trim() || '';
                if (indicator) answers.push(indicator[0].toUpperCase());
            }
        }
        return answers.sort().join('');
    }

    // 判断题
    async function solveTrueFalse() {
        const questions = document.querySelectorAll('div.pc-x[id]');
        if (questions.length === 0) return;

        // 单题模式
        if (targetQuestionNum) {
            const idx = targetQuestionNum - 1;
            if (idx < 0 || idx >= questions.length) {
                addInfoLog(`题号 ${targetQuestionNum} 超出范围（共 ${questions.length} 题）`);
                return;
            }
            addModeInfoLog(`[判断题] 第 ${targetQuestionNum} 题`);
            await solveSingleTrueFalse(questions[idx], idx);
            return;
        }

        addModeInfoLog(`[判断题] 开始${currentMode === 'solve' ? '自动答题' : '检查答案'} ${questions.length} 道题目`);

        for (let i = 0; i < questions.length; i++) {
            if (!isRunning) return;
            const qBlock = questions[i];

            const qClone = qBlock.cloneNode(true);
            const optionsArea = qClone.querySelector('span.flex.flex-wrap[class*="-m-0.5"]') ||
                                qClone.querySelector('.flex.flex-wrap.mt-4') ||
                                qClone.querySelector('.flex.flex-wrap');
            if (optionsArea) optionsArea.remove();
            const headerInfo = qClone.querySelector('.flex.flex-wrap.gap-2') ||
                               qClone.querySelector('.flex.flex-wrap.gap-x-5') ||
                               qClone.querySelector('.flex.flex-wrap.gap-2.grow');
            if (headerInfo) headerInfo.remove();

            const questionText = getCleanText(qClone);
            if (!questionText) continue;

            const logItem = addLog(`${i + 1}. ${questionText}`, i);

            try {
                if (!isRunning) return;
                const result = await askAI(questionText, 'TF');
                if (!isRunning) return;

                const aiAnswer = result.choice;

                if (currentMode === 'check') {
                    const userAnswer = getUserAnswerTF(qBlock);
                    if (userAnswer === null) {
                        // 未作答，跳过该题，移除日志
                        logItem.remove();
                        continue;
                    } else {
                        const isCorrect = userAnswer === aiAnswer;
                        updateLogCheck(logItem, userAnswer, aiAnswer, result.analysis, isCorrect, i + 1);
                    }
                } else {
                    const labels = Array.from(qBlock.querySelectorAll('label'));
                    let targetLabel = null;
                    for (const label of labels) {
                        const labelText = label.innerText.trim().toUpperCase();
                        if (labelText === aiAnswer ||
                           (aiAnswer === 'T' && (labelText.includes('T') || labelText.includes('正确'))) ||
                           (aiAnswer === 'F' && (labelText.includes('F') || labelText.includes('错误')))) {
                            targetLabel = label;
                            break;
                        }
                    }

                    if (targetLabel) {
                        const input = targetLabel.querySelector('input');
                        if (input) input.focus();
                        targetLabel.click();
                        updateLogSolve(logItem, aiAnswer === 'T' ? '正确 (T)' : '错误 (F)', result.analysis);
                    } else {
                        updateLogSolve(logItem, `未找到选项: ${aiAnswer}`, result.analysis, false);
                    }
                }
            } catch (err) {
                updateLogSolve(logItem, `请求失败: ${err}`, '', false);
            }
            await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
        }
    }

    // 单题判断题
    async function solveSingleTrueFalse(qBlock, index) {
        const qClone = qBlock.cloneNode(true);
        const optionsArea = qClone.querySelector('span.flex.flex-wrap[class*="-m-0.5"]') ||
                            qClone.querySelector('.flex.flex-wrap.mt-4') ||
                            qClone.querySelector('.flex.flex-wrap');
        if (optionsArea) optionsArea.remove();
        const headerInfo = qClone.querySelector('.flex.flex-wrap.gap-2') ||
                           qClone.querySelector('.flex.flex-wrap.gap-x-5') ||
                           qClone.querySelector('.flex.flex-wrap.gap-2.grow');
        if (headerInfo) headerInfo.remove();

        const questionText = getCleanText(qClone);
        if (!questionText) return;

        const logItem = addLog(`${index + 1}. ${questionText}`, index);

        try {
            if (!isRunning) return;
            const result = await askAI(questionText, 'TF');
            if (!isRunning) return;

            const aiAnswer = result.choice;

            if (currentMode === 'check') {
                // 检查模式
                const userAnswer = getUserAnswerTF(qBlock);
                if (userAnswer === null) {
                    addInfoLog(`第 ${index + 1} 题未作答`);
                    logItem.remove();
                    return;
                }
                const isCorrect = userAnswer === aiAnswer;
                updateLogCheck(logItem, userAnswer, aiAnswer, result.analysis, isCorrect, index + 1);
            } else {
                // 自动答题模式
                const labels = Array.from(qBlock.querySelectorAll('label'));
                let targetLabel = null;
                for (const label of labels) {
                    const labelText = label.innerText.trim().toUpperCase();
                    if (labelText === aiAnswer ||
                       (aiAnswer === 'T' && (labelText.includes('T') || labelText.includes('正确'))) ||
                       (aiAnswer === 'F' && (labelText.includes('F') || labelText.includes('错误')))) {
                        targetLabel = label;
                        break;
                    }
                }

                if (targetLabel) {
                    const input = targetLabel.querySelector('input');
                    if (input) input.focus();
                    targetLabel.click();
                    updateLogSolve(logItem, aiAnswer === 'T' ? '正确 (T)' : '错误 (F)', result.analysis);
                } else {
                    updateLogSolve(logItem, `未找到选项: ${aiAnswer}`, result.analysis, false);
                }
            }
        } catch (err) {
            updateLogSolve(logItem, `请求失败: ${err}`, '', false);
        }
    }

    // 通用文本清洗函数
    function getCleanText(element) {
        if (!element) return "";
        const clone = element.nodeType ? element.cloneNode(true) : element;

        TRASH_SELECTORS.forEach(s => {
            clone.querySelectorAll(s).forEach(el => el.remove());
        });

        clone.querySelectorAll('img').forEach(img => {
            if (img.alt) {
                const span = document.createElement('span');
                span.innerText = ` [图片: ${img.alt}] `;
                img.parentNode.replaceChild(span, img);
            }
        });

        const processedBlocks = new Set();
        clone.querySelectorAll('[data-code], .codeEditor_CHvdZ, .cm-editor').forEach(codeBlock => {
            if (processedBlocks.has(codeBlock)) return;

            const cmContent = codeBlock.querySelector('.cm-content');
            if (cmContent) {
                let lines = Array.from(cmContent.querySelectorAll('.cm-line'))
                                   .map(line => line.innerText)
                                   .join('\n');

                if (!lines) {
                    lines = cmContent.innerText;
                }

                const lang = codeBlock.getAttribute('data-lang') || "";
                const pre = document.createElement('pre');
                pre.innerText = `\n\`\`\`${lang}\n${lines}\n\`\`\`\n`;

                codeBlock.querySelectorAll('*').forEach(child => processedBlocks.add(child));
                codeBlock.parentNode.replaceChild(pre, codeBlock);
                processedBlocks.add(codeBlock);
            }
        });

        clone.querySelectorAll('table').forEach(table => {
            let tableText = "\n[表格内容]\n";
            table.querySelectorAll('tr').forEach(tr => {
                const row = Array.from(tr.querySelectorAll('td, th'))
                                .map(cell => cell.innerText.trim())
                                .join(' | ');
                tableText += "| " + row + " |\n";
            });
            const pre = document.createElement('pre');
            pre.innerText = tableText + "[表格结束]\n";
            table.parentNode.replaceChild(pre, table);
        });

        clone.querySelectorAll('.katex-html').forEach(el => el.remove());

        return clone.innerText
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // 单选题
    async function solveMultipleChoice() {
        const questions = document.querySelectorAll('div.pc-x[id]');
        if (questions.length === 0) return;

        // 单题模式
        if (targetQuestionNum) {
            const idx = targetQuestionNum - 1;
            if (idx < 0 || idx >= questions.length) {
                addInfoLog(`题号 ${targetQuestionNum} 超出范围（共 ${questions.length} 题）`);
                return;
            }
            addModeInfoLog(`[单选题] 第 ${targetQuestionNum} 题`);
            await solveSingleMultipleChoice(questions[idx], idx);
            return;
        }

        addModeInfoLog(`[单选题] 开始${currentMode === 'solve' ? '自动答题' : '检查答案'} ${questions.length} 道题目`);

        for (let i = 0; i < questions.length; i++) {
            if (!isRunning) return;
            const qBlock = questions[i];

            const qClone = qBlock.cloneNode(true);
            const optionsArea = qClone.querySelector('span.flex.flex-wrap[class*="-m-0.5"]') ||
                                qClone.querySelector('.flex.flex-wrap.mt-4') ||
                                qClone.querySelector('.flex.flex-wrap');
            if (optionsArea) optionsArea.remove();
            const headerInfo = qClone.querySelector('.flex.flex-wrap.gap-2') ||
                               qClone.querySelector('.flex.flex-wrap.gap-x-5');
            if (headerInfo) headerInfo.remove();

            const questionText = getCleanText(qClone);
            if (!questionText) continue;

            const labels = Array.from(qBlock.querySelectorAll('label'));
            let optionsPrompt = "\n选项：\n";
            labels.forEach(label => {
                const indicator = label.querySelector('span')?.innerText.trim() || "";
                const optionClone = label.cloneNode(true);
                const span = optionClone.querySelector('span');
                if (span) span.remove();
                const contentText = getCleanText(optionClone);
                optionsPrompt += `${indicator} ${contentText}\n`;
            });

            const logItem = addLog(`${i + 1}. ${questionText}`, i);
            try {
                if (!isRunning) return;
                const result = await askAI(questionText + optionsPrompt, 'MC');
                if (!isRunning) return;

                const aiAnswer = result.choice;

                if (currentMode === 'check') {
                    const userAnswer = getUserAnswerMC(qBlock);
                    if (userAnswer === null) {
                        // 未作答，跳过该题，移除日志
                        logItem.remove();
                        continue;
                    } else {
                        const isCorrect = userAnswer === aiAnswer;
                        updateLogCheck(logItem, userAnswer, aiAnswer, result.analysis, isCorrect, i + 1);
                    }
                } else {
                    let targetLabel = null;
                    for (const label of labels) {
                        const indicator = label.querySelector('span')?.innerText.trim() || label.innerText.trim();
                        if (indicator.startsWith(aiAnswer)) {
                            targetLabel = label;
                            break;
                        }
                    }

                    if (targetLabel) {
                        targetLabel.click();
                        updateLogSolve(logItem, `选项 ${aiAnswer}`, result.analysis);
                    } else {
                        updateLogSolve(logItem, `未找到选项: ${aiAnswer}`, result.analysis, false);
                    }
                }
            } catch (err) { updateLogSolve(logItem, `错误: ${err}`, '', false); }
            await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
        }
    }

    // 单题单选题
    async function solveSingleMultipleChoice(qBlock, index) {
        const qClone = qBlock.cloneNode(true);
        const optionsArea = qClone.querySelector('span.flex.flex-wrap[class*="-m-0.5"]') ||
                            qClone.querySelector('.flex.flex-wrap.mt-4') ||
                            qClone.querySelector('.flex.flex-wrap');
        if (optionsArea) optionsArea.remove();
        const headerInfo = qClone.querySelector('.flex.flex-wrap.gap-2') ||
                           qClone.querySelector('.flex.flex-wrap.gap-x-5');
        if (headerInfo) headerInfo.remove();

        const questionText = getCleanText(qClone);
        if (!questionText) return;

        const labels = Array.from(qBlock.querySelectorAll('label'));
        let optionsPrompt = "\n选项：\n";
        labels.forEach(label => {
            const indicator = label.querySelector('span')?.innerText.trim() || "";
            const optionClone = label.cloneNode(true);
            const span = optionClone.querySelector('span');
            if (span) span.remove();
            const contentText = getCleanText(optionClone);
            optionsPrompt += `${indicator} ${contentText}\n`;
        });

        const logItem = addLog(`${index + 1}. ${questionText}`, index);
        try {
            if (!isRunning) return;
            const result = await askAI(questionText + optionsPrompt, 'MC');
            if (!isRunning) return;

            const aiAnswer = result.choice;

            if (currentMode === 'check') {
                // 检查模式
                const userAnswer = getUserAnswerMC(qBlock);
                if (userAnswer === null) {
                    addInfoLog(`第 ${index + 1} 题未作答`);
                    logItem.remove();
                    return;
                }
                const isCorrect = userAnswer === aiAnswer;
                updateLogCheck(logItem, userAnswer, aiAnswer, result.analysis, isCorrect, index + 1);
            } else {
                // 自动答题模式
                let targetLabel = null;
                for (const label of labels) {
                    const indicator = label.querySelector('span')?.innerText.trim() || label.innerText.trim();
                    if (indicator.startsWith(aiAnswer)) {
                        targetLabel = label;
                        break;
                    }
                }

                if (targetLabel) {
                    targetLabel.click();
                    updateLogSolve(logItem, `选项 ${aiAnswer}`, result.analysis);
                } else {
                    updateLogSolve(logItem, `未找到选项: ${aiAnswer}`, result.analysis, false);
                }
            }
        } catch (err) { updateLogSolve(logItem, `错误: ${err}`, '', false); }
    }

    // 多选题
    async function solveMultipleChoiceMore() {
        const questions = document.querySelectorAll('div.pc-x[id]');
        if (questions.length === 0) return;

        // 单题模式
        if (targetQuestionNum) {
            const idx = targetQuestionNum - 1;
            if (idx < 0 || idx >= questions.length) {
                addInfoLog(`题号 ${targetQuestionNum} 超出范围（共 ${questions.length} 题）`);
                return;
            }
            addModeInfoLog(`[多选题] 第 ${targetQuestionNum} 题`);
            await solveSingleMultipleChoiceMore(questions[idx], idx);
            return;
        }

        addModeInfoLog(`[多选题] 开始${currentMode === 'solve' ? '自动答题' : '检查答案'} ${questions.length} 道题目`);

        for (let i = 0; i < questions.length; i++) {
            if (!isRunning) return;
            const qBlock = questions[i];

            const qClone = qBlock.cloneNode(true);
            const optionsArea = qClone.querySelector('span.flex.flex-wrap[class*="-m-0.5"]') ||
                                qClone.querySelector('.flex.flex-wrap.mt-4') ||
                                qClone.querySelector('.flex.flex-wrap');
            if (optionsArea) optionsArea.remove();
            const headerInfo = qClone.querySelector('.flex.flex-wrap.gap-2') ||
                               qClone.querySelector('.flex.flex-wrap.gap-x-5');
            if (headerInfo) headerInfo.remove();

            const questionText = getCleanText(qClone);
            if (!questionText) continue;

            const labels = Array.from(qBlock.querySelectorAll('label'));
            let optionsPrompt = "\n(多选题) 选项：\n";
            labels.forEach(label => {
                const indicator = label.querySelector('span')?.innerText.trim() || "";
                const optionClone = label.cloneNode(true);
                const span = optionClone.querySelector('span');
                if (span) span.remove();
                const contentText = getCleanText(optionClone);
                optionsPrompt += `${indicator} ${contentText}\n`;
            });

            const logItem = addLog(`${i + 1}. ${questionText}`, i);
            try {
                if (!isRunning) return;
                const result = await askAI(questionText + optionsPrompt, 'MC_MORE');
                if (!isRunning) return;

                const aiAnswer = result.choice;

                if (currentMode === 'check') {
                    const userAnswer = getUserAnswerMCM(qBlock);
                    if (!userAnswer) {
                        // 未作答，跳过该题，移除日志
                        logItem.remove();
                        continue;
                    } else {
                        const isCorrect = userAnswer === aiAnswer;
                        updateLogCheck(logItem, userAnswer, aiAnswer, result.analysis, isCorrect, i + 1);
                    }
                } else {
                    for (const label of labels) {
                        const indicator = label.querySelector('span')?.innerText.trim() || label.innerText.trim();
                        const firstChar = indicator[0].toUpperCase();

                        const checkbox = label.querySelector('input[type="checkbox"]');
                        if (aiAnswer.includes(firstChar)) {
                            if (checkbox && !checkbox.checked) label.click();
                        } else {
                            if (checkbox && checkbox.checked) label.click();
                        }
                    }
                    updateLogSolve(logItem, `选项 ${aiAnswer}`, result.analysis);
                }
            } catch (err) { updateLogSolve(logItem, `错误: ${err}`, '', false); }
            await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
        }
    }

    // 单题多选题
    async function solveSingleMultipleChoiceMore(qBlock, index) {
        const qClone = qBlock.cloneNode(true);
        const optionsArea = qClone.querySelector('span.flex.flex-wrap[class*="-m-0.5"]') ||
                            qClone.querySelector('.flex.flex-wrap.mt-4') ||
                            qClone.querySelector('.flex.flex-wrap');
        if (optionsArea) optionsArea.remove();
        const headerInfo = qClone.querySelector('.flex.flex-wrap.gap-2') ||
                           qClone.querySelector('.flex.flex-wrap.gap-x-5');
        if (headerInfo) headerInfo.remove();

        const questionText = getCleanText(qClone);
        if (!questionText) return;

        const labels = Array.from(qBlock.querySelectorAll('label'));
        let optionsPrompt = "\n(多选题) 选项：\n";
        labels.forEach(label => {
            const indicator = label.querySelector('span')?.innerText.trim() || "";
            const optionClone = label.cloneNode(true);
            const span = optionClone.querySelector('span');
            if (span) span.remove();
            const contentText = getCleanText(optionClone);
            optionsPrompt += `${indicator} ${contentText}\n`;
        });

        const logItem = addLog(`${index + 1}. ${questionText}`, index);
        try {
            if (!isRunning) return;
            const result = await askAI(questionText + optionsPrompt, 'MC_MORE');
            if (!isRunning) return;

            const aiAnswer = result.choice;

            if (currentMode === 'check') {
                // 检查模式
                const userAnswer = getUserAnswerMCM(qBlock);
                if (!userAnswer) {
                    addInfoLog(`第 ${index + 1} 题未作答`);
                    logItem.remove();
                    return;
                }
                const isCorrect = userAnswer === aiAnswer;
                updateLogCheck(logItem, userAnswer, aiAnswer, result.analysis, isCorrect, index + 1);
            } else {
                // 自动答题模式
                for (const label of labels) {
                    const indicator = label.querySelector('span')?.innerText.trim() || label.innerText.trim();
                    const firstChar = indicator[0].toUpperCase();

                    const checkbox = label.querySelector('input[type="checkbox"]');
                    if (aiAnswer.includes(firstChar)) {
                        if (checkbox && !checkbox.checked) label.click();
                    } else {
                        if (checkbox && checkbox.checked) label.click();
                    }
                }
                updateLogSolve(logItem, `选项 ${aiAnswer}`, result.analysis);
            }
        } catch (err) { updateLogSolve(logItem, `错误: ${err}`, '', false); }
    }

    // 填空题
    async function solveFillInTheBlank(typeName = '填空题') {
        const questions = document.querySelectorAll('div.pc-x[id]');
        if (questions.length === 0) return;

        // 单题模式
        if (targetQuestionNum) {
            const idx = targetQuestionNum - 1;
            if (idx < 0 || idx >= questions.length) {
                addInfoLog(`题号 ${targetQuestionNum} 超出范围（共 ${questions.length} 题）`);
                return;
            }
            addModeInfoLog(`[${typeName}] 第 ${targetQuestionNum} 题`);
            await solveSingleFillInTheBlank(questions[idx], idx, typeName);
            return;
        }

        addModeInfoLog(`[${typeName}] 开始${currentMode === 'solve' ? '自动答题' : '检查答案'} ${questions.length} 道题目`);

        for (let i = 0; i < questions.length; i++) {
            if (!isRunning) return;
            const qBlock = questions[i];

            const textElement = qBlock.querySelector('.rendered-markdown') || qBlock.querySelector('.generalProblemBody_WIhdN') || qBlock;
            if (!textElement) continue;

            const clone = textElement.cloneNode(true);

            const findBlanksInternal = (root) => {
                const blanks = [];
                root.querySelectorAll('[data-blank-index]').forEach(el => blanks.push(el));
                root.querySelectorAll('.cm-content span[contenteditable="false"]').forEach(el => {
                    if (el.querySelector('input, textarea') && !blanks.includes(el)) blanks.push(el);
                });
                root.querySelectorAll('input, textarea').forEach(input => {
                    let p = input.parentElement;
                    while (p && p !== root) {
                        if (blanks.includes(p)) return;
                        if (p.classList.contains('inline-flex') || p.tagName === 'SPAN' || p.classList.contains('cm-widgetBuffer')) {
                            blanks.push(p);
                            return;
                        }
                        p = p.parentElement;
                    }
                    if (!blanks.some(b => b.contains(input))) blanks.push(input);
                });
                return blanks;
            };

            const blanksInClone = findBlanksInternal(clone);
            blanksInClone.forEach((b, idx) => {
                const marker = document.createTextNode(` [空${idx + 1}] `);
                if (b.parentNode) {
                    b.parentNode.replaceChild(marker, b);
                }
            });

            TRASH_SELECTORS.forEach(s => {
                clone.querySelectorAll(s).forEach(el => el.remove());
            });

            clone.querySelectorAll('[data-code]').forEach(codeBlock => {
                const cmContent = codeBlock.querySelector('.cm-content');
                if (cmContent) {
                    let content = Array.from(cmContent.querySelectorAll('.cm-line'))
                                       .map(line => line.innerText)
                                       .join('\n');
                    if (!content) content = cmContent.innerText;

                    const lang = codeBlock.getAttribute('data-lang') || '';
                    const pre = document.createElement('pre');
                    pre.innerText = `\n\`\`\`${lang}\n${content}\n\`\`\`\n`;
                    codeBlock.parentNode.replaceChild(pre, codeBlock);
                }
            });

            const questionText = clone.innerText.trim();
            const realBlanks = findBlanksInternal(qBlock);
            if (realBlanks.length === 0) continue;

            const logItem = addLog(`${i + 1}. ${questionText}`, i);
            try {
                if (!isRunning) return;
                const isProg = typeName.includes('程序');
                const aiType = isProg ? 'FIB_PROG' : 'FIB';

                addInfoLog(`[${typeName}] 共有 ${realBlanks.length} 个空，正在请求 AI (${aiType})...`);
                const result = await askAI(questionText + `\n\n(提示：请给出以上题目中 ${realBlanks.length} 个空的答案，按顺序排列，每空请使用 [空n]内容 [/空n] 的格式回复)`, aiType);
                if (!isRunning) return;

                const aiAnswers = result.answers || [];

                if (currentMode === 'check') {
                    // 检查模式：读取用户答案并与AI答案比较
                    let userAnswers = [];
                    let hasAnyAnswer = false;
                    for (let j = 0; j < realBlanks.length; j++) {
                        const blankParent = realBlanks[j];
                        const el = blankParent.tagName === 'INPUT' || blankParent.tagName === 'TEXTAREA' ?
                                   blankParent : blankParent.querySelector('input, textarea');
                        if (el) {
                            const val = el.value.trim();
                            userAnswers.push(val || '未作答');
                            if (val) hasAnyAnswer = true;
                        } else {
                            userAnswers.push('未作答');
                        }
                    }

                    // 如果所有空都未作答，跳过该题
                    if (!hasAnyAnswer) {
                        logItem.remove();
                        continue;
                    }

                    let allCorrect = true;
                    let wrongBlanks = [];
                    for (let j = 0; j < realBlanks.length; j++) {
                        if (userAnswers[j] !== aiAnswers[j]) {
                            allCorrect = false;
                            wrongBlanks.push(j + 1);
                        }
                    }

                    const statusDiv = logItem.querySelector('.log-status');
                    if (statusDiv) {
                        statusDiv.className = allCorrect ? 'log-a' : 'log-err';
                        statusDiv.innerText = allCorrect ? '✓ 全部正确' : `✗ 第 ${wrongBlanks.join(',')} 空错误`;
                    }

                    if (!allCorrect) {
                        const userAnswerDiv = document.createElement('div');
                        userAnswerDiv.className = 'log-user-answer';
                        userAnswerDiv.innerText = `你的答案: ${userAnswers.join(' | ')}`;
                        logItem.appendChild(userAnswerDiv);

                        const correctAnswerDiv = document.createElement('div');
                        correctAnswerDiv.className = 'log-correct-answer';
                        correctAnswerDiv.innerText = `正确答案: ${aiAnswers.join(' | ')}`;
                        logItem.appendChild(correctAnswerDiv);

                        // 记录错误题目
                        wrongQuestions.push({
                            num: i + 1,
                            userAnswer: userAnswers.join(' | '),
                            correctAnswer: aiAnswers.join(' | ')
                        });
                    }

                    logItem.classList.add(allCorrect ? 'correct' : 'wrong');
                } else {
                    // 自动答题模式：填入答案
                    for (let j = 0; j < realBlanks.length; j++) {
                        if (aiAnswers[j]) {
                            const blankParent = realBlanks[j];
                            const el = blankParent.tagName === 'INPUT' || blankParent.tagName === 'TEXTAREA' ?
                                       blankParent : blankParent.querySelector('input, textarea');
                            if (el) {
                                const value = aiAnswers[j];
                                const lastValue = el.value;
                                el.value = value;
                                const tracker = el._valueTracker;
                                if (tracker) tracker.setValue(lastValue);
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        }
                    }
                    updateLogSolve(logItem, aiAnswers.join(' | '), result.analysis);
                }
            } catch (err) { updateLogSolve(logItem, `错误: ${err}`, '', false); }
            await new Promise(r => setTimeout(r, 800));
        }
    }

    // 单题填空题
    async function solveSingleFillInTheBlank(qBlock, index, typeName = '填空题') {
        const textElement = qBlock.querySelector('.rendered-markdown') || qBlock.querySelector('.generalProblemBody_WIhdN') || qBlock;
        if (!textElement) return;

        const clone = textElement.cloneNode(true);

        const findBlanksInternal = (root) => {
            const blanks = [];
            root.querySelectorAll('[data-blank-index]').forEach(el => blanks.push(el));
            root.querySelectorAll('.cm-content span[contenteditable="false"]').forEach(el => {
                if (el.querySelector('input, textarea') && !blanks.includes(el)) blanks.push(el);
            });
            root.querySelectorAll('input, textarea').forEach(input => {
                let p = input.parentElement;
                while (p && p !== root) {
                    if (blanks.includes(p)) return;
                    if (p.classList.contains('inline-flex') || p.tagName === 'SPAN' || p.classList.contains('cm-widgetBuffer')) {
                        blanks.push(p);
                        return;
                    }
                    p = p.parentElement;
                }
                if (!blanks.some(b => b.contains(input))) blanks.push(input);
            });
            return blanks;
        };

        const blanksInClone = findBlanksInternal(clone);
        blanksInClone.forEach((b, idx) => {
            const marker = document.createTextNode(` [空${idx + 1}] `);
            if (b.parentNode) {
                b.parentNode.replaceChild(marker, b);
            }
        });

        TRASH_SELECTORS.forEach(s => {
            clone.querySelectorAll(s).forEach(el => el.remove());
        });

        clone.querySelectorAll('[data-code]').forEach(codeBlock => {
            const cmContent = codeBlock.querySelector('.cm-content');
            if (cmContent) {
                let content = Array.from(cmContent.querySelectorAll('.cm-line'))
                                   .map(line => line.innerText)
                                   .join('\n');
                if (!content) content = cmContent.innerText;

                const lang = codeBlock.getAttribute('data-lang') || '';
                const pre = document.createElement('pre');
                pre.innerText = `\n\`\`\`${lang}\n${content}\n\`\`\`\n`;
                codeBlock.parentNode.replaceChild(pre, codeBlock);
            }
        });

        const questionText = clone.innerText.trim();
        const realBlanks = findBlanksInternal(qBlock);
        if (realBlanks.length === 0) return;

        const logItem = addLog(`${index + 1}. ${questionText}`, index);
        try {
            if (!isRunning) return;
            const isProg = typeName.includes('程序');
            const aiType = isProg ? 'FIB_PROG' : 'FIB';

            addInfoLog(`[${typeName}] 共有 ${realBlanks.length} 个空，正在请求 AI (${aiType})...`);
            const result = await askAI(questionText + `\n\n(提示：请给出以上题目中 ${realBlanks.length} 个空的答案，按顺序排列，每空请使用 [空n]内容 [/空n] 的格式回复)`, aiType);
            if (!isRunning) return;

            const aiAnswers = result.answers || [];

            if (currentMode === 'check') {
                // 检查模式
                let userAnswers = [];
                let hasAnyAnswer = false;
                for (let j = 0; j < realBlanks.length; j++) {
                    const blankParent = realBlanks[j];
                    const el = blankParent.tagName === 'INPUT' || blankParent.tagName === 'TEXTAREA' ?
                               blankParent : blankParent.querySelector('input, textarea');
                    if (el) {
                        const val = el.value.trim();
                        userAnswers.push(val || '未作答');
                        if (val) hasAnyAnswer = true;
                    } else {
                        userAnswers.push('未作答');
                    }
                }

                if (!hasAnyAnswer) {
                    addInfoLog(`第 ${index + 1} 题未作答`);
                    logItem.remove();
                    return;
                }

                let allCorrect = true;
                let wrongBlanks = [];
                for (let j = 0; j < realBlanks.length; j++) {
                    if (userAnswers[j] !== aiAnswers[j]) {
                        allCorrect = false;
                        wrongBlanks.push(j + 1);
                    }
                }

                const statusDiv = logItem.querySelector('.log-status');
                if (statusDiv) {
                    statusDiv.className = allCorrect ? 'log-a' : 'log-err';
                    statusDiv.innerText = allCorrect ? '✓ 全部正确' : `✗ 第 ${wrongBlanks.join(',')} 空错误`;
                }

                if (!allCorrect) {
                    const userAnswerDiv = document.createElement('div');
                    userAnswerDiv.className = 'log-user-answer';
                    userAnswerDiv.innerText = `你的答案: ${userAnswers.join(' | ')}`;
                    logItem.appendChild(userAnswerDiv);

                    const correctAnswerDiv = document.createElement('div');
                    correctAnswerDiv.className = 'log-correct-answer';
                    correctAnswerDiv.innerText = `正确答案: ${aiAnswers.join(' | ')}`;
                    logItem.appendChild(correctAnswerDiv);

                    // 记录错误题目
                    wrongQuestions.push({
                        num: index + 1,
                        userAnswer: userAnswers.join(' | '),
                        correctAnswer: aiAnswers.join(' | ')
                    });

                    // 显示解析
                    if (result.analysis && CONFIG.showAnalysis) {
                        const analysisDiv = document.createElement('div');
                        analysisDiv.className = 'log-analysis show';
                        analysisDiv.innerHTML = `<strong>解析：</strong><br>${result.analysis}`;
                        logItem.appendChild(analysisDiv);

                        const toggleBtn = document.createElement('div');
                        toggleBtn.className = 'analysis-toggle';
                        toggleBtn.innerText = '收起解析';
                        toggleBtn.onclick = function() {
                            if (analysisDiv.classList.contains('show')) {
                                analysisDiv.classList.remove('show');
                                toggleBtn.innerText = '展开解析';
                            } else {
                                analysisDiv.classList.add('show');
                                toggleBtn.innerText = '收起解析';
                            }
                        };
                        logItem.appendChild(toggleBtn);
                    }
                }

                logItem.classList.add(allCorrect ? 'correct' : 'wrong');
            } else {
                // 自动答题模式：填入答案
                for (let j = 0; j < realBlanks.length; j++) {
                    if (aiAnswers[j]) {
                        const blankParent = realBlanks[j];
                        const el = blankParent.tagName === 'INPUT' || blankParent.tagName === 'TEXTAREA' ?
                                   blankParent : blankParent.querySelector('input, textarea');
                        if (el) {
                            const value = aiAnswers[j];
                            const lastValue = el.value;
                            el.value = value;
                            const tracker = el._valueTracker;
                            if (tracker) tracker.setValue(lastValue);
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                }
                updateLogSolve(logItem, aiAnswers.join(' | '), result.analysis);
            }
        } catch (err) { updateLogSolve(logItem, `错误: ${err}`, '', false); }
    }

    // 编程题
    async function solveCodeProblems(type) {
        const problemBtns = document.querySelectorAll('a[href*="problemSetProblemId"]');
        if (problemBtns.length === 0) { addInfoLog("未找到题目按钮"); return; }

        const targetLang = type === 'FUNC' ? CONFIG.funcLang : CONFIG.progLang;
        addModeInfoLog(`[${type === 'FUNC' ? '函数题' : '编程题'}] 共有 ${problemBtns.length} 题，预设语言: ${targetLang}`);

        for (let i = 0; i < problemBtns.length; i++) {
            if (!isRunning) return;

            const btn = problemBtns[i];
            if (btn.querySelector('.PROBLEM_ACCEPTED_iri62')) {
                addInfoLog(`第 ${i + 1} 题已通过，跳过`); continue;
            }
            addInfoLog(`正在解决第 ${i + 1} 题...`);
            btn.click();
            await new Promise(r => setTimeout(r, 2500));

            if (!isRunning) return;

            await switchLanguage(targetLang);

            let editorExists = false;
            for (let j = 0; j < 10; j++) {
                if (document.querySelector('.cm-content')) {
                    editorExists = true;
                    break;
                }
                addInfoLog(`等待编辑器加载中 (${j + 1}/10)...`);
                await new Promise(r => setTimeout(r, 1000));
            }

            if (!editorExists) {
                addInfoLog(`[跳过] 无法加载编辑器，跳过此题。`, false);
                continue;
            }

            const contentArea = document.querySelector('.rendered-markdown') ||
                                document.querySelector('.generalProblemBody_WIhdN') ||
                                document.querySelector('.problem-body') ||
                                document.querySelector('.problemBody_S_NqD');

            const infoList = document.querySelector('.problemInfo_HVczC');
            const infoText = infoList ? infoList.innerText.replace(/\n+/g, ' ').trim() : '';

            const title = document.querySelector('.text-darkest.font-bold.text-lg')?.innerText ||
                          document.querySelector('.problem-title')?.innerText ||
                          `第 ${i+1} 题`;
            const logItem = addLog(title);

            try {
                if (!isRunning) return;
                addInfoLog(`正在请求 AI 生成代码 (${targetLang})...`);

                const mainContent = getCleanText(contentArea || document.body);
                const fullPrompt = `【题目标题】：${title}\n【限制信息】：${infoText}\n【题目正文】：\n${mainContent}`;

                const result = await askAI(fullPrompt, type, targetLang);

                if (!isRunning) return;

                if (currentMode === 'check') {
                    // 编程题检查模式提示
                    addInfoLog(`[编程题] 检查模式暂不支持编程题自动检查，请手动验证代码。`);
                    updateLogSolve(logItem, '请手动检查代码', result.analysis, true);
                } else {
                    // 自动答题模式
                    addInfoLog(`AI 生成完毕，正在填入编辑器...`);

                    let codeToFill = result.full;
                    if (CONFIG.removeComments) {
                        addInfoLog(`[优化] 正在本地清除代码注释以符合提交要求...`);
                        codeToFill = removeComments(result.full, targetLang);
                    }

                    const filled = await fillCodeEditor(codeToFill);

                    if (filled) {
                        await new Promise(r => setTimeout(r, 800));

                        if (!isRunning) return;

                        const submitBtn = Array.from(document.querySelectorAll('button')).find(b =>
                            b.innerText.includes('提交本题作答') || b.querySelector('.pc-text-raw')?.innerText === '提交本题作答'
                        );

                        if (submitBtn) {
                            addInfoLog(`[操作] 点击提交按钮...`);
                            submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            submitBtn.click();

                            addInfoLog(`[等待] 等待提交结果返回...`);
                            let foundResult = false;
                            for (let attempt = 0; attempt < 15; attempt++) {
                                if (!isRunning) break;
                                const closeBtn = document.querySelector('button[data-e2e="modal-close-btn"]');
                                if (closeBtn) {
                                    addInfoLog(`[成功] 检测到提交结果窗口，准备关闭...`);
                                    closeBtn.click();
                                    foundResult = true;
                                    break;
                                }
                                await new Promise(r => setTimeout(r, 1000));
                            }

                            if (!foundResult && isRunning) {
                                addInfoLog(`[警告] 提交后未检测到结果反馈，请检查。`, false);
                            }

                            updateLogSolve(logItem, `已提交 (${targetLang})`, result.analysis, true);
                        } else {
                            addInfoLog(`[错误] 未能定位到提交按钮！`, false);
                            updateLogSolve(logItem, "未找到提交按钮", '', false);
                        }
                    } else {
                        addInfoLog(`[错误] 无法填入代码。`, false);
                        updateLogSolve(logItem, "编辑器定位失败", '', false);
                    }
                }
            } catch (err) {
                addInfoLog(`[异常] ${err}`);
                updateLogSolve(logItem, `错误: ${err}`, '', false);
            }
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    // --- 15. 主逻辑入口 ---
    async function solveCurrentPage() {
        if (isRunning) return;

        // 读取目标题号
        const singleInput = document.getElementById('single-question-input');
        const inputValue = singleInput ? singleInput.value.trim() : '';
        targetQuestionNum = inputValue ? parseInt(inputValue) : null;

        isRunning = true;
        startBtn.disabled = true;
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';

        unlockCopy();

        if (currentMode === 'solve') {
            if (targetQuestionNum) {
                addModeInfoLog(`已启动自动答题模式 - 第 ${targetQuestionNum} 题`);
            } else {
                addModeInfoLog(`已启动自动答题模式 - 全部题目`);
            }
        } else {
            addModeInfoLog(`已启动检查答案模式`);
        }

        while (isRunning) {
            const tfTab = document.getElementById('TRUE_OR_FALSE');
            const mcTab = document.getElementById('MULTIPLE_CHOICE');
            const mcmTab = document.getElementById('MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER');
            const fibTab = document.getElementById('FILL_IN_THE_BLANK') || document.getElementById('FILL_IN_THE_BLANKS');
            const fibpTab = document.getElementById('FILL_IN_THE_BLANK_FOR_PROGRAMMING');
            const funcTab = document.getElementById('CODE_COMPLETION');
            const progTab = document.getElementById('PROGRAMMING') || document.getElementById('CODE_PROGRAMMING');

            const activeTab = document.querySelector('a.active-anchor, a.active');
            const activeTabText = activeTab ? activeTab.innerText.trim() : "";

            try {
                if (tfTab && tfTab.classList.contains('active')) {
                    await solveTrueFalse();
                } else if (mcTab && mcTab.classList.contains('active')) {
                    await solveMultipleChoice();
                } else if (mcmTab && mcmTab.classList.contains('active')) {
                    await solveMultipleChoiceMore();
                } else if ((fibTab && fibTab.classList.contains('active')) || (activeTabText.includes('填空题') && !activeTabText.includes('程序'))) {
                    await solveFillInTheBlank('普通填空题');
                } else if ((fibpTab && fibpTab.classList.contains('active')) || activeTabText.includes('程序填空题')) {
                    await solveFillInTheBlank('程序填空题');
                } else if ((funcTab && funcTab.classList.contains('active')) || activeTabText.includes('函数题')) {
                    await solveCodeProblems('FUNC');
                } else if ((progTab && progTab.classList.contains('active')) || activeTabText.includes('编程题')) {
                    await solveCodeProblems('PROG');
                } else {
                    addInfoLog("当前板块暂不支持或已全部完成。");
                    break;
                }

                if (!isRunning) break;

                if (currentMode === 'solve') {
                    const switched = await saveAndNext();
                    if (switched && CONFIG.autoNext && isRunning) {
                        addInfoLog("等待页面加载，5秒后开始下一板块...");
                        for (let i = 0; i < 5; i++) {
                            if (!isRunning) break;
                            await new Promise(r => setTimeout(r, 1000));
                        }
                        if (!isRunning) break;
                    } else {
                        break;
                    }
                } else {
                    break; // 检查模式只检查当前页
                }
            } catch (err) {
                addInfoLog(`运行中发生错误: ${err}`);
                break;
            }
        }

        // 检查模式下显示总结
        if (currentMode === 'check') {
            showCheckSummary();
        }

        stopTask();
        addInfoLog("任务已结束。");
    }

    function stopTask() {
        isRunning = false;
        startBtn.disabled = false;
        startBtn.style.display = 'inline-block';
        startBtn.textContent = currentMode === 'solve' ? '开始答题' : '检查答案';
        startBtn.className = currentMode === 'solve' ? 'pta-btn' : 'pta-btn check-btn';
        stopBtn.style.display = 'none';
    }

    document.getElementById('start-btn').onclick = solveCurrentPage;

    window.addEventListener('load', unlockCopy);
})();
