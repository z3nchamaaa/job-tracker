'use strict';

// 「共有」モーダルの中身: 選考状況のテキスト共有と、企業データの受け渡し
(function () {
  const Share = window.JobTrackerShare || {};
  const LEVEL_KEY = 'jt-share-level';

  function readStoredLevel() {
    try {
      const value = window.localStorage.getItem(LEVEL_KEY);
      return Share.isShareLevel && Share.isShareLevel(value) ? value : 'standard';
    } catch {
      return 'standard';
    }
  }

  function storeLevel(level) {
    try {
      window.localStorage.setItem(LEVEL_KEY, level);
    } catch {}
  }

  function downloadText(content, fileName, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  function buildShell() {
    const levels = (Share.SHARE_LEVELS || []).map((key) => {
      const meta = Share.SHARE_LEVEL_META[key];
      return `
        <label class="share-level">
          <input type="radio" name="share-level" value="${key}" data-no-dirty>
          <span class="share-level-body">
            <span class="share-level-title">${meta.label}</span>
            <span class="share-level-desc">${meta.description}</span>
          </span>
        </label>`;
    }).join('');

    return `
      <div class="modal-dialog modal-lg" role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
        <div class="modal-header">
          <div>
            <h2 id="share-modal-title" class="modal-title">就活の状況を共有</h2>
            <p class="modal-subtitle">志望度・評価・メモ・マイページID・面接記録・AIの分析結果は共有されません</p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-modal-close aria-label="閉じる">✕ 閉じる</button>
        </div>
        <div class="modal-tabs" role="tablist" aria-label="共有の種類">
          <button type="button" class="modal-tab is-active" role="tab" aria-selected="true" data-share-tab="status">選考状況</button>
          <button type="button" class="modal-tab" role="tab" aria-selected="false" data-share-tab="export">企業データを渡す</button>
          <button type="button" class="modal-tab" role="tab" aria-selected="false" data-share-tab="import">企業データを受け取る</button>
        </div>
        <div class="modal-body">
          <section data-share-panel="status" role="tabpanel">
            <fieldset class="share-fieldset">
              <legend class="form-label">共有する詳しさ</legend>
              <div class="share-levels">${levels}</div>
            </fieldset>
            <div class="share-options">
              <label class="checkbox-row"><input type="checkbox" id="share-include-interested" data-no-dirty checked> 検討中の企業を含める</label>
              <label class="checkbox-row"><input type="checkbox" id="share-include-closed" data-no-dirty checked> 不合格・辞退を含める</label>
              <label class="checkbox-row" id="share-anonymize-row"><input type="checkbox" id="share-anonymize" data-no-dirty> 企業名を伏せる（企業A、企業B…）</label>
            </div>
            <label class="form-label" for="share-status-text">プレビュー</label>
            <textarea id="share-status-text" class="textarea share-preview" readonly data-no-dirty rows="12"></textarea>
            <div class="share-actions">
              <button type="button" id="btn-share-copy-status" class="btn btn-primary">コピー</button>
              <button type="button" id="btn-share-save-status" class="btn btn-outlined">テキストファイルに保存</button>
            </div>
          </section>

          <section data-share-panel="export" role="tabpanel" hidden>
            <p class="form-hint share-lead">一緒に受ける友達に企業情報を渡せます。受け取った人は「企業データを受け取る」から自分のトラッカーに追加できます。選考状況は渡さず、相手側では「検討」として追加されます。</p>
            <div class="share-list-header">
              <span class="form-label">渡す企業 <span id="share-export-count" class="form-hint"></span></span>
              <span class="share-list-tools">
                <button type="button" class="btn btn-sm btn-ghost" id="btn-share-select-all">すべて選ぶ</button>
                <button type="button" class="btn btn-sm btn-ghost" id="btn-share-select-none">選択を外す</button>
              </span>
            </div>
            <div id="share-export-list" class="share-company-list"></div>
            <div class="share-options">
              <label class="checkbox-row"><input type="checkbox" id="share-ex-research" data-no-dirty checked> 企業概要・特徴</label>
              <label class="checkbox-row"><input type="checkbox" id="share-ex-compensation" data-no-dirty checked> 給与・待遇</label>
              <label class="checkbox-row"><input type="checkbox" id="share-ex-steps" data-no-dirty checked> 選考フロー（ステップ名のみ）</label>
              <label class="checkbox-row"><input type="checkbox" id="share-ex-events" data-no-dirty checked> 今後の説明会・締切・Webテスト（面接の日程は含めません）</label>
            </div>
            <div class="share-actions">
              <button type="button" id="btn-share-save-companies" class="btn btn-primary">ファイルに保存</button>
              <button type="button" id="btn-share-copy-companies" class="btn btn-outlined">コピー（チャットに貼り付け用）</button>
            </div>
          </section>

          <section data-share-panel="import" role="tabpanel" hidden>
            <p class="form-hint share-lead">友達から受け取ったファイルを選ぶか、コピーされた文字列を貼り付けてください。追加する前に内容を確認できます。</p>
            <div class="import-controls">
              <input type="file" id="share-import-file" accept=".json,.txt,application/json,text/plain" class="input" style="max-width:340px">
            </div>
            <label class="form-label" for="share-import-text">または貼り付け</label>
            <textarea id="share-import-text" class="textarea" rows="4" data-no-dirty placeholder='{"format":"job-tracker-company-share", ...}'></textarea>
            <div class="share-actions">
              <button type="button" id="btn-share-preview-import" class="btn btn-tonal">内容を確認</button>
            </div>
            <div id="share-import-preview"></div>
          </section>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outlined" data-modal-close>閉じる</button>
        </div>
      </div>`;
  }

  function mount(root, deps) {
    const { getCompanies, apiRequest, copyText, showToast, escapeHtml, onImported } = deps;
    const $ = (sel) => root.querySelector(sel);

    // ---- タブ ----
    const tabs = [...root.querySelectorAll('[data-share-tab]')];
    const showTab = (key) => {
      for (const tab of tabs) {
        const active = tab.getAttribute('data-share-tab') === key;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-selected', String(active));
      }
      root.querySelectorAll('[data-share-panel]').forEach((panel) => {
        panel.hidden = panel.getAttribute('data-share-panel') !== key;
      });
    };
    tabs.forEach((tab) => tab.addEventListener('click', () => showTab(tab.getAttribute('data-share-tab'))));

    // ---- 選考状況 ----
    const statusText = $('#share-status-text');
    const levelInputs = [...root.querySelectorAll('input[name="share-level"]')];
    const initialLevel = readStoredLevel();
    levelInputs.forEach((input) => { input.checked = input.value === initialLevel; });

    const currentLevel = () => (levelInputs.find((i) => i.checked) || {}).value || 'standard';
    const renderStatus = () => {
      const level = currentLevel();
      const anonymizeRow = $('#share-anonymize-row');
      anonymizeRow.hidden = level === 'simple';
      statusText.value = Share.buildStatusSummary(getCompanies(), {
        level,
        includeInterested: $('#share-include-interested').checked,
        includeClosed: $('#share-include-closed').checked,
        anonymize: level !== 'simple' && $('#share-anonymize').checked,
      });
    };
    levelInputs.forEach((input) => input.addEventListener('change', () => {
      storeLevel(currentLevel());
      renderStatus();
    }));
    ['#share-include-interested', '#share-include-closed', '#share-anonymize'].forEach((sel) => {
      $(sel).addEventListener('change', renderStatus);
    });
    renderStatus();

    $('#btn-share-copy-status').addEventListener('click', async () => {
      const ok = await copyText(statusText.value);
      showToast(ok ? '選考状況をコピーしました。' : 'コピーできませんでした。プレビューを選択してコピーしてください。', ok ? 'success' : 'error');
    });
    $('#btn-share-save-status').addEventListener('click', () => {
      downloadText(statusText.value + '\n', `就活状況-${today()}.txt`, 'text/plain;charset=utf-8');
      showToast('選考状況をテキストファイルに保存しました。', 'success');
    });

    // ---- 企業データを渡す ----
    const exportList = $('#share-export-list');
    const companies = getCompanies().slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));
    exportList.innerHTML = companies.length
      ? companies.map((c) => `
          <label class="checkbox-row share-company-row">
            <input type="checkbox" data-no-dirty data-share-company="${escapeHtml(c.id)}">
            <span class="share-company-name">${escapeHtml(c.name)}</span>
            ${c.industry ? `<span class="form-hint">${escapeHtml(c.industry)}</span>` : ''}
          </label>`).join('')
      : '<p class="form-hint">まだ企業が登録されていません。</p>';
    const companyChecks = [...exportList.querySelectorAll('[data-share-company]')];
    const updateExportCount = () => {
      const n = companyChecks.filter((c) => c.checked).length;
      $('#share-export-count').textContent = `（${n}社を選択中）`;
    };
    companyChecks.forEach((c) => c.addEventListener('change', updateExportCount));
    $('#btn-share-select-all').addEventListener('click', () => { companyChecks.forEach((c) => { c.checked = true; }); updateExportCount(); });
    $('#btn-share-select-none').addEventListener('click', () => { companyChecks.forEach((c) => { c.checked = false; }); updateExportCount(); });
    updateExportCount();

    const buildExport = () => {
      const ids = new Set(companyChecks.filter((c) => c.checked).map((c) => c.getAttribute('data-share-company')));
      if (ids.size === 0) {
        showToast('渡す企業を1社以上選んでください。', 'error');
        return null;
      }
      try {
        return Share.buildCompanyShare(getCompanies().filter((c) => ids.has(c.id)), {
          includeResearch: $('#share-ex-research').checked,
          includeCompensation: $('#share-ex-compensation').checked,
          includeSteps: $('#share-ex-steps').checked,
          includeEvents: $('#share-ex-events').checked,
        });
      } catch (err) {
        showToast(err.message, 'error');
        return null;
      }
    };
    $('#btn-share-save-companies').addEventListener('click', () => {
      const data = buildExport();
      if (!data) return;
      downloadText(JSON.stringify(data, null, 2), `企業データ共有-${today()}.json`, 'application/json');
      showToast(`${data.companies.length}社の企業データを保存しました。`, 'success');
    });
    $('#btn-share-copy-companies').addEventListener('click', async () => {
      const data = buildExport();
      if (!data) return;
      const ok = await copyText(JSON.stringify(data));
      showToast(ok ? `${data.companies.length}社の企業データをコピーしました。` : 'コピーできませんでした。ファイルに保存してください。', ok ? 'success' : 'error');
    });

    // ---- 企業データを受け取る ----
    const fileInput = $('#share-import-file');
    const pasteArea = $('#share-import-text');
    const previewArea = $('#share-import-preview');
    let staged = null;

    const resetPreview = () => {
      staged = null;
      previewArea.textContent = '';
    };
    pasteArea.addEventListener('input', resetPreview);
    fileInput.addEventListener('change', () => {
      resetPreview();
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { pasteArea.value = String(reader.result); };
      reader.onerror = () => showToast('ファイルを読み取れませんでした。', 'error');
      reader.readAsText(file, 'utf8');
    });

    const describe = (c) => {
      const parts = [];
      if (c.industry) parts.push(escapeHtml(c.industry));
      if (c.steps.length) parts.push(`選考フロー ${c.steps.length}段階`);
      if (c.events.length) parts.push(`予定 ${c.events.length}件`);
      return parts.join(' / ');
    };

    $('#btn-share-preview-import').addEventListener('click', () => {
      resetPreview();
      let parsed;
      try {
        parsed = Share.parseCompanyShare(pasteArea.value);
      } catch (err) {
        previewArea.innerHTML = `<div class="banner banner-error">⚠ ${escapeHtml(err.message)}</div>`;
        return;
      }
      const duplicates = Share.findDuplicateNames(parsed.companies, getCompanies());
      staged = pasteArea.value;
      const dupCount = duplicates.filter(Boolean).length;
      previewArea.innerHTML = `
        <div class="banner banner-info share-import-summary">
          <strong>${parsed.companies.length}社の企業データ</strong>
          ${dupCount ? `<span>同じ名前の企業がすでに${dupCount}社あります。重複を避けるため最初は選択を外しています。</span>` : ''}
        </div>
        <div class="share-company-list">
          ${parsed.companies.map((c, idx) => `
            <label class="checkbox-row share-company-row">
              <input type="checkbox" data-no-dirty data-share-import="${idx}" ${duplicates[idx] ? '' : 'checked'}>
              <span class="share-company-name">${escapeHtml(c.name)}</span>
              ${duplicates[idx] ? '<span class="chip">登録済み</span>' : ''}
              <span class="form-hint">${describe(c)}</span>
            </label>`).join('')}
        </div>
        <div class="share-actions">
          <button type="button" id="btn-share-exec-import" class="btn btn-primary">選んだ企業を追加</button>
        </div>`;

      $('#btn-share-exec-import').addEventListener('click', async (event) => {
        const selected = [...previewArea.querySelectorAll('[data-share-import]')]
          .filter((c) => c.checked)
          .map((c) => Number(c.getAttribute('data-share-import')));
        if (selected.length === 0) {
          showToast('追加する企業を1社以上選んでください。', 'error');
          return;
        }
        const btn = event.currentTarget;
        btn.disabled = true;
        try {
          const res = await apiRequest('POST', '/api/share/companies/import', { payload: staged, selected });
          await onImported();
          showToast(`${res.counts.companies}社を「検討」に追加しました${res.counts.events ? `（予定 ${res.counts.events}件）` : ''}。`, 'success');
          resetPreview();
          pasteArea.value = '';
          fileInput.value = '';
        } catch (err) {
          btn.disabled = false;
          showToast(err.message, 'error');
        }
      });
    });
  }

  window.JobTrackerShareUI = { buildShell, mount };
})();
