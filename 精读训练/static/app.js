
    /* =========================================================
       CET-6 精读训练（逐段翻译 + AI 纠错） — 前端
       ========================================================= */
    'use strict';

    const APP_DIR = '精读训练';

    const state = {
        article: null,
        stage: 'source',
        reached: { source: true },
        translations: {},   // {1:'...', 2:'...'} 每段译文
        feedback: {},       // {1:{...}, 2:{...}} 每段纠错结果
        evaluated: new Set()
    };

    document.addEventListener('DOMContentLoaded', () => { renderStepper(); checkHealth(); });

    function currentModel() { return document.getElementById('modelSelect').value || null; }

    async function checkHealth() {
        const backEl = document.getElementById('statusBackend'), keyEl = document.getElementById('statusKey'), hintEl = document.getElementById('statusHint');
        try {
            const res = await fetch('/api/health'); const d = await res.json();
            backEl.innerHTML = '🔌 后端：<span class="ok">已连接</span>';
            if (d.hasKey) { keyEl.innerHTML = '🔑 DeepSeek Key：<span class="ok">已配置</span>'; hintEl.textContent = ''; }
            else { keyEl.innerHTML = '🔑 DeepSeek Key：<span class="err">未配置</span>'; hintEl.textContent = '请在 ' + APP_DIR + '/.env 设置 DEEPSEEK_API_KEY（可复制 .env.example）'; }
        } catch (e) {
            backEl.innerHTML = '🔌 后端：<span class="err">未连接</span>'; keyEl.textContent = '';
            hintEl.textContent = '请先启动后端：在 ' + APP_DIR + '/ 目录运行 python app.py';
        }
    }

    /* ===== STEPPER ===== */
    const STAGES = ['source', 'read'];
    const STAGE_LABEL = { source: '出题', read: '精读翻译' };
    function renderStepper() {
        const wrap = document.getElementById('stepper'); wrap.innerHTML = '';
        STAGES.forEach((s, i) => {
            const el = document.createElement('div');
            const cur = state.stage === s, done = STAGES.indexOf(state.stage) > i;
            el.className = 'step' + (cur ? ' active' : '') + (done ? ' done' : '') + (state.reached[s] ? ' reachable' : '');
            el.innerHTML = `<span class="dot">${done ? '✓' : (i + 1)}</span><span>${STAGE_LABEL[s]}</span>`;
            if (state.reached[s]) el.onclick = () => setStage(s);
            wrap.appendChild(el);
            if (i < STAGES.length - 1) { const ar = document.createElement('span'); ar.className = 'step-arrow'; ar.textContent = '›'; wrap.appendChild(ar); }
        });
    }
    function setStage(s) {
        state.stage = s;
        STAGES.forEach(x => document.getElementById('stage-' + x).classList.toggle('hidden', x !== s));
        renderStepper(); window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function reach(s) { state.reached[s] = true; }

    /* ===== API ===== */
    async function apiPost(url, body) {
        let res;
        try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
        catch (e) { throw new Error('无法连接后端（请确认已运行 python app.py）：' + e.message); }
        let data = null; try { data = await res.json(); } catch (_) {}
        if (!res.ok || !data) throw new Error((data && data.error) || ('请求失败 (' + res.status + ')'));
        return data;
    }
    function showLoading(msg) { document.getElementById('loadingText').textContent = msg || 'AI 思考中…'; document.getElementById('loadingOverlay').classList.add('show'); }
    function hideLoading() { document.getElementById('loadingOverlay').classList.remove('show'); }

    /* ===== GENERATE ===== */
    async function generateArticle() {
        const keywords = document.getElementById('keywordsInput').value;
        const wordTarget = parseInt(document.getElementById('wordTarget').value, 10) || 700;
        showLoading('正在生成 CET-6 精读原文（约 ' + wordTarget + ' 词，可能需 20–40 秒）…');
        try {
            const d = await apiPost('/api/generate', { keywords, wordTarget, model: currentModel(), vocabCheck: document.getElementById('vocabChk').checked });
            loadArticle(d.article);
            const savedName = d.saved ? d.saved.split(/[\\/]/).pop() : '';
            toast(savedName ? ('已生成并存档：my/' + savedName) : '生成完成，开始逐段翻译', 'ok');
            reach('read'); setStage('read');
        } catch (e) { toast(e.message || '生成失败', 'err'); console.error(e); }
        finally { hideLoading(); }
    }

    function loadArticle(a) {
        a.title = a.title || 'CET-6 精读训练';
        a.topic = a.topic || '';
        state.article = a;
        state.translations = {}; state.feedback = {}; state.evaluated = new Set();
        document.getElementById('artBadge').textContent = '📖 ' + (a.topic || a.title);
        document.getElementById('articleMeta').innerHTML =
            '<b>标题：</b>' + escapeHtml(a.title) + '　|　<b>词数：</b>' + (a.word_count || '?') + '　|　<b>段数：</b>' + (a.paragraphs || []).length;
        renderParagraphs();
        updateProgress();
    }

    function renderParagraphs() {
        const box = document.getElementById('paragraphsBox');
        box.innerHTML = '';
        (state.article.paragraphs || []).forEach((p, i) => {
            const no = p.no || (i + 1);
            const wc = (p.en || '').split(/\s+/).filter(Boolean).length;
            const card = document.createElement('div');
            card.className = 'para-card'; card.id = 'para-' + no;
            card.innerHTML =
                '<div class="para-head"><span class="para-no">第 ' + no + ' 段</span><span class="para-wc">~' + wc + ' 词</span></div>' +
                '<div class="para-en">' + escapeHtml(p.en) + '</div>' +
                '<div class="write-toolbar"><label class="field-label" style="margin:0">你的翻译</label></div>' +
                '<textarea class="write-area para-tr" id="tr-' + no + '" placeholder="把本段译成中文…" oninput="state.translations[' + no + ']=this.value"></textarea>' +
                '<div style="margin-top:10px"><button class="btn btn-orange btn-sm" id="evbtn-' + no + '" onclick="evaluatePara(' + no + ')">🔍 评价本段</button></div>' +
                '<div class="para-feedback" id="fb-' + no + '"></div>' +
                '<div class="para-reveal hidden" id="rev-' + no + '"></div>';
            box.appendChild(card);
        });
    }

    /* ===== EVALUATE ONE PARAGRAPH ===== */
    async function evaluatePara(no) {
        const paras = state.article.paragraphs || [];
        const p = paras.find(x => (x.no || (paras.indexOf(x) + 1)) === no) || paras[no - 1];
        if (!p) return;
        const ans = state.translations[no] || '';
        if (!ans.trim()) { if (!confirm('本段还没写译文，确定要提交评价吗？')) return; }
        const btn = document.getElementById('evbtn-' + no);
        btn.disabled = true; btn.textContent = '评价中…';
        showLoading('AI 正在逐处纠错本段翻译…');
        try {
            const d = await apiPost('/api/evaluate', { en: p.en, reference: p.reference, answer: ans, model: currentModel() });
            state.feedback[no] = d.result || {};
            state.evaluated.add(no);
            renderFeedback(no, state.feedback[no], p);
            revealReference(no, p);
            btn.textContent = '✅ 已评价（重评）'; btn.disabled = false;
            updateProgress();
            toast('第 ' + no + ' 段纠错完成', 'ok');
        } catch (e) {
            toast(e.message || '评价失败', 'err'); console.error(e);
            btn.disabled = false; btn.textContent = '🔍 评价本段';
        } finally { hideLoading(); }
    }

    function renderFeedback(no, r, p) {
        const fb = document.getElementById('fb-' + no);
        const score = Math.max(0, Math.min(100, parseInt(r.score) || 0));
        const level = r.level || '中等';
        const errs = Array.isArray(r.errors) ? r.errors : [];
        const errRows = errs.map(e => `
            <div class="err-item">
                <div class="err-line"><span class="err-tag">原文</span> <span class="err-en">${escapeHtml(e.orig || '')}</span></div>
                <div class="err-line"><span class="err-tag you">你的</span> <span class="err-yours">${escapeHtml(e.yours || '(漏译)')}</span></div>
                <div class="err-issue"><span class="issue-tag">${escapeHtml(e.issue || '问题')}</span></div>
                <div class="err-reason"><b>原因：</b>${escapeHtml(e.reason || '')}</div>
                <div class="err-sugg"><b>建议：</b>${escapeHtml(e.suggestion || '')}</div>
            </div>`).join('');
        const goods = (Array.isArray(r.good_points) ? r.good_points : []).map(x => `<li>${escapeHtml(String(x))}</li>`).join('');
        const missed = (Array.isArray(r.missed) ? r.missed : []).map(x => `<li>${escapeHtml(String(x))}</li>`).join('');
        fb.innerHTML = `
            <div class="fb-head">
                <div class="score-ring small" style="--p:${score}%"><div class="inner"><div class="num">${score}</div></div></div>
                <div class="fb-head-right">
                    <span class="level-badge level-${escapeHtml(level)}">${escapeHtml(level)}</span>
                    <div class="fb-overall">${escapeHtml(r.overall || '')}</div>
                </div>
            </div>
            ${errRows ? '<div class="err-list"><h5>⚠️ 译错/不妥之处（共 ' + errs.length + ' 处）</h5>' + errRows + '</div>' : '<div class="err-list"><h5>✅ 本段未发现明显错误</h5></div>'}
            ${goods ? '<div class="key-terms-box"><h5>👍 译得好的地方</h5><ul>' + goods + '</ul></div>' : ''}
            ${missed ? '<div class="cloze-notes"><h5>📌 漏译/理解偏差</h5><ul>' + missed + '</ul></div>' : ''}
            ${r.feedback ? '<div class="answer-explanation show"><div class="explanation-text"><b>提升建议：</b>' + escapeHtml(r.feedback) + '</div></div>' : ''}`;
    }

    function revealReference(no, p) {
        const rev = document.getElementById('rev-' + no);
        const terms = (p.key_terms || []).map(t => `<li><b>${escapeHtml(t.en)}</b> — ${escapeHtml(t.cn)}</li>`).join('');
        rev.innerHTML = '<div class="reference-box"><h4>📝 参考译文</h4>' + escapeHtml(p.reference || '') + '</div>'
            + (terms ? '<div class="key-terms-box"><h5>🔑 本段重点词/短语</h5><ul>' + terms + '</ul></div>' : '');
        rev.classList.remove('hidden');
    }

    function updateProgress() {
        const total = (state.article && state.article.paragraphs || []).length;
        const done = state.evaluated.size;
        document.getElementById('progBadge').textContent = '已评价 ' + done + ' / ' + total + ' 段';
    }

    /* ===== UTIL ===== */
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    let toastTimer = null;
    function toast(msg, type) {
        const el = document.getElementById('toast'); el.textContent = msg;
        el.className = 'show' + (type === 'err' ? ' err' : type === 'ok' ? ' ok' : '');
        if (toastTimer) clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = ''; }, 4200);
    }
    function restart() {
        if (!confirm('开始新的一篇？当前内容将被替换。')) return;
        state.article = null; state.translations = {}; state.feedback = {}; state.evaluated = new Set();
        state.reached = { source: true };
        setStage('source'); document.getElementById('keywordsInput').value = '';
        toast('已重置，请输入关键词或留空随机', 'ok');
    }
    async function saveExercise() {
        if (!state.article) { toast('当前没有可保存的内容', 'err'); return; }
        // 把译文与纠错并入段落，便于回看
        const paras = (state.article.paragraphs || []).map((p, i) => {
            const no = p.no || (i + 1);
            return Object.assign({}, p, { user_translation: state.translations[no] || '', feedback: state.feedback[no] || null });
        });
        const ex = Object.assign({}, state.article, { paragraphs: paras });
        try {
            const d = await apiPost('/api/save', { exercise: ex });
            toast('已保存到 my/' + (d.path || '').split(/[\\/]/).pop(), 'ok');
        } catch (e) { toast(e.message || '保存失败', 'err'); }
    }
