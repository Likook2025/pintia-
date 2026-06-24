// ==UserScript==
// @name         PTA pintia 学习助手 (多平台版)
// @namespace    Likook
// @version      6.0
// @description  自动识别题型，支持判断、单选、函数、编程题。支持 DeepSeek / MiMo / GPT 三大平台，一键切换。多策略代码填入，完美绕过复制限制。
// @author       Likook
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

    // --- 平台预设 ---
    const PLATFORM_PRESETS = {
        'deepseek': {
            name: 'DeepSeek',
            url: 'https://api.deepseek.com/v1/chat/completions',
            model: 'deepseek-chat',
            keyHint: 'sk-... (platform.deepseek.com)',
            docs: 'platform.deepseek.com'
        },
        'mimo': {
            name: 'MiMo (小米)',
            url: 'https://api.xiaomimimo.com/v1/chat/completions',
            model: 'mimo-v2.5-pro',
            keyHint: 'sk-... (platform.xiaomimimo.com)',
            docs: 'platform.xiaomimimo.com'
        },
        'gpt': {
            name: 'OpenAI GPT',
            url: 'https://api.openai.com/v1/chat/completions',
            model: 'gpt-4o',
            keyHint: 'sk-... (platform.openai.com)',
            docs: 'platform.openai.com'
        },
        'custom': {
            name: '自定义',
            url: '',
            model: '',
            keyHint: '自行填写',
            docs: ''
        }
    };

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
        get platform() { return GM_getValue('pta_platform', 'deepseek'); },
        set platform(v) { GM_setValue('pta_platform', v); },
        get apiUrl() { return GM_getValue('pta_api_url', 'https://api.deepseek.com/v1/chat/completions'); },
        set apiUrl(v) { GM_setValue('pta_api_url', v); },
        get apiKey() { return GM_getValue('pta_api_key', ''); },
        set apiKey(v) { GM_setValue('pta_api_key', v); },
        get apiModel() { return GM_getValue('pta_api_model', 'deepseek-chat'); },
        set apiModel(v) { GM_setValue('pta_api_model', v); }
    };

    // 语言映射表
    const LANG_MAP = {
        'C': 'C (gcc)',
        'C++': 'C++ (g++)',
        'Java': 'Java (javac)',
        'Python': 'Python (python3)'
    };

    // --- 1. 复制破解功能 (参考 pta-paste-bypass 项目) ---
    let ptaAntiBlockInstalled = false;

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function ptaNorm(s) {
        return String(s || '').replace(/\u200b/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    }

    // 清除事件阻止程序
    function ptaClearBlockers(scope) {
        try {
            const root = (scope?.querySelectorAll) ? scope : document;
            const targets = [document, window];
            if (document.body) targets.push(document.body);
            root.querySelectorAll('input,textarea,[contenteditable],.cm-editor,.cm-content').forEach(el => targets.push(el));
            const props = ['oncopy', 'oncut', 'onpaste', 'oncontextmenu', 'onselectstart', 'onkeydown', 'onbeforeinput'];
            for (const el of targets) {
                for (const p of props) { try { el[p] = null; } catch {} }
                if (el?.style && (el.classList?.contains('cm-editor') || el.classList?.contains('cm-content') || el.isContentEditable)) {
                    try { el.style.userSelect = 'text'; } catch {}
                    try { el.style.webkitUserSelect = 'text'; } catch {}
                }
            }
        } catch {}
    }

    // 安装绕过机制
    function ptaInstallBypass() {
        if (ptaAntiBlockInstalled) return;
        ptaAntiBlockInstalled = true;

        const isEd = t => {
            if (!t || !(t instanceof Element)) return false;
            if (t.isContentEditable) return true;
            const tag = t.tagName.toLowerCase();
            if (tag === 'textarea') return true;
            if (tag === 'input') {
                const tp = (t.getAttribute('type') || 'text').toLowerCase();
                return !['button', 'submit', 'checkbox', 'radio', 'file', 'image', 'reset', 'color'].includes(tp);
            }
            return Boolean(t.closest('textarea,input,[contenteditable=true],.cm-editor,.cm-content'));
        };

        const g = e => {
            if (!isEd(e.target)) return;
            e.stopImmediatePropagation();
        };

        const kg = e => {
            if (!isEd(e.target)) return;
            if ((e.ctrlKey || e.metaKey) && ['v', 'c', 'x', 'a'].includes(String(e.key).toLowerCase())) {
                e.stopImmediatePropagation();
            }
        };

        ['copy', 'cut', 'paste', 'beforeinput', 'selectstart', 'contextmenu'].forEach(t => window.addEventListener(t, g, true));
        window.addEventListener('keydown', kg, true);

        // 手动粘贴拦截 - 支持用户 Ctrl+V 粘贴代码
        document.addEventListener('paste', function(e) {
            const contentDiv = document.querySelector('.cm-content[contenteditable=true]');
            if (!contentDiv) return;
            if (!contentDiv.contains(document.activeElement) && contentDiv !== document.activeElement) return;

            let pastedText = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
            if (!pastedText) return;

            e.preventDefault();
            e.stopImmediatePropagation();
            pastedText = pastedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

            // 尝试用 CM API 填入
            if (ptaFillCMApi(contentDiv, pastedText)) {
                console.log('[PTA] 手动粘贴成功 (CM API)');
                return;
            }

            // 回退：逐块插入
            const chunkSize = 200;
            (async function() {
                contentDiv.focus();
                document.execCommand('selectAll', false, null);
                document.execCommand('delete', false, null);
                await sleep(50);
                for (let i = 0; i < pastedText.length; i += chunkSize) {
                    const chunk = pastedText.substring(i, i + chunkSize);
                    document.execCommand('insertText', false, chunk);
                    await sleep(10);
                }
                console.log('[PTA] 手动粘贴完成 (execCommand)');
            })();
        }, true);

        ptaClearBlockers(document);
        setInterval(() => ptaClearBlockers(document), 1500);

        console.log('[PTA Helper] 绕过机制已安装');
    }

    // 查找 CodeMirror 实例
    function ptaFindCM(editor) {
        let node = editor;
        while (node) {
            // CM5
            if (node.CodeMirror && typeof node.CodeMirror.setValue === 'function') {
                console.log('[PTA] 找到 CodeMirror 5 实例');
                return { type: 'cm5', instance: node.CodeMirror };
            }
            // CM6 - 多种可能的路径
            const cv = node.cmView;
            if (cv?.view?.state?.doc && typeof cv.view.dispatch === 'function') {
                console.log('[PTA] 找到 CodeMirror 6 实例 (cmView.view)');
                return { type: 'cm6', instance: cv.view };
            }
            if (cv?.rootView?.view?.state?.doc && typeof cv.rootView.view.dispatch === 'function') {
                console.log('[PTA] 找到 CodeMirror 6 实例 (rootView.view)');
                return { type: 'cm6', instance: cv.rootView.view };
            }
            // 直接从 .cm-editor 元素查找
            if (node.classList?.contains('cm-editor')) {
                if (node.CodeMirror) {
                    console.log('[PTA] 找到 CodeMirror 5 实例 (.cm-editor)');
                    return { type: 'cm5', instance: node.CodeMirror };
                }
                if (node.cmView?.view) {
                    console.log('[PTA] 找到 CodeMirror 6 实例 (.cm-editor.cmView.view)');
                    return { type: 'cm6', instance: node.cmView.view };
                }
            }
            if (node.view?.state?.doc && typeof node.view.dispatch === 'function') {
                console.log('[PTA] 找到 CodeMirror 6 实例 (node.view)');
                return { type: 'cm6', instance: node.view };
            }
            // 尝试从 __vue_app__ 或其他 React 属性获取
            const vueCm = node._cmView || node.__cm;
            if (vueCm?.view?.state?.doc && typeof vueCm.view.dispatch === 'function') {
                console.log('[PTA] 找到 CodeMirror 6 实例 (私有属性)');
                return { type: 'cm6', instance: vueCm.view };
            }
            node = node.parentElement;
        }
        console.log('[PTA] 未找到 CodeMirror 实例，将使用 DOM 方式填入');
        return null;
    }

    // CodeMirror API 填入
    function ptaFillCMApi(editor, code) {
        const f = ptaFindCM(editor);
        if (!f) return false;
        try {
            if (f.type === 'cm6') {
                const docLength = f.instance.state.doc.length;
                f.instance.dispatch({
                    changes: { from: 0, to: docLength, insert: code },
                    selection: { anchor: code.length }
                });
                if (typeof f.instance.focus === 'function') f.instance.focus();
                console.log(`[PTA] CM6 填入成功，共 ${code.length} 字符`);
                return true;
            }
            if (f.type === 'cm5') {
                f.instance.setValue(code);
                if (typeof f.instance.focus === 'function') f.instance.focus();
                console.log(`[PTA] CM5 填入成功，共 ${code.length} 字符`);
                return true;
            }
        } catch (e) {
            console.error('[PTA] CM API 填入失败:', e);
        }
        return false;
    }

    // 事件触发
    function ptaTrigger(editor, text) {
        try { editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); } catch {}
        try { editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text })); } catch {}
        try { editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); } catch {}
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        try { editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); } catch {}
    }

    // 立即安装绕过机制
    ptaInstallBypass();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ptaInstallBypass);
    }
    window.addEventListener('load', () => {
        ptaInstallBypass();
        console.log('[PTA Helper] 页面加载完成，绕过机制已就绪');
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
        /* 平台选择按钮 */
        .platform-selector {
            display: flex;
            gap: 6px;
            margin-bottom: 15px;
            flex-wrap: wrap;
        }
        .platform-btn {
            flex: 1;
            min-width: 70px;
            padding: 8px 6px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            text-align: center;
            transition: all 0.2s;
            background: white;
            color: #666;
        }
        .platform-btn:hover {
            border-color: #667eea;
            background: #f0f2ff;
        }
        .platform-btn.active {
            border-color: #667eea;
            background: #667eea;
            color: white;
        }
        .platform-btn.deepseek.active { background: #4D6BFE; border-color: #4D6BFE; }
        .platform-btn.mimo.active { background: #667eea; border-color: #667eea; }
        .platform-btn.gpt.active { background: #10a37f; border-color: #10a37f; }
        .platform-btn.custom.active { background: #718096; border-color: #718096; }
        .platform-info {
            font-size: 11px;
            color: #999;
            margin-top: -8px;
            margin-bottom: 12px;
            text-align: right;
        }
        .platform-info a {
            color: #667eea;
            text-decoration: none;
        }
        .platform-info a:hover {
            text-decoration: underline;
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
                <div style="font-size: 11px; color: #999; margin-bottom: 8px;">选择平台即可自动填充配置：</div>
                <div class="platform-selector" id="platform-selector">
                    <div class="platform-btn deepseek" data-platform="deepseek">DeepSeek</div>
                    <div class="platform-btn mimo" data-platform="mimo">MiMo</div>
                    <div class="platform-btn gpt" data-platform="gpt">GPT</div>
                    <div class="platform-btn custom" data-platform="custom">自定义</div>
                </div>
                <div class="platform-info" id="platform-info"></div>
                <div class="api-input-group">
                    <label>API URL:</label>
                    <input type="text" id="api-url-input" value="${CONFIG.apiUrl}">
                </div>
                <div class="api-input-group">
                    <label>API Key:</label>
                    <input type="password" id="api-key-input" value="${CONFIG.apiKey}">
                </div>
                <div class="api-input-group">
                    <label>模型 (Model):</label>
                    <input type="text" id="api-model-input" value="${CONFIG.apiModel}">
                </div>
                <div class="api-tips">
                    支持任何兼容 OpenAI Chat Completions 格式的 API。<br>
                    URL 需包含完整路径（通常以 /v1/chat/completions 结尾）。<br>
                    选择上方平台可一键填充配置，选择「自定义」可手动填写。
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

    // API 手动输入保存
    const apiUrlInput = document.getElementById('api-url-input');
    const apiKeyInput = document.getElementById('api-key-input');
    const apiModelInput = document.getElementById('api-model-input');

    apiUrlInput.onchange = (e) => { CONFIG.apiUrl = e.target.value; updatePlatformInfo(); };
    apiKeyInput.onchange = (e) => CONFIG.apiKey = e.target.value;
    apiModelInput.onchange = (e) => { CONFIG.apiModel = e.target.value; updatePlatformInfo(); };

    // 平台选择
    const platformInfoEl = document.getElementById('platform-info');

    function updatePlatformInfo() {
        const platform = CONFIG.platform;
        if (platform === 'custom') {
            platformInfoEl.innerHTML = '<span style="color: #999;">自定义模式</span>';
        } else {
            const preset = PLATFORM_PRESETS[platform];
            if (preset) {
                platformInfoEl.innerHTML = `<span>Key 申请: <a href="https://${preset.docs}" target="_blank">${preset.docs}</a></span>`;
            }
        }
    }

    function applyPlatformPreset(platform) {
        const preset = PLATFORM_PRESETS[platform];
        if (!preset) return;

        CONFIG.platform = platform;

        if (platform === 'custom') {
            // 自定义模式：保持当前值不变
            platformInfoEl.innerHTML = '<span style="color: #999;">自定义模式 — 请手动填写下方配置</span>';
        } else {
            // 更新配置并保存
            CONFIG.apiUrl = preset.url;
            CONFIG.apiModel = preset.model;

            // 更新输入框
            apiUrlInput.value = preset.url;
            apiModelInput.value = preset.model;
            apiKeyInput.placeholder = preset.keyHint;

            updatePlatformInfo();
        }

        // 更新按钮状态
        document.querySelectorAll('.platform-btn').forEach(b => {
            b.classList.remove('active');
            if (b.dataset.platform === platform) {
                b.classList.add('active');
            }
        });
    }

    // 平台按钮点击事件
    document.querySelectorAll('.platform-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            applyPlatformPreset(btn.dataset.platform);
        });
    });

    // 初始化平台状态
    (function initPlatform() {
        const savedPlatform = CONFIG.platform;
        // 高亮当前平台按钮
        document.querySelectorAll('.platform-btn').forEach(b => {
            if (b.dataset.platform === savedPlatform) {
                b.classList.add('active');
            }
        });
        updatePlatformInfo();
    })();

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
        ptaInstallBypass();

        const container = document.querySelector('[data-e2e="code-editor-input"]');
        let editors = container
            ? Array.from(container.querySelectorAll('.cm-content[contenteditable=true]'))
            : Array.from(document.querySelectorAll('.cm-content[contenteditable=true]'));

        if (!editors.length) {
            const any = document.querySelector('.cm-content');
            if (any) editors = [any];
        }

        if (!editors.length) {
            addInfoLog('[填入] 找不到代码编辑器');
            return false;
        }

        const editor = editors[editors.length - 1];
        const cmRoot = editor.closest('.cm-editor');
        if (cmRoot) ptaClearBlockers(cmRoot);

        editor.focus();
        const finalCode = String(code).replace(/\r\n/g, '\n');

        try {
            const isFilledEnough = () => {
                const c = ptaNorm(editor.innerText || editor.textContent);
                // 至少要有 80% 的内容
                return c.length > 0 && c.length >= finalCode.length * 0.8;
            };

            addInfoLog(`[填入] 正在填入代码 (${finalCode.length} 字符)...`);

            // 策略0: CodeMirror API (最可靠)
            if (ptaFillCMApi(editor, finalCode)) {
                await sleep(100);
                if (isFilledEnough()) {
                    addInfoLog('[填入] 成功 (CodeMirror API)');
                    return true;
                }
                addInfoLog(`[填入] CM API 后不完整，编辑器只有 ${ptaNorm(editor.innerText).length} 字符，回退...`);
            }

            // 策略1: execCommand 一次性插入
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            await sleep(100);
            // execCommand insertText 对大文本可能有限制，分块插入
            const chunkSize = 500;
            for (let i = 0; i < finalCode.length; i += chunkSize) {
                const chunk = finalCode.substring(i, i + chunkSize);
                document.execCommand('insertText', false, chunk);
                await sleep(15);
            }
            await sleep(150);
            if (isFilledEnough()) {
                addInfoLog('[填入] 成功 (execCommand 分块)');
                return true;
            }
            addInfoLog(`[填入] execCommand 后不完整(${ptaNorm(editor.innerText).length})，回退...`);

            // 策略2: 逐行插入 (更小的块)
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            await sleep(60);
            const lines = finalCode.split('\n');
            let lineSuccess = 0;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].length > 0) {
                    document.execCommand('insertText', false, lines[i]);
                }
                if (i < lines.length - 1) {
                    document.execCommand('insertLineBreak', false, null);
                }
                await sleep(10);
                lineSuccess++;
            }
            await sleep(150);
            if (isFilledEnough()) {
                addInfoLog(`[填入] 成功 (逐行插入, ${lineSuccess}/${lines.length} 行)`);
                return true;
            }
            addInfoLog(`[填入] 逐行后不完整(${ptaNorm(editor.innerText).length})，回退...`);

            // 策略3: 逐字符模拟输入（终极方案）
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            await sleep(60);
            addInfoLog(`[填入] 使用逐字符输入 (${Math.ceil(finalCode.length / 3)} 批)...`);
            const tinyChunk = 3; // 每次3个字符
            for (let i = 0; i < finalCode.length; i += tinyChunk) {
                const bit = finalCode.substring(i, i + tinyChunk);
                // 使用 dispatchEvent 模拟键盘输入
                const inputEvent = new InputEvent('input', {
                    bubbles: true,
                    inputType: 'insertText',
                    data: bit,
                    dataTransfer: null
                });
                editor.dispatchEvent(inputEvent);
                // 也在 selection 处插入
                document.execCommand('insertText', false, bit);
                await sleep(5);
            }
            await sleep(200);

            // 策略4: 再试 CM API（双重保险）
            ptaFillCMApi(editor, finalCode);
            await sleep(100);

            const finalLen = ptaNorm(editor.innerText).length;
            if (finalLen > 0) {
                if (finalLen >= finalCode.length * 0.8) {
                    addInfoLog(`[填入] 成功 (最终, ${finalLen}/${finalCode.length} 字符)`);
                    return true;
                } else {
                    addInfoLog(`[填入] 部分成功 (${finalLen}/${finalCode.length} 字符)，可能需手动补全`);
                    return true;
                }
            }

            addInfoLog('[填入] 所有策略均失败');
            return false;
        } catch (e) {
            console.error('[PTA Helper] 代码填充失败:', e);
            addInfoLog(`[填入] 异常: ${e.message}`);
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

        // 单题模式
        if (targetQuestionNum) {
            const idx = targetQuestionNum - 1;
            if (idx < 0 || idx >= problemBtns.length) {
                addInfoLog(`题号 ${targetQuestionNum} 超出范围（共 ${problemBtns.length} 题）`);
                return;
            }
            addModeInfoLog(`[${type === 'FUNC' ? '函数题' : '编程题'}] 第 ${targetQuestionNum} 题`);
            await solveSingleCodeProblem(problemBtns[idx], idx, type, targetLang);
            return;
        }

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

    // 单题编程题
    async function solveSingleCodeProblem(btn, index, type, targetLang) {
        if (btn.querySelector('.PROBLEM_ACCEPTED_iri62')) {
            addInfoLog(`第 ${index + 1} 题已通过，跳过`);
            return;
        }

        addInfoLog(`正在解决第 ${index + 1} 题...`);
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
            return;
        }

        const contentArea = document.querySelector('.rendered-markdown') ||
                            document.querySelector('.generalProblemBody_WIhdN') ||
                            document.querySelector('.problem-body') ||
                            document.querySelector('.problemBody_S_NqD');

        const infoList = document.querySelector('.problemInfo_HVczC');
        const infoText = infoList ? infoList.innerText.replace(/\n+/g, ' ').trim() : '';

        const title = document.querySelector('.text-darkest.font-bold.text-lg')?.innerText ||
                      document.querySelector('.problem-title')?.innerText ||
                      `第 ${index + 1} 题`;
        const logItem = addLog(title);

        try {
            if (!isRunning) return;
            addInfoLog(`正在请求 AI 生成代码 (${targetLang})...`);

            const mainContent = getCleanText(contentArea || document.body);
            const fullPrompt = `【题目标题】：${title}\n【限制信息】：${infoText}\n【题目正文】：\n${mainContent}`;

            const result = await askAI(fullPrompt, type, targetLang);

            if (!isRunning) return;

            if (currentMode === 'check') {
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

        ptaInstallBypass();

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
