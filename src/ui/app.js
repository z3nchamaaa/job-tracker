'use strict';

(function () {
  const Constants = window.JobTrackerConstants || {};
  const Priority = window.JobTrackerPriority || {};
  const CareerProfile = window.JobTrackerCareerProfile || {};
  const PromptMod = window.JobTrackerPrompt || {};
  const DraftMod = window.JobTrackerDraft || {};
  const CalendarMod = window.JobTrackerCalendar || {};
  const MetricsMod = window.JobTrackerMetrics || {};

  const {
    SELECTION_STATUSES = [],
    STATUS_META = {},
    STEP_STATUSES = [],
    STEP_STATUS_LABELS = {},
    EVENT_TYPES = [],
    EVENT_LABELS = {},
    getKanbanLanes,
    getAdjacentStatus,
  } = Constants;

  const { formatPriorityStars } = Priority;
  const { DEFAULT_CAREER_PROFILE = {} } = CareerProfile;
  const { buildCompanyPrompt } = PromptMod;
  const { validateSafeHttpUrl, parseCompanyDraft, buildCompanyPayload } = DraftMod;
  const {
    nextEvent,
    localDateTime,
    previewCalendarExport,
    googleCalendarUrl,
    calendarFile,
  } = CalendarMod;
  const { computeMetrics, sortCompaniesByCompensation } = MetricsMod;

  const state = {
    loading: true,
    loadError: null,
    activeView: 'kanban',
    focusedKanbanLane: null,
    companies: [],
    events: [],
    careerProfile: { ...DEFAULT_CAREER_PROFILE },
    dbStatus: null,
    profileError: null,
    chatGptSession: {
      connected: false,
      sharing: false,
      email: null,
      authError: null,
      signingIn: false,
      generating: false,
    },
    chatGptModels: [{ slug: 'gpt-5-mini', displayName: 'Standard Fast' }],
    selectedModel: 'gpt-5-mini',
    copilotSession: { connected: false, clientId: '', models: [], quota: null, generating: false },
    selectedCopilotModel: 'auto',
    tableFilter: {
      query: '',
      status: 'ALL',
      earlyOnly: false,
    },
    scheduleFilter: {
      undoneOnly: false,
      companyId: 'ALL',
    },
    compensationSortKey: 'annualIncome',
    compensationSortDir: 'desc',
    activeModal: null,
    modalReturn: null,
    suspendedModalDirty: false,
    modalDirty: false,
    lastFocusElement: null,
  };

  let kanbanExpansion = null;

  Object.defineProperty(window, 'jobTrackerHasUnsavedChanges', {
    value: () => Boolean(state.activeModal && (state.modalDirty || state.suspendedModalDirty)),
    writable: false,
    configurable: false,
  });

  function getCsrfToken() {
    const meta = document.querySelector('meta[name="jt-csrf"]');
    return meta ? meta.getAttribute('content') || '' : '';
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDisplayDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function toIsoWithLocalOffset(localDateTimeValue) {
    if (!localDateTimeValue || typeof localDateTimeValue !== 'string') return null;
    const d = new Date(localDateTimeValue);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    const tzOffsetMin = -d.getTimezoneOffset();
    const sign = tzOffsetMin >= 0 ? '+' : '-';
    const absMin = Math.abs(tzOffsetMin);
    const tzHours = pad(Math.floor(absMin / 60));
    const tzMins = pad(absMin % 60);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${tzHours}:${tzMins}`;
  }

  async function apiRequest(method, urlPath, body) {
    const headers = {
      Accept: 'application/json',
      'x-jt-csrf': getCsrfToken(),
    };
    const options = {
      method,
      headers,
      credentials: 'same-origin',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const res = await fetch(urlPath, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false || data.error) {
      throw new Error(data.error || `通信エラーが発生しました (${res.status})`);
    }
    return data;
  }

  async function ipcInvoke(method, argument = undefined) {
    if (window.desktopBridge && typeof window.desktopBridge.invoke === 'function') {
      return window.desktopBridge.invoke(method, argument);
    }
    const res = await apiRequest('POST', '/api/desktop/ipc', { method, argument });
    return res.result;
  }

  function showToast(message, type = 'info', onRetry = null) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${escapeHtml(type)}`;
    toast.innerHTML = `
      <span>${escapeHtml(message)}</span>
      <div style="display:flex;align-items:center;gap:6px">
        ${onRetry ? `<button type="button" class="btn btn-xs btn-outlined" data-toast-retry style="color:inherit;border-color:currentColor">再試行</button>` : ''}
        <button type="button" class="btn btn-xs btn-ghost" data-toast-close style="color:inherit" aria-label="通知を閉じる">✕</button>
      </div>
    `;
    toast.querySelector('[data-toast-close]')?.addEventListener('click', () => toast.remove());
    if (typeof onRetry === 'function') {
      toast.querySelector('[data-toast-retry]')?.addEventListener('click', () => {
        toast.remove();
        onRetry();
      });
    }
    container.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 5500);
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fallback below
      }
    }
    const prevActive = document.activeElement;
    const prevSelectionStart =
      prevActive && typeof prevActive.selectionStart === 'number' ? prevActive.selectionStart : null;
    const prevSelectionEnd =
      prevActive && typeof prevActive.selectionEnd === 'number' ? prevActive.selectionEnd : null;
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
    const savedRanges = [];
    if (selection && selection.rangeCount > 0) {
      for (let i = 0; i < selection.rangeCount; i++) {
        try {
          savedRanges.push(selection.getRangeAt(i).cloneRange());
        } catch {}
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';

    let copied = false;
    try {
      document.body.appendChild(textarea);
      textarea.focus({ preventScroll: true });
      textarea.select();
      if (typeof textarea.setSelectionRange === 'function') {
        textarea.setSelectionRange(0, textarea.value.length);
      }
      copied = Boolean(typeof document.execCommand === 'function' && document.execCommand('copy'));
    } catch {
      copied = false;
    } finally {
      if (textarea.parentNode) {
        textarea.remove();
      }
      try {
        if (selection) {
          selection.removeAllRanges();
          for (const range of savedRanges) {
            selection.addRange(range);
          }
        }
      } catch {}
      try {
        if (prevActive && typeof prevActive.focus === 'function' && document.contains(prevActive)) {
          prevActive.focus({ preventScroll: true });
          if (
            prevSelectionStart !== null &&
            prevSelectionEnd !== null &&
            typeof prevActive.setSelectionRange === 'function'
          ) {
            prevActive.setSelectionRange(prevSelectionStart, prevSelectionEnd);
          }
        }
      } catch {}
    }
    return copied;
  }

  async function openSafeExternalUrl(url) {
    try {
      const checked = validateSafeHttpUrl(url, 'URL', false);
      if (!checked) {
        showToast('外部ブラウザで開けるのは https:// のURLのみです。', 'error');
        return;
      }
      await ipcInvoke('openExternalUrl', { url: checked });
    } catch (err) {
      showToast(err.message || 'URLを開けませんでした。', 'error');
    }
  }

  async function loadAllData() {
    state.loading = true;
    state.loadError = null;
    state.profileError = null;
    renderAll();

    try {
      const sysRes = await apiRequest('GET', '/api/system/status');
      state.dbStatus = sysRes.db || null;

      if (state.dbStatus && state.dbStatus.healthy) {
        const [companiesRes, eventsRes] = await Promise.all([
          apiRequest('GET', '/api/companies'),
          apiRequest('GET', '/api/events'),
        ]);
        state.companies = companiesRes.companies || [];
        state.events = eventsRes.events || [];
      } else {
        state.companies = [];
        state.events = [];
      }

      try {
        const profile = await ipcInvoke('getCareerProfile');
        state.careerProfile = profile || { ...DEFAULT_CAREER_PROFILE };
      } catch (pErr) {
        state.profileError = pErr.message;
        state.careerProfile = { ...DEFAULT_CAREER_PROFILE };
      }

      try {
        const session = await ipcInvoke('getSession');
        if (session) {
          state.chatGptSession = { ...state.chatGptSession, ...session };
        }
      } catch {
        // ignore session check error
      }

      state.loading = false;
      renderAll();
    } catch (err) {
      state.loading = false;
      state.loadError = err.message || 'データの読み込みに失敗しました。';
      renderAll();
    }
  }

  function renderAll() {
    renderHeaderCounts();
    renderSystemBanners();
    renderMetrics();
    renderActiveView();
  }

  function renderHeaderCounts() {
    renderNextEvent();
    const undoneEvents = state.events.filter((e) => !e.isDone).length;
    const setBadge = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(val);
    };
    setBadge('nav-count-schedule', undoneEvents);

    const profileDot = document.getElementById('profile-status-dot');
    if (profileDot) {
      const p = state.careerProfile || {};
      const done = Boolean(
        p.completed || p.major || p.industries || p.roles || p.priorities || p.strengths
      );
      profileDot.textContent = done ? '設定済' : '未設定';
      profileDot.className = `status-pill ${done ? 'is-done' : ''}`;
    }

    document.querySelectorAll('.view-tab').forEach((btn) => {
      const isSelected = btn.getAttribute('data-view') === state.activeView;
      btn.classList.toggle('is-active', isSelected);
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
  }

  function renderNextEvent() {
    const el = document.getElementById('header-next-event');
    if (!el) return;
    const event = nextEvent(state.events, Date.now());
    let text = state.loading ? '次の予定を読み込んでいます…'
      : state.loadError ? '次の予定を取得できませんでした'
      : '次の予定はありません';
    if (!state.loading && !state.loadError && event) {
      const company = event.company?.name || state.companies.find((c) => c.id === event.companyId)?.name;
      const date = formatDisplayDateTime(event.startAt);
      const when = event.allDay ? `${date.split(' ')[0]} 終日` : date;
      text = `次の予定：${[when, company, event.title].filter(Boolean).join(' ／ ')}`;
    }
    el.textContent = text;
    el.title = text;
  }

  function renderSystemBanners() {
    const container = document.getElementById('system-banners');
    if (!container) return;
    const banners = [];

    if (state.dbStatus && !state.dbStatus.healthy && state.dbStatus.corruptionError) {
      banners.push(`
        <div class="banner banner-error" role="alert">
          <div>
            <strong>⚠ データベース破損検知（自動初期化せず保護しています）</strong>
            <div style="font-size:0.8rem;margin-top:2px">
              ${escapeHtml(state.dbStatus.corruptionError)}
            </div>
          </div>
          <button type="button" class="btn btn-sm btn-primary" data-action="recover-db">
            破損ファイルを退避して新規DBを再作成
          </button>
        </div>
      `);
    }

    if (state.profileError) {
      banners.push(`
        <div class="banner banner-warning" role="alert">
          <div>
            <strong>⚠ プロフィール読み込み警告:</strong> ${escapeHtml(state.profileError)}
          </div>
          <button type="button" class="btn btn-sm btn-outlined" data-action="open-profile">
            プロフィールを再設定（破損ファイルは自動退避されます）
          </button>
        </div>
      `);
    }

    if (state.loadError) {
      banners.push(`
        <div class="banner banner-error" role="alert">
          <div>
            <strong>⚠ 読み込みエラー:</strong> ${escapeHtml(state.loadError)}
          </div>
          <button type="button" class="btn btn-sm btn-outlined" data-action="retry-load">再試行</button>
        </div>
      `);
    }

    container.innerHTML = banners.join('');
    container.querySelectorAll('[data-action="recover-db"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const res = await apiRequest('POST', '/api/system/recover-db');
          showToast(`破損DBを退避しました (${res.archivedCorruptFile || '退避完了'})`, 'success');
          await loadAllData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
    container.querySelectorAll('[data-action="open-profile"]').forEach((btn) => {
      btn.addEventListener('click', (e) => openCareerProfileModal(e.currentTarget));
    });
    container.querySelectorAll('[data-action="retry-load"]').forEach((btn) => {
      btn.addEventListener('click', () => loadAllData());
    });
  }

  function renderMetrics() {
    const container = document.getElementById('metrics-section');
    if (!container) return;
    const m = computeMetrics(state.companies, state.events, Date.now());
    const upcomingCount = Array.isArray(m.upcoming7Days) ? m.upcoming7Days.length : 0;

    container.innerHTML = `
      <article class="metric-card">
        <span class="metric-label">登録企業数</span>
        <div class="metric-value-row">
          <span class="metric-value tabular-nums">${m.total}</span>
          <span class="metric-unit">社</span>
        </div>
        <span class="metric-sub">全選考ステータス合計</span>
      </article>
      <article class="metric-card">
        <span class="metric-label">書類・ES通過数</span>
        <div class="metric-value-row">
          <span class="metric-value tabular-nums">${m.passedDocs}</span>
          <span class="metric-unit">社 (${m.passedDocsRate}%)</span>
        </div>
        <span class="metric-sub">ES通過・面接・最終・内定</span>
      </article>
      <article class="metric-card">
        <span class="metric-label">面接進行中</span>
        <div class="metric-value-row">
          <span class="metric-value tabular-nums">${m.interviewing}</span>
          <span class="metric-unit">社</span>
        </div>
        <span class="metric-sub">一次〜最終面接フェーズ</span>
      </article>
      <article class="metric-card is-highlight">
        <span class="metric-label">内定獲得数</span>
        <div class="metric-value-row">
          <span class="metric-value tabular-nums">${m.offers}</span>
          <span class="metric-unit">社</span>
        </div>
        <span class="metric-sub">内定・オファー承諾検討</span>
      </article>
      <article class="metric-card ${upcomingCount > 0 ? 'is-urgent' : ''}">
        <span class="metric-label">直近7日の予定・締切</span>
        <div class="metric-value-row">
          <span class="metric-value tabular-nums">${upcomingCount}</span>
          <span class="metric-unit">件</span>
        </div>
        <span class="metric-sub">${upcomingCount > 0 ? escapeHtml(m.upcoming7Days[0].title) : '直近7日の未完了予定なし'}</span>
      </article>
    `;
  }

  function renderActiveView() {
    const container = document.getElementById('view-container');
    if (!container) return;
    const restoreKanbanFocus = Boolean(kanbanExpansion?.panel.contains(document.activeElement));
    if (kanbanExpansion) window.removeEventListener('resize', kanbanExpansion.position);
    kanbanExpansion?.animation?.cancel();
    kanbanExpansion?.panel.remove();
    kanbanExpansion = null;
    if (state.activeView !== 'kanban') state.focusedKanbanLane = null;

    if (state.loading) {
      container.innerHTML = `
        <div class="panel" style="text-align:center;padding:32px">
          <p style="font-weight:700;margin:0">データを読み込んでいます...</p>
        </div>
      `;
      return;
    }

    if (state.activeView === 'kanban') {
      renderKanbanView(container);
      if (state.focusedKanbanLane) expandKanbanLane(state.focusedKanbanLane, false, restoreKanbanFocus);
    } else if (state.activeView === 'table') {
      renderTableView(container);
    } else if (state.activeView === 'schedule') {
      renderScheduleView(container);
    } else if (state.activeView === 'compensation') {
      renderCompensationView(container);
    }
  }

  function getCompanyNextEvent(companyId) {
    const companyEvents = state.events.filter((e) => e.companyId === companyId);
    return nextEvent(companyEvents, Date.now());
  }

  function renderKanbanView(container) {
    if (state.companies.length === 0) {
      container.innerHTML = `
        <div class="panel" style="text-align:center;padding:36px 20px">
          <h2 style="margin:0 0 8px;font-size:1.15rem">まだ企業が登録されていません</h2>
          <p style="margin:0 0 18px;color:var(--m3-on-surface-variant);font-size:0.88rem">
            「企業を手動追加」または「AI / プロンプトで追加」から志望企業を登録して選考管理を始めましょう。
          </p>
          <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap">
            <button type="button" class="btn btn-primary" data-empty-add="manual">＋ 企業を手動追加</button>
            <button type="button" class="btn btn-tonal" data-empty-add="prompt">✦ AI / プロンプトで追加</button>
          </div>
        </div>
      `;
      container.querySelector('[data-empty-add="manual"]')?.addEventListener('click', (e) => openManualAddModal(e.currentTarget));
      container.querySelector('[data-empty-add="prompt"]')?.addEventListener('click', (e) => openPromptAddModal(e.currentTarget));
      return;
    }

    const lanes = getKanbanLanes(state.companies);
    container.innerHTML = `
      <div class="kanban-board" role="region" aria-label="選考ステータス一覧">
        ${lanes
          .map(
            (lane) => `
          <section class="kanban-lane ${lane.isEarlyLane ? 'lane-early' : ''}" data-lane-key="${escapeHtml(lane.key)}" aria-label="${escapeHtml(lane.label)}レーン">
            <h2 class="lane-heading">
            <button type="button" class="lane-header lane-expand" aria-expanded="false" aria-label="${escapeHtml(lane.label)}の企業一覧を拡大">
              <span class="lane-title-group">
                <span class="lane-title">${escapeHtml(lane.label)}</span>
              </span>
              <span class="lane-count tabular-nums">${lane.companies.length}</span>
              <span class="lane-expand-icon" aria-hidden="true">⤢</span>
            </button>
            </h2>
            <div class="lane-cards" tabindex="0" role="region" aria-label="${escapeHtml(lane.label)}の企業一覧">
              ${
                lane.companies.length === 0
                  ? `<div class="lane-empty">該当企業なし</div>`
                  : lane.companies.map((company) => renderKanbanCard(company, lane)).join('')
              }
            </div>
          </section>
        `
          )
          .join('')}
      </div>
    `;

    bindCardActions(container);
    container.querySelectorAll('[data-lane-key]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, select, textarea') && !e.target.closest('.lane-expand')) return;
        if (!window.getSelection()?.isCollapsed) return;
        expandKanbanLane(el.dataset.laneKey);
      });
    });
  }

  function expandKanbanLane(key, animate = true, focus = true) {
    if (kanbanExpansion) return;
    const lane = getKanbanLanes(state.companies).find((item) => item.key === key);
    const board = document.querySelector('.kanban-board');
    const source = board?.querySelector(`[data-lane-key="${key}"]`);
    if (!lane || !source) { state.focusedKanbanLane = null; return; }
    state.focusedKanbanLane = key;
    const panel = document.createElement('section');
    panel.className = `kanban-expanded kanban-lane ${lane.isEarlyLane ? 'lane-early' : ''}`;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', `${lane.label}の企業一覧（拡大表示）`);
    panel.innerHTML = `
      <div class="kanban-expanded-header">
        <button type="button" class="btn btn-outlined" data-collapse-lane>← 戻る</button>
        <h2 class="lane-title">${escapeHtml(lane.label)} <span class="lane-count tabular-nums">${lane.companies.length}社</span></h2>
      </div>
      <div class="lane-cards expanded-cards" tabindex="0" role="region" aria-label="${escapeHtml(lane.label)}の企業一覧">
        ${lane.companies.length ? lane.companies.map((company) => renderKanbanCard(company, lane)).join('') : '<div class="lane-empty">該当企業なし</div>'}
      </div>`;
    document.getElementById('view-container').append(panel);
    const position = () => {
      const rect = document.getElementById('view-container').getBoundingClientRect();
      const inset = document.documentElement.classList.contains('native-macos') ? 32 : 8;
      panel.style.top = `${Math.max(inset, Math.min(rect.top, window.innerHeight - 280))}px`;
      panel.style.left = `${Math.max(8, rect.left + 3)}px`;
      panel.style.width = `${Math.min(rect.width - 6, window.innerWidth - 16)}px`;
      if (kanbanExpansion?.panel === panel) {
        kanbanExpansion.animation?.cancel();
        kanbanExpansion.animation = null;
        if (kanbanExpansion.closing) {
          kanbanExpansion.closing = false;
          collapseKanbanLane();
        }
      }
    };
    position();
    window.addEventListener('resize', position);
    const trigger = source.querySelector('.lane-expand');
    trigger.setAttribute('aria-expanded', 'true');
    board.inert = true;
    source.style.visibility = 'hidden';
    board.classList.add('has-expanded-lane');
    const expansion = { panel, board, source, trigger, position, animation: null, closing: false };
    kanbanExpansion = expansion;
    bindCardActions(panel);
    panel.querySelector('[data-collapse-lane]').addEventListener('click', collapseKanbanLane);
    if (focus) panel.querySelector('[data-collapse-lane]').focus({ preventScroll: true });
    if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const from = source.getBoundingClientRect(), to = panel.getBoundingClientRect();
      expansion.animation = panel.animate([
        { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, padding: '12px' },
        { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`, padding: '16px' },
      ], { duration: 250, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'both' });
    }
  }

  function collapseKanbanLane() {
    const expansion = kanbanExpansion;
    if (!expansion || expansion.closing) return;
    expansion.closing = true;
    const finish = () => {
      if (kanbanExpansion !== expansion) return;
      window.removeEventListener('resize', expansion.position);
      expansion.animation?.cancel();
      expansion.panel.remove();
      expansion.board.inert = false;
      expansion.source.style.visibility = '';
      expansion.board.classList.remove('has-expanded-lane');
      expansion.trigger.setAttribute('aria-expanded', 'false');
      state.focusedKanbanLane = null;
      kanbanExpansion = null;
      expansion.trigger.focus({ preventScroll: true });
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
    // Start at the currently visible bounds, including when opening is interrupted.
    // A separate short close avoids reversing the slow tail of the opening easing.
    const from = expansion.panel.getBoundingClientRect(), to = expansion.source.getBoundingClientRect();
    expansion.animation?.cancel();
    expansion.animation = expansion.panel.animate([
      { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, padding: '16px' },
      { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`, padding: '12px' },
    ], { duration: 150, easing: 'cubic-bezier(0.2, 0.6, 0.4, 1)', fill: 'both' });
    expansion.animation.finished.then(finish, () => {});
  }

  function renderKanbanCard(company, lane) {
    const meta = STATUS_META[company.status] || { label: company.status, symbol: '•' };
    const nextEv = getCompanyNextEvent(company.id);
    const prevStatus = getAdjacentStatus(company.status, 'prev');
    const nextStatus = getAdjacentStatus(company.status, 'next');

    const badges = [];
    if (company.isEarlySelection) {
      badges.push(`<span class="chip chip-early">早期選考</span>`);
    }
    if (lane.isEarlyLane) {
      badges.push(`<span class="chip">${escapeHtml(meta.symbol)} 現在: ${escapeHtml(meta.label)}</span>`);
    }
    if (company.status === 'FINAL') {
      badges.push(`<span class="chip chip-final">★ 最終面接</span>`);
    }
    if (company.status === 'OFFER') {
      badges.push(`<span class="chip chip-offer">✓ 内定</span>`);
    }

    return `
      <article class="company-card" data-company-id="${escapeHtml(company.id)}">
        <div class="card-top">
          <h3 class="card-company-name"><button type="button" class="card-detail-trigger" data-open-detail="${escapeHtml(company.id)}" aria-label="${escapeHtml(company.name)}の詳細を開く">${escapeHtml(company.name)}</button></h3>
          <span class="priority-stars" title="志望度 ${escapeHtml(company.priority)}/5">
            ${escapeHtml(formatPriorityStars(company.priority))} (${escapeHtml(company.priority)}/5)
          </span>
        </div>
        ${badges.length > 0 ? `<div class="card-badges">${badges.join('')}</div>` : ''}
        <div class="card-meta">
          ${company.industry ? `<span>業種: ${escapeHtml(company.industry)}</span>` : ''}
          ${company.location ? `<span>拠点: ${escapeHtml(company.location)}</span>` : ''}
          ${
            company.annualIncome !== null && company.annualIncome !== undefined
              ? `<span class="tabular-nums">想定年収: <strong>${escapeHtml(company.annualIncome)}万円</strong></span>`
              : ''
          }
        </div>
        ${
          nextEv
            ? `<div class="card-next-event tabular-nums">📅 次回: ${escapeHtml(nextEv.title)} (${escapeHtml(formatDisplayDateTime(nextEv.startAt))})</div>`
            : ''
        }
        <div class="card-actions">
          <div style="display:flex;gap:4px">
            <button type="button" class="btn btn-xs btn-outlined" data-move-company="${escapeHtml(company.id)}" data-move-status="${escapeHtml(prevStatus || '')}" ${!prevStatus ? 'disabled' : ''} title="前の選考ステータスへ戻す">
              ◀ 前へ
            </button>
            <button type="button" class="btn btn-xs btn-outlined" data-move-company="${escapeHtml(company.id)}" data-move-status="${escapeHtml(nextStatus || '')}" ${!nextStatus ? 'disabled' : ''} title="次の選考ステータスへ進める">
              次へ ▶
            </button>
          </div>
          <div style="display:flex;gap:4px">
            ${
              company.myPageUrl
                ? `<button type="button" class="btn btn-xs btn-ghost" data-open-url="${escapeHtml(company.myPageUrl)}" title="マイページを外部ブラウザで開く">マイページ ↗</button>`
                : ''
            }
          </div>
        </div>
      </article>
    `;
  }

  function bindCardActions(container) {
    container.querySelectorAll('[data-move-company]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const companyId = btn.getAttribute('data-move-company');
        const nextStatus = btn.getAttribute('data-move-status');
        if (!companyId || !nextStatus) return;
        const doMove = async () => {
          try {
            btn.disabled = true;
            await apiRequest('PATCH', `/api/companies/${encodeURIComponent(companyId)}`, {
              status: nextStatus,
            });
            await loadAllData();
            showToast(`ステータスを「${STATUS_META[nextStatus]?.label || nextStatus}」に更新しました`, 'success');
          } catch (err) {
            btn.disabled = false;
            showToast(err.message, 'error', doMove);
          }
        };
        await doMove();
      });
    });

    container.querySelectorAll('[data-open-url]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-open-url');
        if (url) openSafeExternalUrl(url);
      });
    });

    container.querySelectorAll('[data-open-detail]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const companyId = btn.getAttribute('data-open-detail');
        const tab = btn.getAttribute('data-detail-tab') || 'steps';
        if (companyId) openCompanyDetailModal(companyId, e.currentTarget, tab);
      });
    });
  }

  function renderTableView(container) {
    const q = state.tableFilter.query.trim().toLowerCase();
    const filtered = state.companies.filter((c) => {
      if (state.tableFilter.status !== 'ALL' && c.status !== state.tableFilter.status) return false;
      if (state.tableFilter.earlyOnly && !c.isEarlySelection) return false;
      if (!q) return true;
      return (
        (c.name || '').toLowerCase().includes(q) ||
        (c.industry || '').toLowerCase().includes(q) ||
        (c.jobType || '').toLowerCase().includes(q) ||
        (c.location || '').toLowerCase().includes(q) ||
        (c.memo || '').toLowerCase().includes(q)
      );
    });

    container.innerHTML = `
      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">登録企業一覧 (${filtered.length} / ${state.companies.length}社)</h2>
        </div>
        <div class="filter-bar">
          <input type="search" id="table-search-input" class="input" style="max-width:280px" placeholder="企業名・業界・職種・拠点・メモで検索" value="${escapeHtml(state.tableFilter.query)}" aria-label="企業検索">
          <select id="table-status-select" class="select" style="max-width:190px" aria-label="ステータス絞り込み">
            <option value="ALL" ${state.tableFilter.status === 'ALL' ? 'selected' : ''}>すべてのステータス</option>
            ${SELECTION_STATUSES.map((st) => {
              const meta = STATUS_META[st] || { label: st };
              return `<option value="${escapeHtml(st)}" ${state.tableFilter.status === st ? 'selected' : ''}>${escapeHtml(meta.label)}</option>`;
            }).join('')}
          </select>
          <label class="checkbox-row">
            <input type="checkbox" id="table-early-check" ${state.tableFilter.earlyOnly ? 'checked' : ''}>
            <span>早期選考のみ表示</span>
          </label>
        </div>

        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>企業名</th>
                <th>選考ステータス</th>
                <th>志望度</th>
                <th>業界・職種・所在地</th>
                <th>想定年収 (単位: 万円)</th>
                <th>次回予定</th>
                <th>マイページ / 公式</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${
                filtered.length === 0
                  ? `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--m3-on-surface-variant)">条件に一致する企業がありません。</td></tr>`
                  : filtered
                      .map((c) => {
                        const meta = STATUS_META[c.status] || { label: c.status, symbol: '•' };
                        const nextEv = getCompanyNextEvent(c.id);
                        return `
                          <tr>
                            <td><strong>${escapeHtml(c.name)}</strong></td>
                            <td>
                              <span class="chip ${c.status === 'FINAL' ? 'chip-final' : c.status === 'OFFER' ? 'chip-offer' : ''}">
                                ${escapeHtml(meta.symbol)} ${escapeHtml(meta.label)}
                              </span>
                              ${c.isEarlySelection ? `<span class="chip chip-early">早期選考</span>` : ''}
                            </td>
                            <td><span class="priority-stars">${escapeHtml(formatPriorityStars(c.priority))} (${escapeHtml(c.priority)}/5)</span></td>
                            <td>${escapeHtml([c.industry, c.jobType, c.location].filter(Boolean).join(' / ') || '—')}</td>
                            <td class="tabular-nums">${c.annualIncome !== null && c.annualIncome !== undefined ? `${escapeHtml(c.annualIncome)}万円` : '未確認'}</td>
                            <td class="tabular-nums">${nextEv ? `${escapeHtml(nextEv.title)} (${escapeHtml(formatDisplayDateTime(nextEv.startAt))})` : '—'}</td>
                            <td>
                              <div style="display:flex;gap:4px;flex-wrap:wrap">
                                ${
                                  c.myPageUrl
                                    ? `<button type="button" class="btn btn-xs btn-outlined" data-open-url="${escapeHtml(c.myPageUrl)}">マイページ ↗</button>`
                                    : ''
                                }
                                ${
                                  c.websiteUrl
                                    ? `<button type="button" class="btn btn-xs btn-ghost" data-open-url="${escapeHtml(c.websiteUrl)}">公式 ↗</button>`
                                    : ''
                                }
                                ${!c.myPageUrl && !c.websiteUrl ? '—' : ''}
                              </div>
                            </td>
                            <td>
                              <button type="button" class="btn btn-xs btn-tonal" data-open-detail="${escapeHtml(c.id)}">詳細・編集</button>
                            </td>
                          </tr>
                        `;
                      })
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#table-search-input')?.addEventListener('input', (e) => {
      state.tableFilter.query = e.target.value;
      renderTableView(container);
      const input = container.querySelector('#table-search-input');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
    container.querySelector('#table-status-select')?.addEventListener('change', (e) => {
      state.tableFilter.status = e.target.value;
      renderTableView(container);
    });
    container.querySelector('#table-early-check')?.addEventListener('change', (e) => {
      state.tableFilter.earlyOnly = e.target.checked;
      renderTableView(container);
    });
    bindCardActions(container);
  }

  function renderScheduleView(container) {
    const filteredEvents = state.events.filter((ev) => {
      if (state.scheduleFilter.undoneOnly && ev.isDone) return false;
      if (state.scheduleFilter.companyId !== 'ALL') {
        if (state.scheduleFilter.companyId === 'NONE' && ev.companyId) return false;
        if (state.scheduleFilter.companyId !== 'NONE' && ev.companyId !== state.scheduleFilter.companyId) return false;
      }
      return true;
    });

    const defaultStart = localDateTime(new Date(Date.now() + 3600 * 1000).toISOString());

    container.innerHTML = `
      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">新規予定・締切の登録（企業横断・企業未指定イベント対応）</h2>
        </div>
        <form id="schedule-add-form" class="form-grid">
          <div class="form-field">
            <label class="form-label" for="ev-title">予定タイトル *</label>
            <input type="text" id="ev-title" name="title" class="input" required placeholder="例: 一次面接 / ES提出締切">
          </div>
          <div class="form-field">
            <label class="form-label" for="ev-company">対象企業（任意）</label>
            <select id="ev-company" name="companyId" class="select">
              <option value="">企業未指定（合同説明会・共通タスクなど）</option>
              ${state.companies
                .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
                .join('')}
            </select>
          </div>
          <div class="form-field">
            <label class="form-label" for="ev-step">関連する選考ステップ（任意）</label>
            <select id="ev-step" name="stepId" class="select" disabled>
              <option value="">関連ステップなし（対象企業を選択すると選べます）</option>
            </select>
          </div>
          <div class="form-field">
            <label class="form-label" for="ev-type">種別</label>
            <select id="ev-type" name="eventType" class="select">
              ${EVENT_TYPES.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(EVENT_LABELS[t] || t)}</option>`).join('')}
            </select>
          </div>
          <div class="form-field">
            <label class="form-label" for="ev-start">開始日時 *</label>
            <input type="datetime-local" id="ev-start" name="startAt" class="input tabular-nums" required value="${escapeHtml(defaultStart)}">
          </div>
          <div class="form-field">
            <label class="form-label" for="ev-end">終了日時（未指定時はカレンダー出力時に1時間後で自動補完）</label>
            <input type="datetime-local" id="ev-end" name="endAt" class="input tabular-nums">
          </div>
          <div class="form-field">
            <label class="form-label" for="ev-location">開催場所 / URL</label>
            <input type="text" id="ev-location" name="location" class="input" placeholder="例: オンライン (Zoom) / 東京本社">
          </div>
          <div class="form-field">
            <label class="form-label" for="ev-memo">メモ・準備事項</label>
            <input type="text" id="ev-memo" name="memo" class="input" placeholder="例: 服装自由・学生証持参">
          </div>
          <div class="form-field">
            <label class="checkbox-row">
              <input type="checkbox" id="ev-all-day" name="allDay">
              <span>終日イベントとして記録する</span>
            </label>
          </div>
          <div class="form-field" style="display:flex;justify-content:flex-end;align-items:center">
            <button type="submit" class="btn btn-primary">＋ 予定を登録</button>
          </div>
        </form>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">登録済みスケジュール一覧 (${filteredEvents.length}件)</h2>
        </div>
        <div class="filter-bar">
          <select id="sched-company-filter" class="select" style="max-width:240px" aria-label="企業で絞り込み">
            <option value="ALL" ${state.scheduleFilter.companyId === 'ALL' ? 'selected' : ''}>すべての予定（企業未指定含む）</option>
            <option value="NONE" ${state.scheduleFilter.companyId === 'NONE' ? 'selected' : ''}>企業未指定の予定のみ</option>
            ${state.companies
              .map(
                (c) =>
                  `<option value="${escapeHtml(c.id)}" ${state.scheduleFilter.companyId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
              )
              .join('')}
          </select>
          <label class="checkbox-row">
            <input type="checkbox" id="sched-undone-filter" ${state.scheduleFilter.undoneOnly ? 'checked' : ''}>
            <span>未完了の予定のみ表示</span>
          </label>
        </div>

        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>状態</th>
                <th>日時</th>
                <th>種別</th>
                <th>予定タイトル</th>
                <th>企業名 / 関連ステップ</th>
                <th>場所・メモ</th>
                <th>外部カレンダー / 操作</th>
              </tr>
            </thead>
            <tbody>
              ${
                filteredEvents.length === 0
                  ? `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--m3-on-surface-variant)">予定が登録されていません。</td></tr>`
                  : filteredEvents
                      .map((ev) => {
                        const typeLabel = EVENT_LABELS[ev.eventType] || ev.eventType;
                        return `
                          <tr style="${ev.isDone ? 'opacity:0.65' : ''}">
                            <td>
                              <button type="button" class="btn btn-xs ${ev.isDone ? 'btn-secondary' : 'btn-outlined'}" data-toggle-event="${escapeHtml(ev.id)}" data-done="${ev.isDone ? '0' : '1'}">
                                ${ev.isDone ? '✓ 完了済' : '未完了'}
                              </button>
                            </td>
                            <td class="tabular-nums">
                              <div>
                                <strong>${escapeHtml(formatDisplayDateTime(ev.startAt))}</strong>
                                ${ev.allDay ? `<span class="chip" style="margin-left:4px">終日</span>` : ''}
                              </div>
                              ${ev.endAt ? `<div style="font-size:0.74rem;color:var(--m3-on-surface-variant)">〜 ${escapeHtml(formatDisplayDateTime(ev.endAt))}</div>` : ''}
                            </td>
                            <td><span class="chip">${escapeHtml(typeLabel)}</span></td>
                            <td><strong>${escapeHtml(ev.title)}</strong></td>
                            <td>
                              <div>${escapeHtml(ev.company?.name || '企業未指定')}</div>
                              ${ev.stepName ? `<div style="font-size:0.74rem;color:var(--m3-on-surface-variant)">ステップ: ${escapeHtml(ev.stepName)}</div>` : ''}
                            </td>
                            <td>
                              ${ev.location ? `<div>📍 ${escapeHtml(ev.location)}</div>` : ''}
                              ${ev.memo ? `<div style="font-size:0.76rem;color:var(--m3-on-surface-variant)">${escapeHtml(ev.memo)}</div>` : ''}
                            </td>
                            <td>
                              <div style="display:flex;gap:4px;flex-wrap:wrap">
                                <button type="button" class="btn btn-xs btn-tonal" data-calendar-preview="${escapeHtml(ev.id)}">
                                  カレンダー出力
                                </button>
                                <button type="button" class="btn btn-xs btn-outlined" data-edit-event="${escapeHtml(ev.id)}">
                                  編集
                                </button>
                                <button type="button" class="btn btn-xs btn-danger" data-delete-event="${escapeHtml(ev.id)}">
                                  削除
                                </button>
                              </div>
                            </td>
                          </tr>
                        `;
                      })
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </div>
    `;

    const companySelect = container.querySelector('#ev-company');
    const stepSelect = container.querySelector('#ev-step');
    companySelect?.addEventListener('change', () => {
      const cid = companySelect.value;
      const comp = state.companies.find((c) => c.id === cid);
      if (!comp || !Array.isArray(comp.steps) || comp.steps.length === 0) {
        stepSelect.disabled = true;
        stepSelect.innerHTML = `<option value="">関連ステップなし</option>`;
      } else {
        stepSelect.disabled = false;
        stepSelect.innerHTML =
          `<option value="">関連ステップなし</option>` +
          comp.steps
            .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.stepName)}</option>`)
            .join('');
      }
    });

    container.querySelector('#schedule-add-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const startIso = toIsoWithLocalOffset(form.startAt.value);
      const endIso = form.endAt.value ? toIsoWithLocalOffset(form.endAt.value) : null;
      if (!startIso) {
        showToast('開始日時を正しく入力してください。', 'error');
        return;
      }
      const submitEvent = async () => {
        try {
          await apiRequest('POST', '/api/events', {
            companyId: form.companyId.value || null,
            stepId: form.stepId && form.stepId.value ? form.stepId.value : null,
            title: form.title.value,
            eventType: form.eventType.value,
            startAt: startIso,
            endAt: endIso,
            allDay: Boolean(form.allDay && form.allDay.checked),
            location: form.location.value,
            memo: form.memo.value,
          });
          showToast('予定を登録しました。', 'success');
          await loadAllData();
        } catch (err) {
          showToast(err.message, 'error', submitEvent);
        }
      };
      await submitEvent();
    });

    container.querySelector('#sched-company-filter')?.addEventListener('change', (e) => {
      state.scheduleFilter.companyId = e.target.value;
      renderScheduleView(container);
    });
    container.querySelector('#sched-undone-filter')?.addEventListener('change', (e) => {
      state.scheduleFilter.undoneOnly = e.target.checked;
      renderScheduleView(container);
    });

    container.querySelectorAll('[data-toggle-event]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-toggle-event');
        const nextDone = btn.getAttribute('data-done') === '1';
        try {
          await apiRequest('PATCH', `/api/events/${encodeURIComponent(id)}`, { isDone: nextDone });
          await loadAllData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('[data-edit-event]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = btn.getAttribute('data-edit-event');
        const ev = state.events.find((item) => item.id === id);
        if (ev) openEditEventModal(ev, e.currentTarget);
      });
    });

    container.querySelectorAll('[data-delete-event]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-delete-event');
        try {
          await apiRequest('DELETE', `/api/events/${encodeURIComponent(id)}`);
          showToast('予定を削除しました。', 'info');
          await loadAllData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('[data-calendar-preview]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = btn.getAttribute('data-calendar-preview');
        const ev = state.events.find((item) => item.id === id);
        if (ev) openCalendarPreviewModal(ev, e.currentTarget);
      });
    });
  }

  function openEditEventModal(ev, triggerEl, onSaved = null) {
    const startVal = ev.startAt ? localDateTime(ev.startAt) : '';
    const endVal = ev.endAt ? localDateTime(ev.endAt) : '';

    openModal(
      `
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-ev-title">
        <div class="modal-header">
          <div>
            <h2 id="edit-ev-title" class="modal-title">予定・締切を編集</h2>
            <p class="modal-subtitle">日時・種別・関連企業・選考ステップを更新します</p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-modal-close aria-label="閉じる">✕ 閉じる</button>
        </div>
        <form id="edit-event-form" style="display:contents">
          <div class="modal-body">
            <div class="form-grid">
              <div class="form-field">
                <label class="form-label" for="eev-title">予定タイトル *</label>
                <input type="text" id="eev-title" name="title" class="input" required value="${escapeHtml(ev.title)}">
              </div>
              <div class="form-field">
                <label class="form-label" for="eev-type">種別</label>
                <select id="eev-type" name="eventType" class="select">
                  ${EVENT_TYPES.map((t) => `<option value="${escapeHtml(t)}" ${ev.eventType === t ? 'selected' : ''}>${escapeHtml(EVENT_LABELS[t] || t)}</option>`).join('')}
                </select>
              </div>
              <div class="form-field">
                <label class="form-label" for="eev-company">対象企業（任意）</label>
                <select id="eev-company" name="companyId" class="select">
                  <option value="">企業未指定</option>
                  ${state.companies
                    .map((c) => `<option value="${escapeHtml(c.id)}" ${ev.companyId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
                    .join('')}
                </select>
              </div>
              <div class="form-field">
                <label class="form-label" for="eev-step">関連する選考ステップ（任意）</label>
                <select id="eev-step" name="stepId" class="select"></select>
              </div>
              <div class="form-field">
                <label class="form-label" for="eev-start">開始日時 *</label>
                <input type="datetime-local" id="eev-start" name="startAt" class="input tabular-nums" required value="${escapeHtml(startVal)}">
              </div>
              <div class="form-field">
                <label class="form-label" for="eev-end">終了日時（任意）</label>
                <input type="datetime-local" id="eev-end" name="endAt" class="input tabular-nums" value="${escapeHtml(endVal)}">
              </div>
              <div class="form-field">
                <label class="form-label" for="eev-location">場所 / URL</label>
                <input type="text" id="eev-location" name="location" class="input" value="${escapeHtml(ev.location || '')}">
              </div>
              <div class="form-field">
                <label class="form-label" for="eev-memo">メモ</label>
                <input type="text" id="eev-memo" name="memo" class="input" value="${escapeHtml(ev.memo || '')}">
              </div>
              <div class="form-field">
                <label class="checkbox-row">
                  <input type="checkbox" name="allDay" ${ev.allDay ? 'checked' : ''}>
                  <span>終日イベント</span>
                </label>
              </div>
              <div class="form-field">
                <label class="checkbox-row">
                  <input type="checkbox" name="isDone" ${ev.isDone ? 'checked' : ''}>
                  <span>完了済みにする</span>
                </label>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outlined" data-modal-close>キャンセル</button>
            <button type="submit" id="eev-submit-btn" class="btn btn-primary">変更を保存</button>
          </div>
        </form>
      </div>
      `,
      triggerEl,
      (root) => {
        const compSel = root.querySelector('#eev-company');
        const stepSel = root.querySelector('#eev-step');
        const populateSteps = (selectedStepId) => {
          const cid = compSel.value;
          const comp = state.companies.find((c) => c.id === cid);
          if (!comp || !Array.isArray(comp.steps) || comp.steps.length === 0) {
            stepSel.disabled = true;
            stepSel.innerHTML = `<option value="">関連ステップなし</option>`;
          } else {
            stepSel.disabled = false;
            stepSel.innerHTML =
              `<option value="">関連ステップなし</option>` +
              comp.steps
                .map(
                  (s) =>
                    `<option value="${escapeHtml(s.id)}" ${s.id === selectedStepId ? 'selected' : ''}>${escapeHtml(s.stepName)}</option>`
                )
                .join('');
          }
        };
        populateSteps(ev.stepId);
        compSel?.addEventListener('change', () => populateSteps(null));

        const form = root.querySelector('#edit-event-form');
        form?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = root.querySelector('#eev-submit-btn');
          const startIso = toIsoWithLocalOffset(form.startAt.value);
          const endIso = form.endAt.value ? toIsoWithLocalOffset(form.endAt.value) : null;
          if (!startIso) {
            showToast('開始日時を正しく入力してください。', 'error');
            return;
          }
          try {
            if (btn) btn.disabled = true;
            await apiRequest('PATCH', `/api/events/${encodeURIComponent(ev.id)}`, {
              title: form.title.value,
              eventType: form.eventType.value,
              companyId: form.companyId.value || null,
              stepId: form.stepId.value || null,
              startAt: startIso,
              endAt: endIso,
              allDay: form.allDay.checked,
              isDone: form.isDone.checked,
              location: form.location.value,
              memo: form.memo.value,
            });
            state.modalDirty = false;
            requestCloseModal(true);
            await loadAllData();
            if (typeof onSaved === 'function') await onSaved();
            showToast('予定を更新しました。', 'success');
          } catch (err) {
            if (btn) btn.disabled = false;
            showToast(err.message, 'error');
          }
        });
      }
    );
  }

  function renderCompensationView(container) {
    const sorted = sortCompaniesByCompensation(
      state.companies,
      state.compensationSortKey,
      state.compensationSortDir
    );
    const validIncomes = state.companies
      .map((c) => c.annualIncome)
      .filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
    const maxIncome = validIncomes.length > 0 ? Math.max(...validIncomes) : null;

    container.innerHTML = `
      <div class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">企業別・待遇比較一覧</h2>
            <p style="margin:4px 0 0;font-size:0.78rem;color:var(--m3-on-surface-variant)">
              ※単位明記: 想定年収＝<strong>万円</strong> / 初任給＝<strong>円(月額)</strong> / 賞与＝<strong>回・ヶ月</strong> / 年間休日＝<strong>日</strong>。未確認（未入力）は0と区別して末尾に配置します。
            </p>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <label for="comp-sort-select" style="font-size:0.8rem;font-weight:700">並び順:</label>
            <select id="comp-sort-select" class="select" style="width:auto">
              <option value="annualIncome:desc" ${state.compensationSortKey === 'annualIncome' && state.compensationSortDir === 'desc' ? 'selected' : ''}>想定年収の高い順（未確認は末尾）</option>
              <option value="annualIncome:asc" ${state.compensationSortKey === 'annualIncome' && state.compensationSortDir === 'asc' ? 'selected' : ''}>想定年収の低い順（未確認は末尾）</option>
              <option value="startingSalary:desc" ${state.compensationSortKey === 'startingSalary' && state.compensationSortDir === 'desc' ? 'selected' : ''}>初任給の高い順</option>
              <option value="annualHolidays:desc" ${state.compensationSortKey === 'annualHolidays' && state.compensationSortDir === 'desc' ? 'selected' : ''}>年間休日の多い順</option>
              <option value="ratingSalary:desc" ${state.compensationSortKey === 'ratingSalary' && state.compensationSortDir === 'desc' ? 'selected' : ''}>給与評価の高い順</option>
              <option value="ratingBenefits:desc" ${state.compensationSortKey === 'ratingBenefits' && state.compensationSortDir === 'desc' ? 'selected' : ''}>福利厚生評価の高い順</option>
              <option value="priority:desc" ${state.compensationSortKey === 'priority' ? 'selected' : ''}>志望度の高い順</option>
              <option value="name:asc" ${state.compensationSortKey === 'name' ? 'selected' : ''}>企業名順</option>
            </select>
          </div>
        </div>

        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>企業名</th>
                <th>ステータス</th>
                <th>志望度</th>
                <th>想定年収 (万円)</th>
                <th>初任給 (月額・円)</th>
                <th>賞与 (回数 / 月数)</th>
                <th>みなし残業 / 給与メモ</th>
                <th>年間休日 (日)</th>
                <th>住宅手当・リモート</th>
                <th>評価 (給与 / 福利)</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${
                sorted.length === 0
                  ? `<tr><td colspan="11" style="text-align:center;padding:24px;color:var(--m3-on-surface-variant)">登録企業がありません。</td></tr>`
                  : sorted
                      .map((c) => {
                        const isMax = maxIncome !== null && c.annualIncome === maxIncome;
                        const meta = STATUS_META[c.status] || { label: c.status, symbol: '•' };
                        return `
                          <tr>
                            <td><strong>${escapeHtml(c.name)}</strong></td>
                            <td><span class="chip">${escapeHtml(meta.symbol)} ${escapeHtml(meta.label)}</span></td>
                            <td><span class="priority-stars">${escapeHtml(formatPriorityStars(c.priority))} (${escapeHtml(c.priority)}/5)</span></td>
                            <td class="tabular-nums">
                              ${
                                c.annualIncome !== null && c.annualIncome !== undefined
                                  ? `<strong>${escapeHtml(c.annualIncome)}万円</strong> ${isMax ? `<span class="chip chip-offer">最高水準</span>` : ''}`
                                  : '<span style="color:var(--m3-on-surface-variant)">未確認</span>'
                              }
                            </td>
                            <td class="tabular-nums">
                              ${c.startingSalary !== null && c.startingSalary !== undefined ? `${Number(c.startingSalary).toLocaleString('ja-JP')}円` : '未確認'}
                            </td>
                            <td class="tabular-nums">
                              ${
                                c.bonusTimes !== null || c.bonusMonths !== null
                                  ? `${c.bonusTimes !== null && c.bonusTimes !== undefined ? `年${escapeHtml(c.bonusTimes)}回` : '—'} / ${c.bonusMonths !== null && c.bonusMonths !== undefined ? `${escapeHtml(c.bonusMonths)}ヶ月` : '—'}`
                                  : '未確認'
                              }
                            </td>
                            <td>
                              <div>${escapeHtml(c.fixedOvertime || '未確認')}</div>
                              ${c.salary ? `<div style="font-size:0.74rem;color:var(--m3-on-surface-variant)">${escapeHtml(c.salary)}</div>` : ''}
                            </td>
                            <td class="tabular-nums">${c.annualHolidays !== null && c.annualHolidays !== undefined ? `${escapeHtml(c.annualHolidays)}日` : '未確認'}</td>
                            <td>
                              <div>住宅: ${escapeHtml(c.housingAllowance || '未確認')}</div>
                              <div style="font-size:0.74rem;color:var(--m3-on-surface-variant)">リモート: ${escapeHtml(c.remoteWork || '未確認')}</div>
                            </td>
                            <td class="tabular-nums">
                              <div>給: ${c.ratingSalary > 0 ? `${escapeHtml(c.ratingSalary)}/5` : '未評価'}</div>
                              <div style="font-size:0.74rem;color:var(--m3-on-surface-variant)">福: ${c.ratingBenefits > 0 ? `${escapeHtml(c.ratingBenefits)}/5` : '未評価'}</div>
                            </td>
                            <td>
                              <button type="button" class="btn btn-xs btn-tonal" data-open-detail="${escapeHtml(c.id)}" data-detail-tab="compensation">
                                編集
                              </button>
                            </td>
                          </tr>
                        `;
                      })
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#comp-sort-select')?.addEventListener('change', (e) => {
      const [key, dir] = e.target.value.split(':');
      state.compensationSortKey = key;
      state.compensationSortDir = dir || 'desc';
      renderCompensationView(container);
    });

    bindCardActions(container);
  }

  // Modal System
  function openModal(htmlContent, triggerElement, onMount) {
    const root = document.getElementById('modal-root');
    if (!root) return;
    state.lastFocusElement = triggerElement || document.activeElement;
    state.modalDirty = false;
    root.innerHTML = htmlContent;
    root.classList.remove('is-hidden');
    root.setAttribute('aria-hidden', 'false');
    state.activeModal = root;

    root.querySelectorAll('input:not([type="file"]):not([data-no-dirty]), textarea:not([data-no-dirty]), select:not([data-no-dirty])').forEach((el) => {
      el.addEventListener('input', () => {
        state.modalDirty = true;
      });
    });

    root.querySelectorAll('[data-modal-close]').forEach((btn) => {
      btn.addEventListener('click', () => requestCloseModal());
    });

    root.onclick = (e) => { if (e.target === root) requestCloseModal(); };

    if (typeof onMount === 'function') {
      onMount(root);
    }

    const firstFocusable =
      root.querySelector('input:not([type="hidden"]), select, textarea, button:not([data-modal-close])') ||
      root.querySelector('button');
    if (firstFocusable) {
      firstFocusable.focus();
    }
  }

  function requestCloseModal(force = false) {
    if (!state.activeModal) return true;
    if (!force && state.modalDirty) {
      const ok = window.confirm('入力中の未保存の内容があります。破棄して閉じてもよろしいですか？');
      if (!ok) return false;
    }
    const root = document.getElementById('modal-root');
    const returnToParent = state.modalReturn;
    state.modalReturn = null;
    if (root) {
      root.dispatchEvent(new Event('jt-modal-close'));
      root.classList.add('is-hidden');
      root.setAttribute('aria-hidden', 'true');
      root.innerHTML = '';
    }
    state.activeModal = null;
    state.modalDirty = false;
    if (returnToParent) {
      returnToParent();
    } else if (state.lastFocusElement && typeof state.lastFocusElement.focus === 'function') {
      state.lastFocusElement.focus();
    }
    return true;
  }

  function openCalendarPreviewModal(ev, triggerEl) {
    const preview = previewCalendarExport(ev);
    openModal(
      `
      <div class="modal-dialog modal-sm" role="dialog" aria-modal="true" aria-labelledby="cal-modal-title">
        <div class="modal-header">
          <div>
            <h2 id="cal-modal-title" class="modal-title">外部カレンダー出力プレビュー</h2>
            <p class="modal-subtitle">外部サービスへ送信・保存する前に出力項目を確認してください</p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-modal-close aria-label="閉じる">✕ 閉じる</button>
        </div>
        <div class="modal-body">
          ${
            preview.isOneHourFallback
              ? `<div class="banner banner-warning" style="margin-bottom:12px;font-size:0.8rem"><strong>ℹ 終了時刻の自動補完:</strong> ${escapeHtml(preview.fallbackNotice)}</div>`
              : ''
          }
          <div class="table-scroll">
            <table class="data-table" style="min-width:100%">
              <tbody>
                <tr><th style="width:120px">出力タイトル</th><td><strong>${escapeHtml(preview.title)}</strong></td></tr>
                <tr><th>開始日時</th><td class="tabular-nums">${escapeHtml(formatDisplayDateTime(preview.startAt))}</td></tr>
                <tr><th>終了日時</th><td class="tabular-nums">${escapeHtml(formatDisplayDateTime(preview.endAt))}</td></tr>
                <tr><th>場所</th><td>${escapeHtml(preview.location || '—')}</td></tr>
                <tr><th>詳細説明</th><td style="white-space:pre-wrap">${escapeHtml(preview.details || '—')}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outlined" data-modal-close>キャンセル</button>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" id="btn-export-ics" class="btn btn-tonal">📅 ICSファイルを保存</button>
            <button type="button" id="btn-export-gcal" class="btn btn-primary">Googleカレンダーを開く ↗</button>
          </div>
        </div>
      </div>
      `,
      triggerEl,
      (root) => {
        root.querySelector('#btn-export-ics')?.addEventListener('click', () => {
          const icsContent = calendarFile(ev);
          const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `job-tracker-event-${ev.id}.ics`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          showToast('ICSファイルを保存しました。', 'success');
        });
        root.querySelector('#btn-export-gcal')?.addEventListener('click', () => {
          const gcalUrl = googleCalendarUrl(ev);
          openSafeExternalUrl(gcalUrl);
        });
      }
    );
  }

  function openManualAddModal(triggerEl) {
    openModal(
      `
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-add-title">
        <div class="modal-header">
          <div>
            <h2 id="manual-add-title" class="modal-title">企業を手動追加</h2>
            <p class="modal-subtitle">基本情報・職種・選考ステータス・想定年収・URL・企業概要を登録します</p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-modal-close aria-label="閉じる">✕ 閉じる</button>
        </div>
        <form id="manual-add-form" style="display:contents">
          <div class="modal-body">
            <div id="ma-error-banner" style="margin-bottom:10px"></div>
            <div class="form-grid">
              <div class="form-field">
                <label class="form-label" for="ma-name">企業名 *</label>
                <input type="text" id="ma-name" name="name" class="input" required placeholder="例: 株式会社サンプルテクノロジーズ">
              </div>
              <div class="form-field">
                <label class="form-label" for="ma-industry">業界</label>
                <input type="text" id="ma-industry" name="industry" class="input" placeholder="例: IT・クラウドサービス">
              </div>
              <div class="form-field">
                <label class="form-label" for="ma-job-type">職種</label>
                <input type="text" id="ma-job-type" name="jobType" class="input" placeholder="例: ソフトウェアエンジニア">
              </div>
              <div class="form-field">
                <label class="form-label" for="ma-location">本社・勤務地</label>
                <input type="text" id="ma-location" name="location" class="input" placeholder="例: 東京都千代田区">
              </div>
              <div class="form-field">
                <label class="form-label" for="ma-status">選考ステータス</label>
                <select id="ma-status" name="status" class="select">
                  ${SELECTION_STATUSES.map((st) => {
                    const meta = STATUS_META[st] || { label: st };
                    return `<option value="${escapeHtml(st)}">${escapeHtml(meta.label)}</option>`;
                  }).join('')}
                </select>
              </div>
              <div class="form-field">
                <label class="form-label" for="ma-priority">志望度 (1〜5)</label>
                <select id="ma-priority" name="priority" class="select">
                  <option value="5">★★★★★ (5/5) 第一志望群</option>
                  <option value="4">★★★★☆ (4/5) 高志望</option>
                  <option value="3" selected>★★★☆☆ (3/5) 標準</option>
                  <option value="2">★★☆☆☆ (2/5) 検討中</option>
                  <option value="1">★☆☆☆☆ (1/5) 情報収集</option>
                </select>
              </div>
              <div class="form-field">
                <label class="form-label" for="ma-income">想定年収 (単位: 万円・整数)</label>
                <input type="number" id="ma-income" name="annualIncome" class="input tabular-nums" min="0" max="100000" step="1" placeholder="例: 550">
              </div>
              <div class="form-field">
                <label class="form-label" for="ma-website">公式サイトURL (http/https)</label>
                <input type="url" id="ma-website" name="websiteUrl" class="input" placeholder="https://example.jp">
              </div>
              <div class="form-field">
                <label class="form-label" for="ma-url">マイページURL (http/https)</label>
                <input type="url" id="ma-url" name="myPageUrl" class="input" placeholder="https://example.jp/mypage">
              </div>
              <div class="form-field">
                <label class="form-label" for="ma-mypage-id">マイページID（パスワードはOS管理推奨）</label>
                <input type="text" id="ma-mypage-id" name="myPageId" class="input" placeholder="例: user_2027_abc">
              </div>
              <div class="form-field">
                <label class="form-label" for="ma-description">企業概要</label>
                <input type="text" id="ma-description" name="description" class="input" placeholder="事業内容・主要プロダクトなど">
              </div>
              <div class="form-field">
                <label class="form-label" for="ma-features">特徴・強み</label>
                <input type="text" id="ma-features" name="features" class="input" placeholder="技術文化・働き方の特徴など">
              </div>
              <div class="form-field col-span-2">
                <label class="checkbox-row">
                  <input type="checkbox" name="isEarlySelection">
                  <span>早期選考ルートとして管理する（カンバンの早期選考レーンに表示）</span>
                </label>
              </div>
              <div class="form-field col-span-2">
                <label class="form-label" for="ma-memo">企業メモ</label>
                <textarea id="ma-memo" name="memo" class="textarea" placeholder="選考スケジュールや気になっている点など"></textarea>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outlined" data-modal-close>キャンセル</button>
            <button type="submit" id="ma-submit-btn" class="btn btn-primary">企業を登録する</button>
          </div>
        </form>
      </div>
      `,
      triggerEl,
      (root) => {
        const form = root.querySelector('#manual-add-form');
        const errBanner = root.querySelector('#ma-error-banner');
        const doSubmit = async () => {
          const btn = root.querySelector('#ma-submit-btn');
          try {
            if (btn) btn.disabled = true;
            if (errBanner) errBanner.innerHTML = '';
            const incomeRaw = form.annualIncome.value.trim();
            await apiRequest('POST', '/api/companies', {
              name: form.name.value,
              industry: form.industry.value,
              jobType: form.jobType.value,
              status: form.status.value,
              priority: Number(form.priority.value),
              location: form.location.value,
              annualIncome: incomeRaw === '' ? null : Number(incomeRaw),
              websiteUrl: form.websiteUrl.value,
              myPageUrl: form.myPageUrl.value,
              myPageId: form.myPageId.value,
              description: form.description.value,
              features: form.features.value,
              isEarlySelection: form.isEarlySelection.checked,
              memo: form.memo.value,
            });
            state.modalDirty = false;
            requestCloseModal(true);
            await loadAllData();
            showToast('企業を登録しました。', 'success');
          } catch (err) {
            if (btn) btn.disabled = false;
            if (errBanner) {
              errBanner.innerHTML = `
                <div class="banner banner-error">
                  <span>⚠ 保存に失敗しました: ${escapeHtml(err.message)}</span>
                  <button type="button" class="btn btn-xs btn-outlined" id="ma-retry-btn">再試行</button>
                </div>
              `;
              errBanner.querySelector('#ma-retry-btn')?.addEventListener('click', doSubmit);
            }
            showToast(err.message, 'error', doSubmit);
          }
        };
        form?.addEventListener('submit', async (e) => {
          e.preventDefault();
          await doSubmit();
        });
      }
    );
  }

  async function openAgentRegistrationModal(trigger, onChanged) {
    const parent = state.activeModal;
    let data;
    try { data = await ipcInvoke('getAiAgents'); }
    catch (error) { showToast(error.message, 'error'); return; }
    if (state.activeModal !== parent || (trigger && !trigger.isConnected)) return;
    try {
      const s = await ipcInvoke('getSession');
      if (s) state.chatGptSession = { ...state.chatGptSession, ...s };
      if (state.chatGptSession.connected && state.chatGptSession.sharing && (!state.chatGptModels || state.chatGptModels.length <= 1)) {
        try {
          const models = await ipcInvoke('listModels');
          if (Array.isArray(models) && models.length > 0) {
            state.chatGptModels = models;
            if (!models.some((m) => m.slug === state.selectedModel)) {
              state.selectedModel = models[0].slug;
            }
          }
        } catch {}
      }
    } catch {}
    try { state.copilotSession = await ipcInvoke('getCopilotStatus'); }
    catch (error) { state.copilotSession = { connected: false, clientId: '', models: [], quota: null, error: error.message }; }
    if (state.activeModal !== parent || (trigger && !trigger.isConnected)) return;
    const dirty = state.modalDirty, lastFocus = state.lastFocusElement;
    if (parent) { parent.id = 'suspended-prompt-modal'; parent.inert = true; parent.setAttribute('aria-hidden', 'true'); }
    const child = document.createElement('div'); child.id = 'modal-root'; child.className = 'modal-root is-hidden';
    document.body.append(child);
    state.suspendedModalDirty = dirty;
    openModal(`
      <div class="modal-dialog modal-lg" role="dialog" aria-modal="true" aria-labelledby="agent-register-title">
        <div class="modal-header"><h2 id="agent-register-title" class="modal-title">各種エージェントを登録する</h2><button type="button" class="btn btn-ghost" data-modal-close aria-label="閉じる">✕</button></div>
        <div class="modal-body">
          <div class="panel copilot-panel">
            <div class="panel-header"><h3 class="panel-title">GitHub Copilot 連携</h3><span id="copilot-status-badge" class="chip">状態確認中</span></div>
            <p class="settings-note">あなたのCopilot契約の利用枠を使います。対象プラン・組織ポリシーに従い、追加利用の設定によっては課金されます。既存CLIのログインは流用しません。</p>
            <form id="copilot-setup-form" class="copilot-setup-form">
              <label class="form-field"><span class="form-label">このアプリ専用のGitHub OAuth AppのClient ID</span><input id="copilot-client-id" class="input" value="${escapeHtml(state.copilotSession.clientId || '')}" maxlength="100" autocomplete="off" spellcheck="false" placeholder="Client Secretは入力しません" required></label>
              <button type="submit" class="btn btn-sm btn-outlined">Client IDを保存</button>
            </form>
            <p class="settings-note">OAuth Appの「Enable Device Flow」を有効にしてください。Client IDは公開識別子です。ログイントークンはOSの保護機能で暗号化します。</p>
            <button type="button" id="copilot-open-setup" class="btn btn-xs btn-outlined">GitHubのOAuth App設定を開く ↗</button>
            <div id="copilot-controls" class="copilot-controls"></div>
            <p id="copilot-message" role="status" aria-live="polite"></p>
          </div>
          <div class="panel" style="margin-bottom:14px">
            <div class="panel-header" style="margin-bottom:6px">
              <h3 class="panel-title" style="font-size:0.95rem">公式 ChatGPT 連携</h3>
              <span id="cg-status-badge" class="chip">状態確認中</span>
            </div>
            <p class="settings-note" style="margin:0 0 10px;font-size:0.78rem">
              ChatGPTアカウントで接続します。利用できるプランや機能はOpenAI側の条件に従います。実アカウントでの接続・生成は未検証です。
            </p>
            <div id="cg-controls" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px"></div>
          </div>

          <form id="agent-register-form" style="margin-bottom:14px">
            <div class="panel">
              <div class="panel-header" style="margin-bottom:6px">
                <h3 class="panel-title" style="font-size:0.95rem">APIキー方式のエージェント登録</h3>
              </div>
              <p class="settings-note" style="margin:0 0 10px;font-size:0.78rem">
                OpenAI API、Claude、Gemini等のAPIキーを登録します。登録だけでは通信・課金は発生しません。APIキーはOSの保護機能で暗号化して保存します。
              </p>
              <div class="form-grid">
                <label class="form-field col-span-2"><span class="form-label">提供元</span><select id="agent-provider" class="select">${data.providers.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('')}</select></label>
                <p id="agent-billing" class="settings-note form-field col-span-2"></p>
                <label class="form-field"><span class="form-label">表示名</span><input id="agent-name" class="input" maxlength="80" placeholder="例：企業情報の整理用" required></label>
                <label class="form-field"><span class="form-label">モデルID</span><input id="agent-model" class="input" maxlength="160" placeholder="提供元の管理画面で確認" required autocomplete="off"></label>
                <label class="form-field col-span-2"><span class="form-label">APIキー</span><input id="agent-key" type="password" class="input" minlength="8" maxlength="4096" required autocomplete="new-password" spellcheck="false" autocapitalize="off"></label>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;flex-wrap:wrap;gap:8px">
                <button type="button" id="agent-console" class="btn btn-sm btn-outlined">提供元の管理画面を開く ↗</button>
                <button type="submit" class="btn btn-sm btn-primary">このAPIキーを登録する</button>
              </div>
              <p class="settings-note" style="margin-top:8px;font-size:0.76rem">Coding Planや別アプリのログイントークンは登録しないでください。登録後も、生成を実行するまで接続の有効性は未確認です。</p>
              <p id="agent-register-message" role="status" aria-live="polite" style="margin-top:6px;font-size:0.85rem"></p>
            </div>
          </form>

          <div class="panel">
            <div class="panel-header" style="margin-bottom:6px">
              <h3 class="panel-title" style="font-size:0.95rem">登録済みのAPIエージェント</h3>
            </div>
            <div id="registered-agents" class="registered-agents"></div>
          </div>
        </div>
        <div class="modal-footer"><button type="button" class="btn btn-outlined" data-modal-close>戻る</button></div>
      </div>`, trigger, (root) => {
      const form = root.querySelector('#agent-register-form');
      const provider = root.querySelector('#agent-provider');
      const message = root.querySelector('#agent-register-message');
      root.addEventListener('jt-modal-close', () => { form.querySelector('#agent-key').value = ''; }, { once: true });
      let busy = false;
      let copilotBusy = false, copilotPoll = null;
      const cpForm = root.querySelector('#copilot-setup-form');
      const cpMessage = root.querySelector('#copilot-message');
      const renderCopilot = () => {
        if (!root.contains(cpForm)) return;
        const s = state.copilotSession;
        root.querySelector('#copilot-status-badge').textContent = s.pack?.installing ? '追加機能を準備中' : s.runtimeAvailable === false ? '追加機能未導入' : s.connected ? `接続済み（${s.login || 'GitHub'}）` : s.signingIn ? 'GitHubでの承認待ち' : '未接続';
        cpForm.querySelectorAll('input,button').forEach((el) => { el.disabled = copilotBusy || s.signingIn || s.generating; });
        const controls = root.querySelector('#copilot-controls');
        const pack = s.pack || {};
        const packControls = `<p class="settings-note">Copilotは任意の追加機能です。初回のみ公式パッケージを取得します（展開後約140 MiB・OSで異なります）。企業データやログイン情報は追加機能の削除後も残ります。</p>${pack.installing ? `<p role="status">追加機能をダウンロード・検証中… ${pack.progress ? `${pack.progress.package}/${pack.progress.total}` : ''}</p><button type="button" id="copilot-pack-cancel" class="btn btn-sm btn-outlined">ダウンロードを中断</button>` : !s.runtimeAvailable ? `<button type="button" id="copilot-pack-install" class="btn btn-sm btn-primary" ${copilotBusy || pack.supported === false ? 'disabled' : ''}>Copilot追加機能をダウンロード</button>${pack.supported === false ? '<p class="settings-note">このOS・CPUには対応していません。</p>' : ''}` : `<button type="button" id="copilot-pack-remove" class="btn btn-sm btn-outlined" ${copilotBusy || s.signingIn || s.generating ? 'disabled' : ''}>Copilot追加機能を削除</button>`}`;
        controls.innerHTML = packControls + (pack.pendingRemoval && !s.runtimeAvailable ? `<button type="button" id="copilot-pack-remove" class="btn btn-sm btn-outlined" ${copilotBusy ? 'disabled' : ''}>残った追加ファイルを削除</button>` : '') + (!s.runtimeAvailable || pack.installing ? '' : s.signingIn ? `<div class="copilot-device-code"><span>GitHubで次のコードを入力してください</span><strong>${escapeHtml(s.userCode || '取得中…')}</strong><button type="button" class="btn btn-sm btn-primary" id="copilot-open-device" ${s.userCode ? '' : 'disabled'}>GitHubで承認する ↗</button><button type="button" class="btn btn-sm btn-outlined" id="copilot-cancel-login">認証を中断</button></div>`
          : s.connected ? `<p class="settings-note">生成は元の企業追加画面から実行できます。モデル一覧・残り利用枠は下のボタンで確認できます。</p><button type="button" class="btn btn-sm btn-outlined" id="copilot-details" ${copilotBusy ? 'disabled' : ''}>モデル・利用枠を確認</button><button type="button" class="btn btn-sm btn-outlined" id="copilot-usage">GitHubの利用状況 ↗</button><button type="button" class="btn btn-sm btn-outlined" id="copilot-signout" ${copilotBusy ? 'disabled' : ''}>連携を解除</button><div class="copilot-quota">${s.quota === null ? '<p class="settings-note">残り利用枠は未取得です。取得できない場合はGitHubの利用状況で確認してください。</p>' : (s.quota || []).map((q) => `<p class="settings-note">${escapeHtml(({ chat: 'チャット', completions: '補完', premium_interactions: 'プレミアム利用枠', ai_credits: 'AIクレジット' })[q.key] || q.key)}：${q.unlimited ? '上限なし' : q.remainingPercentage === null ? '残量不明' : `残り ${q.remainingPercentage}%`}${q.resetDate ? ` ／ リセット ${escapeHtml(q.resetDate)}` : ''}</p>`).join('') || '<p class="settings-note">利用枠の情報がありません。</p>'}</div>`
          : `<button type="button" class="btn btn-sm btn-primary" id="copilot-login" ${!s.clientId || !s.runtimeAvailable || copilotBusy ? 'disabled' : ''}>GitHubでCopilotにログイン</button>`);
        if (s.error || pack.error) cpMessage.textContent = s.error || pack.error;
        controls.querySelector('#copilot-pack-install')?.addEventListener('click', () => copilotAction('installCopilotPack'));
        controls.querySelector('#copilot-pack-remove')?.addEventListener('click', () => copilotAction('removeCopilotPack'));
        controls.querySelector('#copilot-pack-cancel')?.addEventListener('click', () => ipcInvoke('cancelCopilotPack').catch((error) => { cpMessage.textContent = error.message; }));
        controls.querySelector('#copilot-open-device')?.addEventListener('click', () => openSafeExternalUrl('https://github.com/login/device'));
        controls.querySelector('#copilot-usage')?.addEventListener('click', () => openSafeExternalUrl('https://github.com/settings/copilot'));
        controls.querySelector('#copilot-login')?.addEventListener('click', () => copilotAction('beginCopilotLogin'));
        controls.querySelector('#copilot-cancel-login')?.addEventListener('click', () => copilotAction('cancelCopilotLogin'));
        controls.querySelector('#copilot-signout')?.addEventListener('click', () => copilotAction('signOutCopilot'));
        controls.querySelector('#copilot-details')?.addEventListener('click', () => copilotAction('getCopilotDetails'));
      };
      const pollCopilot = () => {
        clearTimeout(copilotPoll);
        if (!root.contains(cpForm) || (!state.copilotSession.signingIn && !state.copilotSession.pack?.installing && !copilotBusy)) return;
        copilotPoll = setTimeout(async () => {
          try { state.copilotSession = await ipcInvoke('getCopilotStatus'); renderCopilot(); pollCopilot(); }
          catch (error) { if (root.contains(cpForm)) cpMessage.textContent = error.message; }
        }, 1000);
      };
      const copilotAction = async (method, args) => {
        if (copilotBusy) return;
        copilotBusy = true; cpMessage.textContent = '処理しています…'; renderCopilot();
        try {
          const action = ipcInvoke(method, args); pollCopilot();
          const result = await action;
          state.copilotSession = await ipcInvoke('getCopilotStatus');
          if (method === 'signOutCopilot' || method === 'configureCopilot') state.selectedCopilotModel = 'auto';
          if (root.contains(cpForm)) {
            cpMessage.textContent = method === 'configureCopilot' ? '保存しました。ログインボタンからGitHubで承認してください。' : method === 'signOutCopilot' ? 'このアプリの連携を解除しました。GitHub側の認可取消はOAuth App設定から行えます。' : '';
            if (method === 'installCopilotPack') cpMessage.textContent = '追加機能を導入しました。GitHubへのログインに進めます。';
            if (method === 'removeCopilotPack') cpMessage.textContent = result.pendingRestart ? '追加機能を無効にしました。使用中のファイルを解放するためアプリを終了し、再起動後にもう一度削除してください。' : '追加機能を削除しました。必要なときに再導入できます。';
            if (method === 'configureCopilot') state.modalDirty = ['#agent-name', '#agent-model', '#agent-key'].some((selector) => root.querySelector(selector).value.trim());
          }
        } catch (error) { if (root.contains(cpForm)) cpMessage.textContent = error.message; }
        finally { copilotBusy = false; renderCopilot(); pollCopilot(); }
      };
      cpForm.addEventListener('submit', (event) => { event.preventDefault(); copilotAction('configureCopilot', { clientId: root.querySelector('#copilot-client-id').value.trim() }); });
      root.querySelector('#copilot-open-setup').addEventListener('click', () => openSafeExternalUrl('https://github.com/settings/developers'));
      root.addEventListener('jt-modal-close', () => { clearTimeout(copilotPoll); ipcInvoke('cancelCopilotLogin').catch(() => {}); if (copilotBusy) ipcInvoke('cancelCopilotGeneration').catch(() => {}); }, { once: true });
      renderCopilot(); pollCopilot();

      const renderChatGptControls = () => {
        const badge = root.querySelector('#cg-status-badge');
        const controls = root.querySelector('#cg-controls');
        if (!badge || !controls) return;
        const s = state.chatGptSession || {};
        badge.textContent =
          s.connected && s.sharing
            ? `Using ChatGPT plan (${s.email || 'ChatGPT'})`
            : s.connected && !s.sharing
            ? `サインイン済・トークン共有未許可 (${s.email || 'ChatGPT'})`
            : s.signingIn
            ? 'サインイン待機中...'
            : '未接続';

        controls.innerHTML = `
          ${
            !s.connected
              ? `
                <button type="button" id="btn-cg-signin" class="btn btn-sm btn-outlined" ${s.signingIn ? 'disabled' : ''}>
                  Sign in with ChatGPT (OAuth PKCE)
                </button>
                ${
                  s.signingIn
                    ? '<button type="button" id="btn-cg-cancel-signin" class="btn btn-sm btn-danger">サインインを中断</button>'
                    : ''
                }
                ${
                  s.needsReauthentication
                    ? '<button type="button" id="btn-cg-reset-auth" class="btn btn-sm btn-danger">認証情報をリセット</button>'
                    : ''
                }
              `
              : !s.sharing
              ? `
                <div style="width:100%;font-size:0.78rem;color:var(--m3-warning)">
                  ℹ サインイン済みですが、ChatGPTトークン共有権限 (<code>chatgpt.tokens.use.direct</code>) が付与されていません。ワークスペースの共有設定を確認して再認可してください。
                </div>
                <button type="button" id="btn-cg-signin" class="btn btn-sm btn-outlined">
                  トークン共有を再認可する
                </button>
                <button type="button" id="btn-cg-signout" class="btn btn-sm btn-outlined">サインアウト</button>
              `
              : `
                <select id="cg-model-select" class="select" style="width:auto;padding:4px 8px;font-size:0.8rem" aria-label="生成モデル選択">
                  ${state.chatGptModels
                    .map(
                      (m) =>
                        `<option value="${escapeHtml(m.slug)}" ${state.selectedModel === m.slug ? 'selected' : ''}>${escapeHtml(m.displayName)} (${escapeHtml(m.slug)})</option>`
                    )
                    .join('')}
                </select>
                <button type="button" id="btn-cg-refresh-models" class="btn btn-xs btn-outlined">モデル一覧更新</button>
                <button type="button" id="btn-cg-usage" class="btn btn-sm btn-ghost">利用状況 (chatgpt.com) ↗</button>
                <button type="button" id="btn-cg-signout" class="btn btn-sm btn-outlined">サインアウト</button>
              `
          }
          ${
            s.authError
              ? `<div style="width:100%;font-size:0.78rem;color:var(--m3-error)">⚠ ${escapeHtml(s.authError)}</div>`
              : ''
          }
        `;

        controls.querySelector('#cg-model-select')?.addEventListener('change', (e) => {
          state.selectedModel = e.target.value;
        });

        controls.querySelector('#btn-cg-refresh-models')?.addEventListener('click', async () => {
          try {
            const models = await ipcInvoke('listModels');
            if (Array.isArray(models) && models.length > 0) {
              state.chatGptModels = models;
              if (!models.some((m) => m.slug === state.selectedModel)) {
                state.selectedModel = models[0].slug;
              }
              renderChatGptControls();
              showToast(`利用可能なモデル (${models.length}件) を取得しました。`, 'success');
            }
          } catch (err) {
            showToast(err.message, 'error');
          }
        });

        controls.querySelector('#btn-cg-signin')?.addEventListener('click', async () => {
          try {
            state.chatGptSession.signingIn = true;
            renderChatGptControls();
            await ipcInvoke('signIn');
            const updated = await ipcInvoke('getSession');
            state.chatGptSession = { ...state.chatGptSession, ...updated, signingIn: false, authError: null };
            if (state.chatGptSession.connected && state.chatGptSession.sharing) {
              try {
                const models = await ipcInvoke('listModels');
                if (Array.isArray(models) && models.length > 0) {
                  state.chatGptModels = models;
                  if (!models.some((m) => m.slug === state.selectedModel)) {
                    state.selectedModel = models[0].slug;
                  }
                }
              } catch {}
            }
            renderChatGptControls();
            showToast('ChatGPTと連携しました。', 'success');
          } catch (err) {
            state.chatGptSession.signingIn = false;
            state.chatGptSession.authError = err.message;
            renderChatGptControls();
            showToast(err.message, 'error');
          }
        });

        controls.querySelector('#btn-cg-cancel-signin')?.addEventListener('click', async () => {
          await ipcInvoke('cancelSignIn');
          state.chatGptSession.signingIn = false;
          renderChatGptControls();
        });

        controls.querySelector('#btn-cg-reset-auth')?.addEventListener('click', async () => {
          await ipcInvoke('signOut');
          const updated = await ipcInvoke('getSession');
          state.chatGptSession = { ...state.chatGptSession, ...updated, authError: null, needsReauthentication: false };
          renderChatGptControls();
          showToast('破損した認証データのみをリセットしました（企業データは保持されています）。', 'info');
        });

        controls.querySelector('#btn-cg-signout')?.addEventListener('click', async () => {
          await ipcInvoke('signOut');
          const updated = await ipcInvoke('getSession');
          state.chatGptSession = { ...state.chatGptSession, ...updated, authError: null };
          renderChatGptControls();
          showToast('サインアウトしました。', 'info');
        });

        controls.querySelector('#btn-cg-usage')?.addEventListener('click', async () => {
          await ipcInvoke('openUsage');
        });
      };

      renderChatGptControls();

      const billing = () => { const p = data.providers.find((p) => p.id === provider.value); root.querySelector('#agent-billing').textContent = p.billing; };
      provider.addEventListener('change', billing); billing();
      root.querySelector('#agent-console').addEventListener('click', () => openSafeExternalUrl(data.providers.find((p) => p.id === provider.value).consoleUrl));
      const renderList = () => {
        const list = root.querySelector('#registered-agents');
        list.innerHTML = data.agents.length ? data.agents.map((a) => `<div class="agent-row"><div><strong>${escapeHtml(a.name)}</strong><p class="settings-note">${escapeHtml(data.providers.find((p) => p.id === a.provider)?.label)} ／ ${escapeHtml(a.model)}</p></div><button type="button" class="btn btn-sm btn-outlined" data-delete-agent="${escapeHtml(a.id)}">削除</button></div>`).join('') : '<p class="settings-note">まだ登録されていません。</p>';
        list.querySelectorAll('[data-delete-agent]').forEach((button) => button.addEventListener('click', async () => {
          if (busy || !window.confirm('このエージェントの接続設定を削除しますか？ 企業データは削除されません。')) return;
          busy = true; button.disabled = true;
          try { data.agents = await ipcInvoke('removeAiAgent', { id: button.dataset.deleteAgent }); if (root.contains(form)) renderList(); }
          catch (error) { message.textContent = error.message; }
          finally { busy = false; button.disabled = false; }
        }));
      };
      renderList();
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); if (busy) return;
        busy = true;
        const button = form.querySelector('button[type=submit]'); button.disabled = true;
        const payload = { provider: provider.value, name: root.querySelector('#agent-name').value.trim(), model: root.querySelector('#agent-model').value.trim(), apiKey: root.querySelector('#agent-key').value.trim() };
        const fields = [...form.querySelectorAll('input, select')];
        fields.forEach((field) => { field.disabled = true; });
        message.textContent = '暗号化して保存しています…';
        try {
          data.agents = await ipcInvoke('saveAiAgent', payload);
          if (!root.contains(form)) return;
          root.querySelector('#agent-key').value = '';
          state.modalDirty = false;
          renderList(); message.textContent = '登録しました。「戻る」で企業登録画面に戻り、接続先を選んで生成できます。';
        } catch (error) { message.textContent = error.message; }
        finally { payload.apiKey = ''; busy = false; button.disabled = false; fields.forEach((field) => { field.disabled = false; }); }
      });
    });
    state.modalReturn = () => {
      child.remove();
      if (parent) {
        parent.id = 'modal-root'; parent.inert = false; parent.setAttribute('aria-hidden', 'false');
        state.activeModal = parent; state.modalDirty = dirty; state.suspendedModalDirty = false; state.lastFocusElement = lastFocus;
      }
      trigger?.focus?.({ preventScroll: true });
      onChanged?.();
    };
  }

  function openPromptAddModal(triggerEl) {
    let parsedDraft = null;

    openModal(
      `
      <div class="modal-dialog modal-lg" role="dialog" aria-modal="true" aria-labelledby="prompt-add-title">
        <div class="modal-header">
          <div>
            <h2 id="prompt-add-title" class="modal-title">AI / プロンプトで企業を追加</h2>
            <p class="modal-subtitle">登録済みAPI・公式ChatGPT連携・手動貼り付けから、企業情報を検証して登録できます</p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-modal-close aria-label="閉じる">✕ 閉じる</button>
        </div>
        <div class="modal-body">
          <!-- Step 1: Company Name & Prompt Generation -->
          <div class="panel" style="margin-bottom:12px">
            <div class="form-grid">
              <div class="form-field col-span-2">
                <label class="form-label" for="pa-company-name">調査対象の企業名 *</label>
                <input type="text" id="pa-company-name" class="input" value="株式会社サンプルクラウド" placeholder="例: 株式会社サンプルクラウド">
              </div>
            </div>
            <div style="margin-top:10px">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;flex-wrap:wrap">
                <span class="form-label">生成された共通プロンプト（就活プロフィール反映済）</span>
                <button type="button" id="btn-copy-prompt" class="btn btn-sm btn-primary">
                  📋 プロンプトをコピー
                </button>
              </div>
              <pre id="pa-prompt-box" class="code-box" tabindex="0" aria-label="生成された共通プロンプト本文"></pre>
            </div>
          </div>

          <!-- Step 2: Registered Agents & AI Generation (Consolidated) -->
          <div class="panel" style="margin-bottom:12px">
            <div class="panel-header"><h3 class="panel-title">登録したエージェントで生成</h3><button type="button" id="btn-register-agents" class="btn btn-sm btn-outlined">各種エージェントを登録する</button></div>
            <div id="api-agent-controls" class="api-agent-controls"><p class="settings-note">接続先を読み込んでいます…</p></div>
          </div>

          <!-- Step 3: Paste JSON & Validate Preview -->
          <div class="panel" style="margin-bottom:4px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;flex-wrap:wrap">
              <label class="form-label" for="pa-json-input">AIが出力したJSONを貼り付け（登録前に必ず正規化プレビューを行います）</label>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button type="button" id="btn-fill-sample-json" class="btn btn-xs btn-outlined">サンプルJSONを入力</button>
                <button type="button" id="btn-validate-json" class="btn btn-sm btn-tonal">🔍 JSONを検証・プレビュー</button>
              </div>
            </div>
            <textarea id="pa-json-input" class="textarea" style="font-family:var(--font-mono);min-height:105px" placeholder='{"name": "株式会社サンプルクラウド", "annualIncome": 547.2, ...}'></textarea>
            <div id="pa-preview-area" style="margin-top:12px"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outlined" data-modal-close>閉じる</button>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" id="btn-footer-copy-prompt" class="btn btn-tonal">📋 プロンプトをコピー</button>
            <button type="button" id="btn-save-draft-company" class="btn btn-primary" disabled>
              この内容で企業をDBに登録する
            </button>
          </div>
        </div>
      </div>
      `,
      triggerEl,
      (root) => {
        const nameInput = root.querySelector('#pa-company-name');
        const promptBox = root.querySelector('#pa-prompt-box');
        const jsonInput = root.querySelector('#pa-json-input');
        const previewArea = root.querySelector('#pa-preview-area');
        const saveBtn = root.querySelector('#btn-save-draft-company');
        let apiGenerating = false, copilotGenerating = false, apiSelected = '';
        const refreshAgents = async () => {
          const controls = root.querySelector('#api-agent-controls');
          if (!controls) return;
          try {
            const data = await ipcInvoke('getAiAgents');
            try { state.copilotSession = await ipcInvoke('getCopilotStatus'); } catch { state.copilotSession.connected = false; }
            let session = state.chatGptSession;
            try {
              const s = await ipcInvoke('getSession');
              if (s) {
                state.chatGptSession = { ...state.chatGptSession, ...s };
                session = state.chatGptSession;
              }
            } catch {}
            if (session.connected && session.sharing && (!state.chatGptModels || state.chatGptModels.length <= 1)) {
              try {
                const models = await ipcInvoke('listModels');
                if (Array.isArray(models) && models.length > 0) {
                  state.chatGptModels = models;
                  if (!models.some((m) => m.slug === state.selectedModel)) {
                    state.selectedModel = models[0].slug;
                  }
                }
              } catch {}
            }

            if (!root.contains(controls)) return;

            const isCgAvailable = Boolean(session.connected && session.sharing);
            const isCopilotAvailable = Boolean(state.copilotSession.connected && state.copilotSession.runtimeAvailable);
            const hasAgents = Array.isArray(data.agents) && data.agents.length > 0;

            if (!isCgAvailable && !isCopilotAvailable && !hasAgents) {
              controls.innerHTML = '<p class="settings-note">「各種エージェントを登録する」から、GitHub Copilot・公式ChatGPTの連携やAPI接続先（OpenAI、Claude、Gemini等）を追加できます。</p>';
              return;
            }

            const selections = [...(isCgAvailable ? ['chatgpt'] : []), ...(isCopilotAvailable ? ['copilot'] : []), ...data.agents.map((a) => a.id)];
            if (!selections.includes(apiSelected)) apiSelected = selections[0] || '';

            const currentModelName = state.chatGptModels.find((m) => m.slug === state.selectedModel)?.displayName || state.selectedModel || 'ChatGPT';

            const selectOptions = [];
            if (isCopilotAvailable) selectOptions.push(`<optgroup label="GitHub連携"><option value="copilot" ${apiSelected === 'copilot' ? 'selected' : ''}>GitHub Copilot ／ ${escapeHtml(state.copilotSession.login || 'GitHub')}</option></optgroup>`);
            if (isCgAvailable) {
              selectOptions.push(`
                <optgroup label="公式連携">
                  <option value="chatgpt" ${apiSelected === 'chatgpt' ? 'selected' : ''}>公式 ChatGPT (${escapeHtml(session.email || 'ChatGPT')}) ／ ${escapeHtml(currentModelName)}</option>
                </optgroup>
              `);
            }
            if (hasAgents) {
              selectOptions.push(`
                <optgroup label="APIエージェント">
                  ${data.agents.map((a) => `<option value="${escapeHtml(a.id)}" ${a.id === apiSelected ? 'selected' : ''}>${escapeHtml(a.name)} ／ ${escapeHtml(a.model)}</option>`).join('')}
                </optgroup>
              `);
            }

            const isBusy = Boolean(apiGenerating || copilotGenerating || state.chatGptSession.generating || state.copilotSession.generating);

            controls.innerHTML = `
              <div style="width:100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <select id="api-agent-select" class="select" aria-label="生成エージェント選択" style="flex:1;min-width:220px" ${isBusy ? 'disabled' : ''}>
                  ${selectOptions.join('')}
                </select>
                ${apiSelected === 'copilot' ? `<select id="copilot-model-select" class="select" aria-label="Copilotモデル選択" ${isBusy ? 'disabled' : ''}><option value="auto" ${state.selectedCopilotModel === 'auto' ? 'selected' : ''}>自動選択（auto）</option>${(state.copilotSession.models || []).filter((m) => m.id !== 'auto').map((m) => `<option value="${escapeHtml(m.id)}" ${state.selectedCopilotModel === m.id ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}</select>` : ''}
                ${apiSelected === 'chatgpt' && state.chatGptModels.length > 1 ? `
                  <select id="cg-model-select" class="select" style="width:auto;padding:4px 8px;font-size:0.8rem" aria-label="生成モデル選択" ${isBusy ? 'disabled' : ''}>
                    ${state.chatGptModels.map((m) => `<option value="${escapeHtml(m.slug)}" ${state.selectedModel === m.slug ? 'selected' : ''}>${escapeHtml(m.displayName)} (${escapeHtml(m.slug)})</option>`).join('')}
                  </select>
                ` : ''}
              </div>
              <p id="api-agent-billing" class="settings-note"></p>
              ${apiSelected === 'copilot' ? `<button type="button" id="btn-copilot-generate" class="btn btn-primary" ${isBusy ? 'disabled' : ''}>このプロンプトをCopilotへ送信して生成</button><button type="button" id="btn-copilot-cancel" class="btn btn-outlined" ${copilotGenerating ? '' : 'hidden'}>生成を中断</button>` : apiSelected === 'chatgpt' ? `
                <button type="button" id="btn-cg-generate" class="btn btn-primary" ${state.chatGptSession.generating ? 'disabled' : ''}>
                  ${state.chatGptSession.generating ? '生成中...' : '✦ AIで企業JSONを自動生成'}
                </button>
                <button type="button" id="btn-cg-cancel-gen" class="btn btn-sm btn-danger" ${state.chatGptSession.generating ? '' : 'hidden'}>生成を中断</button>
              ` : `
                <button type="button" id="btn-api-agent-generate" class="btn btn-primary" ${apiGenerating ? 'disabled' : ''}>このプロンプトを送信して生成</button>
                <button type="button" id="btn-api-agent-cancel" class="btn btn-outlined" ${apiGenerating ? '' : 'hidden'}>生成を中断</button>
              `}
              <p class="settings-note">${apiSelected === 'copilot' ? '表示中の共通プロンプト（就活プロフィールを含む）をGitHub Copilotへ送信し、あなたの契約の利用枠を消費します。生成結果はプレビューで確認してから登録してください。' : apiSelected === 'chatgpt' ? '表示中の企業名・共通プロンプト（就活プロフィールを含む）をChatGPTへ送信します。生成結果は下のプレビューで確認してから登録してください。' : '表示中の企業名・共通プロンプト（就活プロフィールを含む）を選択した提供元へ送信します。生成結果は下のプレビューで確認してから登録してください。'}</p>
            `;

            const select = controls.querySelector('#api-agent-select');
            if (select) {
              select.addEventListener('change', () => {
                apiSelected = select.value;
                refreshAgents();
              });
            }

            const modelSelect = controls.querySelector('#cg-model-select');
            controls.querySelector('#copilot-model-select')?.addEventListener('change', (event) => { state.selectedCopilotModel = event.target.value; });
            if (modelSelect) {
              modelSelect.addEventListener('change', (e) => {
                state.selectedModel = e.target.value;
                refreshAgents();
              });
            }

            const billingEl = controls.querySelector('#api-agent-billing');
            if (billingEl) {
              if (apiSelected === 'copilot') {
                billingEl.textContent = 'Copilot契約の利用枠を使用します。Web検索・ファイル操作・コマンド実行は無効です。追加利用の課金条件はGitHubで確認してください。';
              } else if (apiSelected === 'chatgpt') {
                billingEl.textContent = 'ChatGPTプラン利用枠を使用（Web検索あり）';
              } else {
                const a = data.agents.find((a) => a.id === apiSelected);
                const p = a ? data.providers.find((p) => p.id === a.provider) : null;
                if (p) {
                  billingEl.textContent = `${p.billing}。${p.webSearch ? '生成時にWeb検索を利用します。' : 'この接続ではWeb検索せず、分かる範囲を整理します。'}`;
                }
              }
            }

            if (apiSelected === 'copilot') {
              const button = controls.querySelector('#btn-copilot-generate'), cancel = controls.querySelector('#btn-copilot-cancel');
              cancel.addEventListener('click', () => ipcInvoke('cancelCopilotGeneration').catch((error) => showToast(error.message, 'error')));
              button.addEventListener('click', async () => {
                if (apiGenerating || copilotGenerating || state.chatGptSession.generating || state.copilotSession.generating) return;
                if (!nameInput.value.trim()) { showToast('企業名を入力してください。', 'error'); return; }
                copilotGenerating = true; state.copilotSession.generating = true;
                button.disabled = true; select.disabled = true; cancel.hidden = false;
                parsedDraft = null; saveBtn.disabled = true; previewArea.replaceChildren();
                const locked = [nameInput, jsonInput, root.querySelector('#btn-fill-sample-json'), root.querySelector('#btn-validate-json'), root.querySelector('#btn-register-agents'), controls.querySelector('#copilot-model-select')].filter(Boolean);
                locked.forEach((el) => { el.disabled = true; });
                try {
                  const text = await ipcInvoke('generateWithCopilot', { model: state.selectedCopilotModel, input: updatePromptBox() });
                  if (state.activeModal !== root || !root.contains(jsonInput)) return;
                  jsonInput.value = text; state.modalDirty = true; runJsonPreview();
                  showToast('Copilotの生成が完了しました。内容と出典を確認してください。', 'success');
                } catch (error) { if (root.contains(jsonInput)) showToast(error.message, 'error'); }
                finally {
                  copilotGenerating = false; state.copilotSession.generating = false;
                  if (root.contains(jsonInput)) { button.disabled = false; select.disabled = false; cancel.hidden = true; locked.forEach((el) => { el.disabled = false; }); }
                }
              });
            } else if (apiSelected === 'chatgpt') {
              const cgGenBtn = controls.querySelector('#btn-cg-generate');
              const cgCancelBtn = controls.querySelector('#btn-cg-cancel-gen');
              cgCancelBtn?.addEventListener('click', async () => {
                await ipcInvoke('cancelGenerate').catch(() => {});
                state.chatGptSession.generating = false;
                refreshAgents();
              });
              cgGenBtn?.addEventListener('click', async () => {
                if (apiGenerating || copilotGenerating || state.chatGptSession.generating || state.copilotSession.generating) return;
                const cname = nameInput.value.trim();
                if (!cname) { showToast('企業名を入力してください。', 'error'); return; }
                const doGenerate = async () => {
                  try {
                    state.chatGptSession.generating = true;
                    state.chatGptSession.authError = null;
                    refreshAgents();
                    parsedDraft = null; saveBtn.disabled = true; previewArea.replaceChildren();
                    const inputs = [nameInput, jsonInput, root.querySelector('#btn-fill-sample-json'), root.querySelector('#btn-validate-json')];
                    inputs.forEach((el) => { el.disabled = true; });
                    const register = root.querySelector('#btn-register-agents');
                    if (register) register.disabled = true;

                    const promptText = updatePromptBox();
                    const generatedText = await ipcInvoke('generate', {
                      model: state.selectedModel,
                      input: promptText,
                      webSearch: true,
                    });
                    if (state.activeModal !== root || !root.contains(jsonInput)) return;
                    jsonInput.value = generatedText;
                    state.modalDirty = true;
                    runJsonPreview();
                    showToast('AI生成が完了しました。プレビュー内容を確認して登録してください。', 'success');
                  } catch (err) {
                    state.chatGptSession.authError = err.message;
                    if (root.contains(jsonInput)) showToast(err.message, 'error', doGenerate);
                  } finally {
                    state.chatGptSession.generating = false;
                    await refreshAgents();
                    if (!root.contains(jsonInput)) return;
                    const inputs = [nameInput, jsonInput, root.querySelector('#btn-fill-sample-json'), root.querySelector('#btn-validate-json')];
                    inputs.forEach((el) => { el.disabled = false; });
                    const register = root.querySelector('#btn-register-agents');
                    if (register) register.disabled = false;
                  }
                };
                await doGenerate();
              });
            } else {
              const apiGenBtn = controls.querySelector('#btn-api-agent-generate');
              const apiCancelBtn = controls.querySelector('#btn-api-agent-cancel');
              apiCancelBtn?.addEventListener('click', () => ipcInvoke('cancelAiAgentGeneration').catch((e) => showToast(e.message, 'error')));
              apiGenBtn?.addEventListener('click', async () => {
                if (apiGenerating || copilotGenerating || state.chatGptSession.generating || state.copilotSession.generating) return;
                if (!nameInput.value.trim()) { showToast('企業名を入力してください。', 'error'); return; }
                apiGenerating = true; apiGenBtn.disabled = true; select.disabled = true; apiCancelBtn.hidden = false;
                parsedDraft = null; saveBtn.disabled = true; previewArea.replaceChildren();
                const inputs = [nameInput, jsonInput, root.querySelector('#btn-fill-sample-json'), root.querySelector('#btn-validate-json')];
                inputs.forEach((element) => { element.disabled = true; });
                const register = root.querySelector('#btn-register-agents');
                if (register) register.disabled = true;
                try {
                  const text = await ipcInvoke('generateWithAiAgent', { id: apiSelected, input: updatePromptBox() });
                  if (state.activeModal !== root || !root.contains(jsonInput)) return;
                  jsonInput.value = text; state.modalDirty = true; runJsonPreview();
                  showToast('生成が完了しました。内容と出典を確認してください。', 'success');
                } catch (error) { if (root.contains(jsonInput)) showToast(error.message, 'error'); }
                finally {
                  apiGenerating = false; apiGenBtn.disabled = false; select.disabled = false; apiCancelBtn.hidden = true;
                  inputs.forEach((element) => { element.disabled = false; });
                  const register = root.querySelector('#btn-register-agents');
                  if (register) register.disabled = false;
                }
              });
            }
          } catch (error) {
            if (root.contains(controls)) controls.textContent = error.message;
          }
        };
        root.querySelector('#btn-register-agents').addEventListener('click', async (event) => {
          if (apiGenerating || copilotGenerating || state.chatGptSession.generating || state.copilotSession.generating) return;
          const button = event.currentTarget; button.disabled = true;
          try { await openAgentRegistrationModal(button, refreshAgents); }
          finally { if (button.isConnected) button.disabled = false; }
        });
        root.addEventListener('jt-modal-close', () => {
          if (apiGenerating) ipcInvoke('cancelAiAgentGeneration').catch(() => {});
          if (state.chatGptSession?.generating) ipcInvoke('cancelGenerate').catch(() => {});
          if (copilotGenerating) ipcInvoke('cancelCopilotGeneration').catch(() => {});
        }, { once: true });
        refreshAgents();

        const updatePromptBox = () => {
          const cname = nameInput.value.trim();
          const promptText = buildCompanyPrompt(cname, state.careerProfile);
          promptBox.textContent = promptText;
          return promptText;
        };

        updatePromptBox();
        nameInput.addEventListener('input', updatePromptBox);

        const selectPromptBoxText = () => {
          if (!promptBox) return;
          try {
            promptBox.focus({ preventScroll: true });
            if (typeof window.getSelection === 'function' && typeof document.createRange === 'function') {
              const sel = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(promptBox);
              if (sel) {
                sel.removeAllRanges();
                sel.addRange(range);
              }
            }
          } catch {}
        };

        const handleCopyPrompt = async () => {
          const text = updatePromptBox();
          const copied = await copyTextToClipboard(text);
          if (copied) {
            showToast('プロンプトをクリップボードにコピーしました。', 'success');
          } else {
            selectPromptBoxText();
            showToast(
              'クリップボードへのコピーに失敗しました。プロンプト本文を選択状態にしましたので手動でコピーするか、再試行してください。',
              'error',
              handleCopyPrompt
            );
          }
        };

        root.querySelector('#btn-copy-prompt')?.addEventListener('click', handleCopyPrompt);
        root.querySelector('#btn-footer-copy-prompt')?.addEventListener('click', handleCopyPrompt);


        const runJsonPreview = () => {
          const raw = jsonInput.value.trim();
          const res = parseCompanyDraft(raw);
          if (!res.ok) {
            parsedDraft = null;
            saveBtn.disabled = true;
            previewArea.innerHTML = `
              <div class="banner banner-error">
                <strong>⚠ JSON検証エラー:</strong> ${escapeHtml(res.error)}
              </div>
            `;
            return;
          }

          parsedDraft = res.draft;
          saveBtn.disabled = false;
          const d = res.draft;
          const prep = d.interviewPrepTips || {};
          previewArea.innerHTML = `
            <div class="banner banner-info" style="flex-direction:column;align-items:stretch">
              <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
                <strong>✓ DB登録前プレビュー（内容を確認してから下の登録ボタンを押してください）</strong>
                <span class="chip chip-ai">AI生成参考情報（要出典確認）</span>
              </div>
              ${
                d.annualIncomeNormalizedFrom !== null
                  ? `<div style="font-size:0.8rem;color:var(--m3-warning);font-weight:700">
                      ℹ 想定年収の端数を万円整数へ正規化しました: ${escapeHtml(d.annualIncomeNormalizedFrom)} → ${escapeHtml(d.annualIncome)}万円
                    </div>`
                  : ''
              }
              <div class="table-scroll" style="margin-top:6px">
                <table class="data-table" style="min-width:100%">
                  <tbody>
                    <tr><th style="width:140px">企業名</th><td><strong>${escapeHtml(d.name)}</strong></td></tr>
                    <tr><th>業界 / 職種 / 拠点</th><td>${escapeHtml([d.industry, d.jobType, d.location].filter(Boolean).join(' / ') || '—')}</td></tr>
                    <tr><th>想定年収 (正規化済)</th><td class="tabular-nums">${d.annualIncome !== null ? `<strong>${escapeHtml(d.annualIncome)}万円</strong>` : '未確認'}</td></tr>
                    <tr><th>初任給 / 賞与</th><td class="tabular-nums">${d.startingSalary !== null ? `${Number(d.startingSalary).toLocaleString('ja-JP')}円` : '—'} / ${d.bonusMonths !== null ? `${escapeHtml(d.bonusMonths)}ヶ月` : '—'}</td></tr>
                    <tr><th>企業概要・特徴 (AI参考)</th><td>${escapeHtml([d.description, d.features].filter(Boolean).join(' / ') || '—')}</td></tr>
                    <tr><th>マッチ度 / アピール案</th><td>${escapeHtml(prep.fitLevel ? `[判定:${prep.fitLevel}] ${prep.fitReason || ''}` : '—')} ${(prep.appealPoints || []).length > 0 ? `<br>アピール案: ${escapeHtml(prep.appealPoints.join(' / '))}` : ''}</td></tr>
                    <tr><th>情報確認日</th><td class="tabular-nums">${escapeHtml(d.verifiedAt || '未記載（採用ページ等で最新情報をご確認ください）')}</td></tr>
                    <tr>
                      <th>参照元URL (出典)</th>
                      <td>
                        ${
                          d.sources.length === 0
                            ? '<span style="color:var(--m3-warning)">出典URLが記載されていません。公式採用情報を必ずご確認ください。</span>'
                            : d.sources
                                .map((s) => `<div>• ${escapeHtml(s.title || '参照元')}: <code>${escapeHtml(s.url)}</code></div>`)
                                .join('')
                        }
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          `;
        };

        root.querySelector('#btn-validate-json')?.addEventListener('click', runJsonPreview);
        root.querySelector('#btn-fill-sample-json')?.addEventListener('click', () => {
          const cname = nameInput.value.trim() || '株式会社サンプルクラウド';
          jsonInput.value = JSON.stringify(
            {
              name: cname,
              industry: 'IT・クラウド基盤',
              jobType: 'ソフトウェアエンジニア',
              websiteUrl: 'https://example.jp/recruit',
              description: '法人向けクラウド基盤とゼロトラスト認証SaaSを開発・提供するテクノロジー企業。',
              features: '自社開発比率100%、若手への裁量が大きい開発文化',
              location: '東京都渋谷区',
              salary: '月給34万円（固定残業代なし）',
              benefits: 'リモートワーク手当、技術書籍補助、確定拠出年金',
              ratingSalary: 4,
              ratingBenefits: 5,
              startingSalary: 340000,
              bonusTimes: 2,
              bonusMonths: 4.5,
              annualIncome: 547.2,
              annualHolidays: 125,
              fixedOvertime: 'なし',
              housingAllowance: '月3.5万円補助',
              remoteWork: 'ハイブリッド可（週3リモート）',
              verifiedAt: '2026-10-19',
              sources: [
                {
                  title: '公式新卒採用ページ（架空サンプル）',
                  url: 'https://example.jp/recruit/guidelines',
                  verifiedAt: '2026-10-19',
                },
              ],
              suggestedSteps: [
                { stepName: 'エントリーシート提出', stepOrder: 1, memo: 'Web提出' },
                { stepName: '1次技術面接', stepOrder: 2, memo: 'オンライン' },
                { stepName: '最終面接', stepOrder: 3, memo: '本社対面' },
              ],
              interviewPrepTips: {
                fitLevel: '高',
                fitReason: '分散システム・クラウド領域の専攻と高い親和性があります。',
                appealPoints: ['チーム開発での自動化基盤構築経験', '定量的な課題解決プロセス'],
                idealCandidate: '技術で本質的な課題を解決し、チームで協働できるエンジニア',
                expectedQuestions: ['技術的に最も苦労した設計上の判断は何ですか？'],
                reverseQuestions: ['新卒エンジニアの1年目のデプロイ権限やレビュー体制を教えてください。'],
              },
            },
            null,
            2
          );
          runJsonPreview();
        });

        const doSaveDraft = async () => {
          if (!parsedDraft) return;
          try {
            saveBtn.disabled = true;
            const payload = buildCompanyPayload(parsedDraft);
            await apiRequest('POST', '/api/companies', payload);
            state.modalDirty = false;
            requestCloseModal(true);
            await loadAllData();
            showToast(`「${payload.name}」を登録しました。`, 'success');
          } catch (err) {
            saveBtn.disabled = false;
            showToast(err.message, 'error', doSaveDraft);
          }
        };

        saveBtn?.addEventListener('click', doSaveDraft);
      }
    );
  }

  function openCareerProfileModal(triggerEl) {
    let currentStep = 1;
    const draft = { ...DEFAULT_CAREER_PROFILE, ...state.careerProfile };

    openModal(
      `
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="cp-modal-title">
        <div class="modal-header">
          <div>
            <h2 id="cp-modal-title" class="modal-title">就活プロフィール設定 (3ステップ)</h2>
            <p class="modal-subtitle">AIプロンプト生成時に企業分析・想定質問をパーソナライズするための自己分析データです</p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-modal-close aria-label="閉じる">✕ 閉じる</button>
        </div>
        <div class="modal-tabs" id="cp-step-tabs">
          <button type="button" class="modal-tab is-active" data-step="1">Step 1: 専攻・強み・経験</button>
          <button type="button" class="modal-tab" data-step="2">Step 2: 志望業界・希望職種</button>
          <button type="button" class="modal-tab" data-step="3">Step 3: 就活の軸とAI送信範囲</button>
        </div>
        <div class="modal-body" id="cp-step-body"></div>
        <div class="modal-footer">
          <button type="button" id="btn-cp-skip" class="btn btn-ghost">あとで設定する（スキップ）</button>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" id="btn-cp-prev" class="btn btn-outlined">◀ 前へ</button>
            <button type="button" id="btn-cp-next" class="btn btn-tonal">次へ ▶</button>
            <button type="button" id="btn-cp-save" class="btn btn-primary">プロフィールを保存</button>
          </div>
        </div>
      </div>
      `,
      triggerEl,
      (root) => {
        const body = root.querySelector('#cp-step-body');
        const prevBtn = root.querySelector('#btn-cp-prev');
        const nextBtn = root.querySelector('#btn-cp-next');

        const syncInputsToDraft = () => {
          body.querySelectorAll('[data-cp-field]').forEach((el) => {
            const key = el.getAttribute('data-cp-field');
            draft[key] = el.value;
          });
        };

        const renderStep = () => {
          root.querySelectorAll('[data-step]').forEach((tab) => {
            tab.classList.toggle('is-active', Number(tab.getAttribute('data-step')) === currentStep);
          });
          prevBtn.disabled = currentStep === 1;
          nextBtn.disabled = currentStep === 3;

          if (currentStep === 1) {
            body.innerHTML = `
              <div class="form-grid">
                <div class="form-field col-span-2">
                  <label class="form-label">専攻・研究分野・学んでいる領域</label>
                  <input type="text" class="input" data-cp-field="major" value="${escapeHtml(draft.major)}" placeholder="例: 情報工学専攻（分散システム・クラウド基盤）">
                </div>
                <div class="form-field col-span-2">
                  <label class="form-label">強み・学生時代の経験（ガクチカ）</label>
                  <textarea class="textarea" data-cp-field="strengths" placeholder="例: 学内開発コンテスト運営で審査自動化基盤を構築した経験">${escapeHtml(draft.strengths)}</textarea>
                </div>
              </div>
            `;
          } else if (currentStep === 2) {
            body.innerHTML = `
              <div class="form-grid">
                <div class="form-field col-span-2">
                  <label class="form-label">志望業界</label>
                  <input type="text" class="input" data-cp-field="industries" value="${escapeHtml(draft.industries)}" placeholder="例: クラウドSaaS、通信インフラ、金融IT">
                </div>
                <div class="form-field col-span-2">
                  <label class="form-label">希望職種</label>
                  <input type="text" class="input" data-cp-field="roles" value="${escapeHtml(draft.roles)}" placeholder="例: ソフトウェアエンジニア、SRE">
                </div>
              </div>
            `;
          } else {
            body.innerHTML = `
              <div class="banner banner-info" style="margin-bottom:12px;font-size:0.8rem">
                <div>
                  <strong>🔒 AI連携・プロンプトへの反映範囲について</strong>
                  <p style="margin:4px 0 0">
                    ここで入力した5項目（専攻・志望業界・希望職種・就活の軸・強み）はアプリ専用データ領域の <code>career-profile.json</code> にのみ保存され、<strong>「AI / プロンプトで追加」画面でプロンプトを作成またはAI生成を実行したときのみ</strong>プロンプト内に引用されます。バックグラウンドで自動送信されることは一切ありません。
                  </p>
                </div>
              </div>
              <div class="form-grid">
                <div class="form-field col-span-2">
                  <label class="form-label">就活の軸・優先したい働き方や価値観</label>
                  <textarea class="textarea" data-cp-field="priorities" placeholder="例: 若手から設計・運用の一貫した裁量を持てること、ハイブリッド勤務可">${escapeHtml(draft.priorities)}</textarea>
                </div>
              </div>
            `;
          }

          body.querySelectorAll('[data-cp-field]').forEach((el) => {
            el.addEventListener('input', () => {
              state.modalDirty = true;
              draft[el.getAttribute('data-cp-field')] = el.value;
            });
          });
        };

        renderStep();

        root.querySelectorAll('[data-step]').forEach((tab) => {
          tab.addEventListener('click', () => {
            syncInputsToDraft();
            currentStep = Number(tab.getAttribute('data-step'));
            renderStep();
          });
        });

        prevBtn?.addEventListener('click', () => {
          if (currentStep > 1) {
            syncInputsToDraft();
            currentStep--;
            renderStep();
          }
        });

        nextBtn?.addEventListener('click', () => {
          if (currentStep < 3) {
            syncInputsToDraft();
            currentStep++;
            renderStep();
          }
        });

        root.querySelector('#btn-cp-skip')?.addEventListener('click', () => {
          requestCloseModal();
        });

        root.querySelector('#btn-cp-save')?.addEventListener('click', async () => {
          syncInputsToDraft();
          const doSaveProfile = async () => {
            try {
              const saved = await ipcInvoke('saveCareerProfile', {
                version: 1,
                completed: true,
                major: draft.major || '',
                industries: draft.industries || '',
                roles: draft.roles || '',
                priorities: draft.priorities || '',
                strengths: draft.strengths || '',
              });
              state.careerProfile = saved;
              state.profileError = null;
              state.modalDirty = false;
              requestCloseModal(true);
              renderAll();
              showToast('就活プロフィールを保存しました。', 'success');
            } catch (err) {
              showToast(err.message, 'error', doSaveProfile);
            }
          };
          await doSaveProfile();
        });
      }
    );
  }

  async function openCompanyDetailModal(companyId, triggerEl, initialTab = 'steps') {
    let company;
    try {
      const res = await apiRequest('GET', `/api/companies/${encodeURIComponent(companyId)}`);
      company = res.company;
    } catch (err) {
      showToast(err.message, 'error');
      return;
    }

    let activeTab = initialTab;
    let editingStepId = null;
    let editingInterviewId = null;

    openModal(
      `
      <div class="modal-dialog modal-lg company-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="cd-modal-title">
        <div class="modal-header">
          <div style="min-width:0">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <h2 id="cd-modal-title" class="modal-title">${escapeHtml(company.name)}</h2>
              <span id="cd-header-stars" class="priority-stars">${escapeHtml(formatPriorityStars(company.priority))} (${escapeHtml(company.priority)}/5)</span>
              ${company.isEarlySelection ? `<span class="chip chip-early">早期選考</span>` : ''}
            </div>
            <p id="cd-header-subtitle" class="modal-subtitle">${escapeHtml([company.industry, company.jobType, company.location].filter(Boolean).join(' / ') || '業界・所在地未設定')}</p>
          </div>
          <div class="company-detail-actions">
            <select id="cd-quick-priority" class="select" style="width:auto;padding:4px 8px;font-size:0.8rem" aria-label="志望度変更">
              <option value="5" ${company.priority === 5 ? 'selected' : ''}>志望度: ★★★★★ (5)</option>
              <option value="4" ${company.priority === 4 ? 'selected' : ''}>志望度: ★★★★☆ (4)</option>
              <option value="3" ${company.priority === 3 ? 'selected' : ''}>志望度: ★★★☆☆ (3)</option>
              <option value="2" ${company.priority === 2 ? 'selected' : ''}>志望度: ★★☆☆☆ (2)</option>
              <option value="1" ${company.priority === 1 ? 'selected' : ''}>志望度: ★☆☆☆☆ (1)</option>
            </select>
            <select id="cd-quick-status" class="select" style="width:auto;padding:4px 8px;font-size:0.8rem" aria-label="選考ステータス変更">
              ${SELECTION_STATUSES.map((st) => {
                const meta = STATUS_META[st] || { label: st };
                return `<option value="${escapeHtml(st)}" ${company.status === st ? 'selected' : ''}>${escapeHtml(meta.label)}</option>`;
              }).join('')}
            </select>
            <button type="button" id="btn-cd-delete" class="btn btn-sm btn-danger">削除</button>
            <button type="button" class="btn btn-sm btn-ghost" data-modal-close aria-label="閉じる">✕ 閉じる</button>
          </div>
        </div>

        <div class="modal-tabs" role="tablist">
          <button type="button" class="modal-tab" data-cd-tab="steps">選考ステップ (<span id="cd-count-steps">${(company.steps || []).length}</span>)</button>
          <button type="button" class="modal-tab" data-cd-tab="events">予定・締切 (<span id="cd-count-events">${(company.events || []).length}</span>)</button>
          <button type="button" class="modal-tab" data-cd-tab="interviews">面接記録 (<span id="cd-count-interviews">${(company.interviews || []).length}</span>)</button>
          <button type="button" class="modal-tab" data-cd-tab="compensation">給与と福利厚生</button>
          <button type="button" class="modal-tab" data-cd-tab="ai">AIの面接準備案</button>
          <button type="button" class="modal-tab" data-cd-tab="notes">企業メモとマイページ情報</button>
        </div>

        <div class="modal-body" id="cd-tab-body"></div>

        <div class="modal-footer">
          <div style="font-size:0.76rem;color:var(--m3-on-surface-variant)" class="tabular-nums">
            最終更新: ${escapeHtml(formatDisplayDateTime(company.updatedAt))}
          </div>
          <button type="button" class="btn btn-outlined" data-modal-close>閉じる</button>
        </div>
      </div>
      `,
      triggerEl,
      (root) => {
        const body = root.querySelector('#cd-tab-body');

        const refreshCompanyDetail = async () => {
          const res = await apiRequest('GET', `/api/companies/${encodeURIComponent(companyId)}`);
          company = res.company;
          const titleEl = root.querySelector('#cd-modal-title');
          if (titleEl) titleEl.textContent = company.name;
          const starsEl = root.querySelector('#cd-header-stars');
          if (starsEl) starsEl.textContent = `${formatPriorityStars(company.priority)} (${company.priority}/5)`;
          const subEl = root.querySelector('#cd-header-subtitle');
          if (subEl) subEl.textContent = [company.industry, company.jobType, company.location].filter(Boolean).join(' / ') || '業界・所在地未設定';
          const prioSel = root.querySelector('#cd-quick-priority');
          if (prioSel) prioSel.value = String(company.priority);
          const statSel = root.querySelector('#cd-quick-status');
          if (statSel) statSel.value = company.status;
          const cSteps = root.querySelector('#cd-count-steps');
          if (cSteps) cSteps.textContent = String((company.steps || []).length);
          const cEvents = root.querySelector('#cd-count-events');
          if (cEvents) cEvents.textContent = String((company.events || []).length);
          const cIvs = root.querySelector('#cd-count-interviews');
          if (cIvs) cIvs.textContent = String((company.interviews || []).length);

          await loadAllData();
          renderTabContent();
        };

        root.querySelector('#cd-quick-priority')?.addEventListener('change', async (e) => {
          try {
            await apiRequest('PATCH', `/api/companies/${encodeURIComponent(companyId)}`, {
              priority: Number(e.target.value),
            });
            await refreshCompanyDetail();
            showToast('志望度を更新しました。', 'success');
          } catch (err) {
            showToast(err.message, 'error');
          }
        });

        root.querySelector('#cd-quick-status')?.addEventListener('change', async (e) => {
          try {
            await apiRequest('PATCH', `/api/companies/${encodeURIComponent(companyId)}`, {
              status: e.target.value,
            });
            await refreshCompanyDetail();
            showToast('選考ステータスを更新しました。', 'success');
          } catch (err) {
            showToast(err.message, 'error');
          }
        });

        root.querySelector('#btn-cd-delete')?.addEventListener('click', async () => {
          try {
            const impactRes = await apiRequest('GET', `/api/companies/${encodeURIComponent(companyId)}/impact`);
            const imp = impactRes.impact;
            const confirmed = window.confirm(
              `「${imp.name}」を削除しますか？\n\n関連する以下のデータも同時に削除されます：\n・選考ステップ: ${imp.stepsCount}件\n・予定・締切: ${imp.eventsCount}件\n・面接記録: ${imp.interviewsCount}件\n\nこの操作は取り消せません。`
            );
            if (!confirmed) return;
            await apiRequest('DELETE', `/api/companies/${encodeURIComponent(companyId)}`);
            state.modalDirty = false;
            requestCloseModal(true);
            await loadAllData();
            showToast(`「${imp.name}」を削除しました。`, 'info');
          } catch (err) {
            showToast(err.message, 'error');
          }
        });

        const renderTabContent = () => {
          root.querySelectorAll('[data-cd-tab]').forEach((btn) => {
            btn.classList.toggle('is-active', btn.getAttribute('data-cd-tab') === activeTab);
          });

          if (activeTab === 'steps') {
            const editingStep = editingStepId
              ? (company.steps || []).find((s) => s.id === editingStepId)
              : null;
            const dueVal = editingStep && editingStep.dueDate ? localDateTime(editingStep.dueDate) : '';
            body.innerHTML = `
              <form id="cd-add-step-form" class="form-grid" style="margin-bottom:14px">
                <div class="form-field">
                  <label class="form-label">ステップ名 *</label>
                  <input type="text" name="stepName" class="input" required placeholder="例: ES提出 / 適性検査 / 一次面接" value="${escapeHtml(editingStep ? editingStep.stepName : '')}">
                </div>
                <div class="form-field">
                  <label class="form-label">状態</label>
                  <select name="status" class="select">
                    ${STEP_STATUSES.map(
                      (st) =>
                        `<option value="${escapeHtml(st)}" ${editingStep && editingStep.status === st ? 'selected' : ''}>${escapeHtml(STEP_STATUS_LABELS[st] || st)}</option>`
                    ).join('')}
                  </select>
                </div>
                <div class="form-field">
                  <label class="form-label">順番 (1〜1000)</label>
                  <input type="number" name="stepOrder" class="input tabular-nums" min="1" max="1000" step="1" value="${escapeHtml(editingStep ? editingStep.stepOrder : (company.steps || []).length + 1)}">
                </div>
                <div class="form-field">
                  <label class="form-label">期限・実施日時（任意）</label>
                  <input type="datetime-local" name="dueDate" class="input tabular-nums" value="${escapeHtml(dueVal)}">
                </div>
                <div class="form-field">
                  <label class="form-label">場所 / URL</label>
                  <input type="text" name="location" class="input" placeholder="例: オンライン / 本社" value="${escapeHtml(editingStep ? editingStep.location || '' : '')}">
                </div>
                <div class="form-field">
                  <label class="form-label">メモ</label>
                  <input type="text" name="memo" class="input" placeholder="例: 400字×2設問" value="${escapeHtml(editingStep ? editingStep.memo || '' : '')}">
                </div>
                <div class="form-field col-span-2" style="display:flex;justify-content:flex-end;gap:6px">
                  ${editingStep ? `<button type="button" id="cd-cancel-step-edit" class="btn btn-sm btn-outlined">編集キャンセル</button>` : ''}
                  <button type="submit" class="btn btn-sm btn-primary">${editingStep ? '✓ ステップを更新' : '＋ 選考ステップを追加'}</button>
                </div>
              </form>
              <div class="table-scroll">
                <table class="data-table" style="min-width:100%">
                  <thead>
                    <tr><th>順序</th><th>ステップ名</th><th>状態</th><th>期限・実施日</th><th>場所・メモ</th><th>操作</th></tr>
                  </thead>
                  <tbody>
                    ${
                      (company.steps || []).length === 0
                        ? `<tr><td colspan="6" style="text-align:center;padding:18px;color:var(--m3-on-surface-variant)">選考ステップはまだ登録されていません。</td></tr>`
                        : company.steps
                            .map(
                              (st, idx) => `
                              <tr>
                                <td class="tabular-nums">
                                  <div style="display:flex;align-items:center;gap:4px">
                                    <span>#${escapeHtml(st.stepOrder ?? idx + 1)}</span>
                                    <button type="button" class="btn btn-xs btn-ghost" data-move-step="${escapeHtml(st.id)}" data-move-dir="up" ${idx === 0 ? 'disabled' : ''} title="上へ移動">▲</button>
                                    <button type="button" class="btn btn-xs btn-ghost" data-move-step="${escapeHtml(st.id)}" data-move-dir="down" ${idx === company.steps.length - 1 ? 'disabled' : ''} title="下へ移動">▼</button>
                                  </div>
                                </td>
                                <td><strong>${escapeHtml(st.stepName)}</strong></td>
                                <td>
                                  <select class="select" style="width:auto;padding:3px 8px;font-size:0.78rem" data-step-status="${escapeHtml(st.id)}">
                                    ${STEP_STATUSES.map(
                                      (s) => `<option value="${escapeHtml(s)}" ${st.status === s ? 'selected' : ''}>${escapeHtml(STEP_STATUS_LABELS[s] || s)}</option>`
                                    ).join('')}
                                  </select>
                                </td>
                                <td class="tabular-nums">${st.dueDate ? escapeHtml(formatDisplayDateTime(st.dueDate)) : '—'}</td>
                                <td>
                                  ${st.location ? `<div>📍 ${escapeHtml(st.location)}</div>` : ''}
                                  <div>${escapeHtml(st.memo || '—')}</div>
                                </td>
                                <td>
                                  <div style="display:flex;gap:4px;flex-wrap:wrap">
                                    <button type="button" class="btn btn-xs btn-outlined" data-edit-step="${escapeHtml(st.id)}">編集</button>
                                    <button type="button" class="btn btn-xs btn-danger" data-del-step="${escapeHtml(st.id)}">削除</button>
                                  </div>
                                </td>
                              </tr>
                            `
                            )
                            .join('')
                    }
                  </tbody>
                </table>
              </div>
            `;

            body.querySelector('#cd-cancel-step-edit')?.addEventListener('click', () => {
              editingStepId = null;
              renderTabContent();
            });

            body.querySelector('#cd-add-step-form')?.addEventListener('submit', async (e) => {
              e.preventDefault();
              const f = e.currentTarget;
              const dueIso = f.dueDate.value ? toIsoWithLocalOffset(f.dueDate.value) : null;
              const orderVal = f.stepOrder.value.trim() ? Number(f.stepOrder.value) : undefined;
              const payload = {
                stepName: f.stepName.value,
                status: f.status.value,
                stepOrder: orderVal,
                dueDate: dueIso,
                location: f.location.value,
                memo: f.memo.value,
              };
              if (editingStepId) {
                await apiRequest('PATCH', `/api/steps/${encodeURIComponent(editingStepId)}`, payload);
                editingStepId = null;
                showToast('選考ステップを更新しました。', 'success');
              } else {
                await apiRequest('POST', '/api/steps', {
                  companyId,
                  ...payload,
                });
                showToast('選考ステップを追加しました。', 'success');
              }
              state.modalDirty = false;
              await refreshCompanyDetail();
            });

            body.querySelectorAll('[data-edit-step]').forEach((btn) => {
              btn.addEventListener('click', () => {
                editingStepId = btn.getAttribute('data-edit-step');
                renderTabContent();
              });
            });

            body.querySelectorAll('[data-move-step]').forEach((btn) => {
              btn.addEventListener('click', async () => {
                const sid = btn.getAttribute('data-move-step');
                const dir = btn.getAttribute('data-move-dir');
                const steps = company.steps || [];
                const idx = steps.findIndex((s) => s.id === sid);
                const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
                if (idx < 0 || swapIdx < 0 || swapIdx >= steps.length) return;
                const a = steps[idx];
                const b = steps[swapIdx];
                await apiRequest('PATCH', `/api/steps/${encodeURIComponent(a.id)}`, { stepOrder: swapIdx + 1 });
                await apiRequest('PATCH', `/api/steps/${encodeURIComponent(b.id)}`, { stepOrder: idx + 1 });
                await refreshCompanyDetail();
              });
            });

            body.querySelectorAll('[data-step-status]').forEach((sel) => {
              sel.addEventListener('change', async () => {
                const sid = sel.getAttribute('data-step-status');
                await apiRequest('PATCH', `/api/steps/${encodeURIComponent(sid)}`, { status: sel.value });
                await refreshCompanyDetail();
              });
            });

            body.querySelectorAll('[data-del-step]').forEach((btn) => {
              btn.addEventListener('click', async () => {
                const sid = btn.getAttribute('data-del-step');
                await apiRequest('DELETE', `/api/steps/${encodeURIComponent(sid)}`);
                await refreshCompanyDetail();
              });
            });
          } else if (activeTab === 'events') {
            const defaultStart = localDateTime(new Date(Date.now() + 3600 * 1000).toISOString());
            body.innerHTML = `
              <form id="cd-add-event-form" class="form-grid" style="margin-bottom:14px">
                <div class="form-field">
                  <label class="form-label">予定タイトル *</label>
                  <input type="text" name="title" class="input" required placeholder="例: 一次面接">
                </div>
                <div class="form-field">
                  <label class="form-label">種別</label>
                  <select name="eventType" class="select">
                    ${EVENT_TYPES.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(EVENT_LABELS[t] || t)}</option>`).join('')}
                  </select>
                </div>
                <div class="form-field">
                  <label class="form-label">関連する選考ステップ（任意）</label>
                  <select name="stepId" class="select">
                    <option value="">関連ステップなし</option>
                    ${(company.steps || [])
                      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.stepName)}</option>`)
                      .join('')}
                  </select>
                </div>
                <div class="form-field">
                  <label class="form-label">場所 / URL</label>
                  <input type="text" name="location" class="input" placeholder="例: オンライン">
                </div>
                <div class="form-field">
                  <label class="form-label">開始日時 *</label>
                  <input type="datetime-local" name="startAt" class="input tabular-nums" required value="${escapeHtml(defaultStart)}">
                </div>
                <div class="form-field">
                  <label class="form-label">終了日時（任意）</label>
                  <input type="datetime-local" name="endAt" class="input tabular-nums">
                </div>
                <div class="form-field">
                  <label class="form-label">メモ</label>
                  <input type="text" name="memo" class="input">
                </div>
                <div class="form-field" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                  <label class="checkbox-row">
                    <input type="checkbox" name="allDay">
                    <span>終日イベント</span>
                  </label>
                  <button type="submit" class="btn btn-sm btn-primary">＋ この企業の予定を追加</button>
                </div>
              </form>
              <div class="table-scroll">
                <table class="data-table" style="min-width:100%">
                  <thead>
                    <tr><th>日時</th><th>種別</th><th>タイトル</th><th>場所</th><th>操作</th></tr>
                  </thead>
                  <tbody>
                    ${
                      (company.events || []).length === 0
                        ? `<tr><td colspan="5" style="text-align:center;padding:18px;color:var(--m3-on-surface-variant)">この企業の予定はありません。</td></tr>`
                        : company.events
                            .map(
                              (ev) => `
                              <tr>
                                <td class="tabular-nums">
                                  ${escapeHtml(formatDisplayDateTime(ev.startAt))}
                                  ${ev.allDay ? `<span class="chip" style="margin-left:4px">終日</span>` : ''}
                                </td>
                                <td><span class="chip">${escapeHtml(EVENT_LABELS[ev.eventType] || ev.eventType)}</span></td>
                                <td><strong>${escapeHtml(ev.title)}</strong></td>
                                <td>${escapeHtml(ev.location || '—')}</td>
                                <td>
                                  <div style="display:flex;gap:4px;flex-wrap:wrap">
                                    <button type="button" class="btn btn-xs btn-tonal" data-cal-ev="${escapeHtml(ev.id)}">カレンダー</button>
                                    <button type="button" class="btn btn-xs btn-danger" data-del-ev="${escapeHtml(ev.id)}">削除</button>
                                  </div>
                                </td>
                              </tr>
                            `
                            )
                            .join('')
                    }
                  </tbody>
                </table>
              </div>
            `;

            body.querySelector('#cd-add-event-form')?.addEventListener('submit', async (e) => {
              e.preventDefault();
              const f = e.currentTarget;
              await apiRequest('POST', '/api/events', {
                companyId,
                stepId: f.stepId.value || null,
                title: f.title.value,
                eventType: f.eventType.value,
                startAt: toIsoWithLocalOffset(f.startAt.value),
                endAt: f.endAt.value ? toIsoWithLocalOffset(f.endAt.value) : null,
                allDay: f.allDay.checked,
                location: f.location.value,
                memo: f.memo.value,
              });
              state.modalDirty = false;
              await refreshCompanyDetail();
            });

            body.querySelectorAll('[data-cal-ev]').forEach((btn) => {
              btn.addEventListener('click', (e) => {
                const ev = (company.events || []).find((x) => x.id === btn.getAttribute('data-cal-ev'));
                if (ev) openCalendarPreviewModal(ev, e.currentTarget);
              });
            });

            body.querySelectorAll('[data-del-ev]').forEach((btn) => {
              btn.addEventListener('click', async () => {
                await apiRequest('DELETE', `/api/events/${encodeURIComponent(btn.getAttribute('data-del-ev'))}`);
                await refreshCompanyDetail();
              });
            });
          } else if (activeTab === 'interviews') {
            const editingIv = editingInterviewId
              ? (company.interviews || []).find((x) => x.id === editingInterviewId)
              : null;
            const ivDateVal =
              editingIv && editingIv.interviewDate ? String(editingIv.interviewDate).slice(0, 10) : '';
            body.innerHTML = `
              <form id="cd-add-iv-form" class="form-grid" style="margin-bottom:14px">
                <div class="form-field">
                  <label class="form-label">面接段階名 *</label>
                  <input type="text" name="stepName" class="input" required placeholder="例: 一次面接（現場エンジニア）" value="${escapeHtml(editingIv ? editingIv.stepName : '')}">
                </div>
                <div class="form-field">
                  <label class="form-label">実施日</label>
                  <input type="date" name="interviewDate" class="input tabular-nums" value="${escapeHtml(ivDateVal)}">
                </div>
                <div class="form-field col-span-2">
                  <label class="form-label">面接官（役職・人数・雰囲気など）</label>
                  <input type="text" name="interviewer" class="input" placeholder="例: バックエンドテックリード1名・人事1名" value="${escapeHtml(editingIv ? editingIv.interviewer || '' : '')}">
                </div>
                <div class="form-field col-span-2">
                  <label class="form-label">聞かれた質問</label>
                  <textarea name="questions" class="textarea" placeholder="例: Q. なぜ弊社なのか？">${escapeHtml(editingIv ? editingIv.questions || '' : '')}</textarea>
                </div>
                <div class="form-field col-span-2">
                  <label class="form-label">自分の回答と振り返り</label>
                  <textarea name="answers" class="textarea" placeholder="例: A. 分散システムの専攻経験を軸に回答した">${escapeHtml(editingIv ? editingIv.answers || '' : '')}</textarea>
                </div>
                <div class="form-field">
                  <label class="form-label">所感・フィードバック</label>
                  <input type="text" name="feedback" class="input" placeholder="例: 技術的な深掘りが多かった" value="${escapeHtml(editingIv ? editingIv.feedback || '' : '')}">
                </div>
                <div class="form-field">
                  <label class="form-label">次のアクション</label>
                  <input type="text" name="nextAction" class="input" placeholder="例: アーキテクチャ図の整理" value="${escapeHtml(editingIv ? editingIv.nextAction || '' : '')}">
                </div>
                <div class="form-field col-span-2" style="display:flex;justify-content:flex-end;gap:6px">
                  ${editingIv ? `<button type="button" id="cd-cancel-iv-edit" class="btn btn-sm btn-outlined">編集キャンセル</button>` : ''}
                  <button type="submit" class="btn btn-sm btn-primary">${editingIv ? '✓ 面接記録を更新' : '＋ 面接記録を追加'}</button>
                </div>
              </form>
              <div style="display:flex;flex-direction:column;gap:10px">
                ${
                  (company.interviews || []).length === 0
                    ? `<div class="lane-empty">面接記録はまだありません。</div>`
                    : company.interviews
                        .map(
                          (iv) => `
                          <div class="panel" style="margin:0;padding:12px">
                            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
                              <div>
                                <strong>${escapeHtml(iv.stepName)} (${escapeHtml(formatDisplayDateTime(iv.interviewDate))})</strong>
                                ${iv.interviewer ? `<span style="font-size:0.78rem;color:var(--m3-on-surface-variant);margin-left:8px">面接官: ${escapeHtml(iv.interviewer)}</span>` : ''}
                              </div>
                              <div style="display:flex;gap:4px">
                                <button type="button" class="btn btn-xs btn-outlined" data-edit-iv="${escapeHtml(iv.id)}">編集</button>
                                <button type="button" class="btn btn-xs btn-danger" data-del-iv="${escapeHtml(iv.id)}">削除</button>
                              </div>
                            </div>
                            ${iv.questions ? `<p style="margin:6px 0;white-space:pre-wrap;font-size:0.84rem"><strong>質問:</strong> ${escapeHtml(iv.questions)}</p>` : ''}
                            ${iv.answers ? `<p style="margin:6px 0;white-space:pre-wrap;font-size:0.84rem"><strong>回答:</strong> ${escapeHtml(iv.answers)}</p>` : ''}
                            <div style="font-size:0.78rem;color:var(--m3-on-surface-variant)">
                              振り返り: ${escapeHtml(iv.feedback || '—')} / 次回アクション: ${escapeHtml(iv.nextAction || '—')}
                            </div>
                          </div>
                        `
                        )
                        .join('')
                }
              </div>
            `;

            body.querySelector('#cd-cancel-iv-edit')?.addEventListener('click', () => {
              editingInterviewId = null;
              renderTabContent();
            });

            body.querySelector('#cd-add-iv-form')?.addEventListener('submit', async (e) => {
              e.preventDefault();
              const f = e.currentTarget;
              const payload = {
                stepName: f.stepName.value,
                interviewDate: f.interviewDate.value || undefined,
                interviewer: f.interviewer.value,
                questions: f.questions.value,
                answers: f.answers.value,
                feedback: f.feedback.value,
                nextAction: f.nextAction.value,
              };
              if (editingInterviewId) {
                await apiRequest('PATCH', `/api/interviews/${encodeURIComponent(editingInterviewId)}`, payload);
                editingInterviewId = null;
                showToast('面接記録を更新しました。', 'success');
              } else {
                await apiRequest('POST', '/api/interviews', {
                  companyId,
                  ...payload,
                });
                showToast('面接記録を追加しました。', 'success');
              }
              state.modalDirty = false;
              await refreshCompanyDetail();
            });

            body.querySelectorAll('[data-edit-iv]').forEach((btn) => {
              btn.addEventListener('click', () => {
                editingInterviewId = btn.getAttribute('data-edit-iv');
                renderTabContent();
              });
            });

            body.querySelectorAll('[data-del-iv]').forEach((btn) => {
              btn.addEventListener('click', async () => {
                await apiRequest('DELETE', `/api/interviews/${encodeURIComponent(btn.getAttribute('data-del-iv'))}`);
                await refreshCompanyDetail();
              });
            });
          } else if (activeTab === 'compensation') {
            body.innerHTML = `
              <form id="cd-comp-form" class="form-grid">
                <div class="form-field">
                  <label class="form-label">想定年収 (単位: 万円・整数)</label>
                  <input type="number" name="annualIncome" class="input tabular-nums" min="0" max="100000" step="1" value="${company.annualIncome !== null && company.annualIncome !== undefined ? escapeHtml(company.annualIncome) : ''}">
                </div>
                <div class="form-field">
                  <label class="form-label">初任給 (月額・円・整数)</label>
                  <input type="number" name="startingSalary" class="input tabular-nums" min="0" max="10000000" step="1" value="${company.startingSalary !== null && company.startingSalary !== undefined ? escapeHtml(company.startingSalary) : ''}">
                </div>
                <div class="form-field">
                  <label class="form-label">賞与回数 (年・整数)</label>
                  <input type="number" name="bonusTimes" class="input tabular-nums" min="0" max="12" step="1" value="${company.bonusTimes !== null && company.bonusTimes !== undefined ? escapeHtml(company.bonusTimes) : ''}">
                </div>
                <div class="form-field">
                  <label class="form-label">賞与月数 (ヶ月・小数可)</label>
                  <input type="number" name="bonusMonths" class="input tabular-nums" min="0" max="24" step="0.1" value="${company.bonusMonths !== null && company.bonusMonths !== undefined ? escapeHtml(company.bonusMonths) : ''}">
                </div>
                <div class="form-field">
                  <label class="form-label">年間休日 (日・整数)</label>
                  <input type="number" name="annualHolidays" class="input tabular-nums" min="0" max="366" step="1" value="${company.annualHolidays !== null && company.annualHolidays !== undefined ? escapeHtml(company.annualHolidays) : ''}">
                </div>
                <div class="form-field">
                  <label class="form-label">みなし残業</label>
                  <input type="text" name="fixedOvertime" class="input" value="${escapeHtml(company.fixedOvertime || '')}">
                </div>
                <div class="form-field">
                  <label class="form-label">住宅手当・社宅</label>
                  <input type="text" name="housingAllowance" class="input" value="${escapeHtml(company.housingAllowance || '')}">
                </div>
                <div class="form-field">
                  <label class="form-label">リモートワーク可否</label>
                  <input type="text" name="remoteWork" class="input" value="${escapeHtml(company.remoteWork || '')}">
                </div>
                <div class="form-field">
                  <label class="form-label">給与評価 (0〜5)</label>
                  <select name="ratingSalary" class="select">
                    <option value="0" ${!company.ratingSalary ? 'selected' : ''}>未評価 (0)</option>
                    <option value="5" ${company.ratingSalary === 5 ? 'selected' : ''}>5 / 5</option>
                    <option value="4" ${company.ratingSalary === 4 ? 'selected' : ''}>4 / 5</option>
                    <option value="3" ${company.ratingSalary === 3 ? 'selected' : ''}>3 / 5</option>
                    <option value="2" ${company.ratingSalary === 2 ? 'selected' : ''}>2 / 5</option>
                    <option value="1" ${company.ratingSalary === 1 ? 'selected' : ''}>1 / 5</option>
                  </select>
                </div>
                <div class="form-field">
                  <label class="form-label">福利厚生評価 (0〜5)</label>
                  <select name="ratingBenefits" class="select">
                    <option value="0" ${!company.ratingBenefits ? 'selected' : ''}>未評価 (0)</option>
                    <option value="5" ${company.ratingBenefits === 5 ? 'selected' : ''}>5 / 5</option>
                    <option value="4" ${company.ratingBenefits === 4 ? 'selected' : ''}>4 / 5</option>
                    <option value="3" ${company.ratingBenefits === 3 ? 'selected' : ''}>3 / 5</option>
                    <option value="2" ${company.ratingBenefits === 2 ? 'selected' : ''}>2 / 5</option>
                    <option value="1" ${company.ratingBenefits === 1 ? 'selected' : ''}>1 / 5</option>
                  </select>
                </div>
                <div class="form-field col-span-2">
                  <label class="form-label">給与メモ（昇給・諸手当の内訳など）</label>
                  <input type="text" name="salary" class="input" value="${escapeHtml(company.salary || '')}">
                </div>
                <div class="form-field col-span-2">
                  <label class="form-label">福利厚生メモ</label>
                  <textarea name="benefits" class="textarea">${escapeHtml(company.benefits || '')}</textarea>
                </div>
                <div class="form-field col-span-2" style="display:flex;justify-content:flex-end">
                  <button type="submit" class="btn btn-primary">待遇情報を保存</button>
                </div>
              </form>
            `;

            body.querySelector('#cd-comp-form')?.addEventListener('submit', async (e) => {
              e.preventDefault();
              const f = e.currentTarget;
              const numOrNull = (val) => (val.trim() === '' ? null : Number(val));
              const doSaveComp = async () => {
                try {
                  await apiRequest('PATCH', `/api/companies/${encodeURIComponent(companyId)}`, {
                    annualIncome: numOrNull(f.annualIncome.value),
                    startingSalary: numOrNull(f.startingSalary.value),
                    bonusTimes: numOrNull(f.bonusTimes.value),
                    bonusMonths: numOrNull(f.bonusMonths.value),
                    annualHolidays: numOrNull(f.annualHolidays.value),
                    fixedOvertime: f.fixedOvertime.value,
                    housingAllowance: f.housingAllowance.value,
                    remoteWork: f.remoteWork.value,
                    ratingSalary: Number(f.ratingSalary.value),
                    ratingBenefits: Number(f.ratingBenefits.value),
                    salary: f.salary.value,
                    benefits: f.benefits.value,
                  });
                  state.modalDirty = false;
                  await refreshCompanyDetail();
                  showToast('待遇情報を保存しました。', 'success');
                } catch (err) {
                  showToast(err.message, 'error', doSaveComp);
                }
              };
              await doSaveComp();
            });
          } else if (activeTab === 'ai') {
            let aiMeta = {};
            try {
              if (company.aiExtractedJson) {
                aiMeta = JSON.parse(company.aiExtractedJson);
              }
            } catch {
              aiMeta = {};
            }
            const sources = Array.isArray(aiMeta.sources) ? aiMeta.sources : [];
            const prep = aiMeta.interviewPrepTips || {};

            body.innerHTML = `
              <div class="banner banner-info" style="margin-bottom:12px">
                <div>
                  <span class="chip chip-ai">AI生成参考情報（要出典確認）</span>
                  <span style="font-size:0.8rem;margin-left:6px">
                    AIによる要約・準備案です。提出前・面接前に必ず公式採用ページの一次情報をご確認ください。
                  </span>
                </div>
                <span class="tabular-nums" style="font-size:0.78rem">確認日: ${escapeHtml(aiMeta.verifiedAt || '未記録')}</span>
              </div>

              <div class="panel" style="margin-bottom:12px;padding:12px">
                <h3 style="margin:0 0 6px;font-size:0.88rem">参照元URL（出典）</h3>
                ${
                  sources.length === 0
                    ? `<p style="margin:0;font-size:0.8rem;color:var(--m3-warning)">参照元URLが記録されていません。</p>`
                    : `<ul style="margin:0;padding-left:18px;font-size:0.82rem">
                        ${sources
                          .map(
                            (s) => `
                            <li>
                              <strong>${escapeHtml(s.title || '参照元')}</strong>:
                              <button type="button" class="btn btn-xs btn-ghost" data-open-source="${escapeHtml(s.url)}">${escapeHtml(s.url)} ↗</button>
                            </li>
                          `
                          )
                          .join('')}
                      </ul>`
                }
              </div>

              <div class="form-grid">
                <div class="form-field col-span-2">
                  <span class="form-label">企業概要 / 特徴</span>
                  <div class="panel" style="margin:0;padding:10px;font-size:0.85rem">
                    <div>${escapeHtml(company.description || '未登録')}</div>
                    ${company.features ? `<div style="margin-top:4px;color:var(--m3-on-surface-variant)">特徴: ${escapeHtml(company.features)}</div>` : ''}
                  </div>
                </div>
                <div class="form-field">
                  <span class="form-label">マッチ度判定・理由 (AI参考)</span>
                  <div class="panel" style="margin:0;padding:10px;font-size:0.85rem">
                    <strong>判定: ${escapeHtml(prep.fitLevel || '—')}</strong><br>
                    ${escapeHtml(prep.fitReason || '—')}
                  </div>
                </div>
                <div class="form-field">
                  <span class="form-label">求める人物像 (AI参考)</span>
                  <div class="panel" style="margin:0;padding:10px;font-size:0.85rem">${escapeHtml(prep.idealCandidate || '—')}</div>
                </div>
                <div class="form-field col-span-2">
                  <span class="form-label">有効なアピールポイント案 (AI参考)</span>
                  <div class="panel" style="margin:0;padding:10px;font-size:0.84rem">
                    ${
                      (prep.appealPoints || []).length === 0
                        ? '—'
                        : `<ul style="margin:0;padding-left:18px">${prep.appealPoints.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
                    }
                  </div>
                </div>
                <div class="form-field">
                  <span class="form-label">想定質問リスト</span>
                  <div class="panel" style="margin:0;padding:10px;font-size:0.84rem">
                    ${
                      (prep.expectedQuestions || []).length === 0
                        ? '—'
                        : `<ul style="margin:0;padding-left:18px">${prep.expectedQuestions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>`
                    }
                  </div>
                </div>
                <div class="form-field">
                  <span class="form-label">推奨される逆質問リスト</span>
                  <div class="panel" style="margin:0;padding:10px;font-size:0.84rem">
                    ${
                      (prep.reverseQuestions || []).length === 0
                        ? '—'
                        : `<ul style="margin:0;padding-left:18px">${prep.reverseQuestions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>`
                    }
                  </div>
                </div>
              </div>
            `;

            body.querySelectorAll('[data-open-source]').forEach((btn) => {
              btn.addEventListener('click', () => openSafeExternalUrl(btn.getAttribute('data-open-source')));
            });
          } else if (activeTab === 'notes') {
            body.innerHTML = `
              <form id="cd-notes-form" class="form-grid">
                <div class="form-field">
                  <label class="form-label">企業名 *</label>
                  <input type="text" name="name" class="input" required value="${escapeHtml(company.name)}">
                </div>
                <div class="form-field">
                  <label class="form-label">志望度 (1〜5)</label>
                  <select name="priority" class="select">
                    <option value="5" ${company.priority === 5 ? 'selected' : ''}>★★★★★ (5/5)</option>
                    <option value="4" ${company.priority === 4 ? 'selected' : ''}>★★★★☆ (4/5)</option>
                    <option value="3" ${company.priority === 3 ? 'selected' : ''}>★★★☆☆ (3/5)</option>
                    <option value="2" ${company.priority === 2 ? 'selected' : ''}>★★☆☆☆ (2/5)</option>
                    <option value="1" ${company.priority === 1 ? 'selected' : ''}>★☆☆☆☆ (1/5)</option>
                  </select>
                </div>
                <div class="form-field">
                  <label class="form-label">業界</label>
                  <input type="text" name="industry" class="input" value="${escapeHtml(company.industry || '')}">
                </div>
                <div class="form-field">
                  <label class="form-label">職種</label>
                  <input type="text" name="jobType" class="input" value="${escapeHtml(company.jobType || '')}">
                </div>
                <div class="form-field">
                  <label class="form-label">所在地・勤務地</label>
                  <input type="text" name="location" class="input" value="${escapeHtml(company.location || '')}">
                </div>
                <div class="form-field">
                  <label class="form-label">公式サイトURL</label>
                  <input type="url" name="websiteUrl" class="input" value="${escapeHtml(company.websiteUrl || '')}">
                </div>
                <div class="form-field">
                  <label class="form-label">マイページURL</label>
                  <input type="url" name="myPageUrl" class="input" value="${escapeHtml(company.myPageUrl || '')}">
                </div>
                <div class="form-field">
                  <label class="form-label">マイページID（パスワードはOSのパスワード管理へ）</label>
                  <input type="text" name="myPageId" class="input" value="${escapeHtml(company.myPageId || '')}">
                </div>
                <div class="form-field col-span-2">
                  <label class="form-label">企業概要</label>
                  <textarea name="description" class="textarea" style="min-height:60px">${escapeHtml(company.description || '')}</textarea>
                </div>
                <div class="form-field col-span-2">
                  <label class="form-label">特徴・強み</label>
                  <input type="text" name="features" class="input" value="${escapeHtml(company.features || '')}">
                </div>
                <div class="form-field col-span-2">
                  <label class="checkbox-row">
                    <input type="checkbox" name="isEarlySelection" ${company.isEarlySelection ? 'checked' : ''}>
                    <span>早期選考ルートとして管理する</span>
                  </label>
                </div>
                <div class="form-field col-span-2">
                  <label class="form-label">企業メモ・選考ノート</label>
                  <textarea name="memo" class="textarea" style="min-height:110px">${escapeHtml(company.memo || '')}</textarea>
                </div>
                <div class="form-field col-span-2" style="display:flex;justify-content:flex-end">
                  <button type="submit" class="btn btn-primary">基本情報・メモを保存</button>
                </div>
              </form>
            `;

            body.querySelector('#cd-notes-form')?.addEventListener('submit', async (e) => {
              e.preventDefault();
              const f = e.currentTarget;
              const doSaveNotes = async () => {
                try {
                  await apiRequest('PATCH', `/api/companies/${encodeURIComponent(companyId)}`, {
                    name: f.name.value,
                    priority: Number(f.priority.value),
                    industry: f.industry.value,
                    jobType: f.jobType.value,
                    location: f.location.value,
                    websiteUrl: f.websiteUrl.value,
                    myPageUrl: f.myPageUrl.value,
                    myPageId: f.myPageId.value,
                    description: f.description.value,
                    features: f.features.value,
                    isEarlySelection: f.isEarlySelection.checked,
                    memo: f.memo.value,
                  });
                  state.modalDirty = false;
                  await refreshCompanyDetail();
                  showToast('企業メモ・基本情報を更新しました。', 'success');
                } catch (err) {
                  showToast(err.message, 'error', doSaveNotes);
                }
              };
              await doSaveNotes();
            });
          }
        };

        renderTabContent();

        root.querySelectorAll('[data-cd-tab]').forEach((btn) => {
          btn.addEventListener('click', () => {
            activeTab = btn.getAttribute('data-cd-tab');
            editingStepId = null;
            editingInterviewId = null;
            renderTabContent();
          });
        });
      }
    );
  }

  function openDataManagementModal(triggerEl) {
    let stagedFilePayload = null;
    const hasRollback = Boolean(state.dbStatus && state.dbStatus.hasPreImportSnapshot);

    openModal(
      `
      <div class="modal-dialog modal-lg" role="dialog" aria-modal="true" aria-labelledby="dm-modal-title">
        <div class="modal-header">
          <div>
            <h2 id="dm-modal-title" class="modal-title">データ管理・バックアップ・旧版データ移行</h2>
            <p class="modal-subtitle">すべてユーザーの明示操作と事前プレビューに基づいて安全に実行されます</p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-modal-close aria-label="閉じる">✕ 閉じる</button>
        </div>
        <div class="modal-body">
          <!-- Section 1: Export -->
          <div class="panel">
            <h3 class="panel-title" style="margin-bottom:6px">1. JSONバックアップ出力</h3>
            <div class="banner banner-warning" style="margin-bottom:10px;font-size:0.8rem">
              <strong>⚠ 個人情報・機微情報の取り扱い注意:</strong>
              出力されるJSONファイルには登録企業、マイページID、面接記録、選考メモが含まれます。暗号化されていないJSONファイルのため保管場所にご注意ください。
            </div>
            <button type="button" id="btn-export-backup" class="btn btn-primary">⬇ JSONバックアップをダウンロード</button>
          </div>

          <div class="panel" id="google-drive-panel"></div>

          <!-- Section 2: Import with Preview & Rollback -->
          <div class="panel">
            <h3 class="panel-title" style="margin-bottom:6px">2. 旧版 SQLite (.db) / JSON バックアップからの明示インポート</h3>
            <p style="margin:0 0 10px;font-size:0.8rem;color:var(--m3-on-surface-variant)">
              選択したファイルを一時コピー上で検査し、件数・除外項目（旧DB内のマイページパスワード・認証トークン等）をプレビュー表示します。自動移行は行いません。
            </p>
            <div class="import-controls">
              <input type="file" id="dm-import-file" accept=".db,.sqlite,.sqlite3,.json" class="input" style="max-width:340px">
              <select id="dm-import-mode" data-no-dirty class="select">
                <option value="replace">既存データを置換（事前スナップショット保存）</option>
                <option value="merge">既存データに追加マージ</option>
              </select>
              <button type="button" id="btn-preview-import" class="btn btn-tonal">🔍 インポート内容をプレビュー</button>
            </div>
            <div id="dm-preview-result"></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
              <button type="button" id="btn-exec-import" class="btn btn-primary" disabled>インポートを実行</button>
              <button type="button" id="btn-rollback-import" class="btn btn-danger" ${hasRollback ? '' : 'disabled'}>
                ↩ 直前のインポートをロールバック
              </button>
            </div>
          </div>

          <!-- Section 3: Update Check & App Isolation -->
          <div class="panel" style="margin-bottom:0">
            <h3 class="panel-title" style="margin-bottom:6px">3. アプリ更新確認・データ領域の独立性</h3>
            <p style="margin:0 0 10px;font-size:0.8rem;color:var(--m3-on-surface-variant)">
              App ID: <code>jp.jobtracker.app</code> / 旧版 <code>job-research</code> のデータ領域や更新チャネルとは完全に分離されています。
            </p>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <button type="button" id="btn-check-update" class="btn btn-outlined">更新を確認</button>
              <span id="dm-update-status" style="font-size:0.8rem;color:var(--m3-on-surface-variant)"></span>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outlined" data-modal-close>閉じる</button>
        </div>
      </div>
      `,
      triggerEl,
      (root) => {
        window.JobTrackerDrive.mount(root, { invoke: ipcInvoke, escapeHtml, onRestore: async () => { await loadAllData(); const rollback = root.querySelector('#btn-rollback-import'); if (rollback) rollback.disabled = false; } });
        root.querySelector('#btn-export-backup')?.addEventListener('click', async () => {
          try {
            const res = await apiRequest('GET', '/api/data/backup');
            const content = JSON.stringify(res.backup, null, 2);
            const blob = new Blob([content], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `job-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            showToast('バックアップJSONを出力しました。保管場所にご注意ください。', 'success');
          } catch (err) {
            showToast(err.message, 'error');
          }
        });

        const fileInput = root.querySelector('#dm-import-file');
        const previewArea = root.querySelector('#dm-preview-result');
        const execBtn = root.querySelector('#btn-exec-import');
        const rollbackBtn = root.querySelector('#btn-rollback-import');

        fileInput.addEventListener('change', () => {
          stagedFilePayload = null;
          execBtn.disabled = true;
          previewArea.textContent = '';
        });

        const readSelectedFile = () =>
          new Promise((resolve, reject) => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) {
              reject(new Error('インポートするファイル（.db または .json）を選択してください。'));
              return;
            }
            const isSqlite = /\.(db|sqlite|sqlite3)$/i.test(file.name);
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('ファイルの読み取りに失敗しました。'));
            if (isSqlite) {
              reader.onload = () => {
                const bytes = new Uint8Array(reader.result);
                let binary = '';
                for (let i = 0; i < bytes.byteLength; i++) {
                  binary += String.fromCharCode(bytes[i]);
                }
                resolve({ kind: 'sqlite_base64', base64: btoa(binary), fileName: file.name });
              };
              reader.readAsArrayBuffer(file);
            } else {
              reader.onload = () => {
                resolve({ kind: 'json', payload: String(reader.result), fileName: file.name });
              };
              reader.readAsText(file, 'utf8');
            }
          });

        root.querySelector('#btn-preview-import')?.addEventListener('click', async () => {
          try {
            stagedFilePayload = await readSelectedFile();
            const res = await apiRequest('POST', '/api/data/import/preview', stagedFilePayload);
            const p = res.preview;
            execBtn.disabled = false;
            previewArea.innerHTML = `
              <div class="banner banner-info" style="flex-direction:column;align-items:stretch">
                <strong>✓ インポート事前プレビュー (${escapeHtml(stagedFilePayload.fileName)})</strong>
                <div style="font-size:0.82rem">
                  企業: <strong>${p.counts.companies}社</strong> /
                  選考ステップ: <strong>${p.counts.steps}件</strong> /
                  面接記録: <strong>${p.counts.interviews}件</strong> /
                  予定: <strong>${p.counts.events}件</strong> /
                  就活プロフィール: <strong>${p.hasCareerProfile ? '含む（復元対象）' : 'なし（既存を維持）'}</strong>
                </div>
                <div style="font-size:0.78rem;color:var(--m3-warning)">
                  • 安全のため除外されるフィールド: ${escapeHtml((p.strippedFields || []).join(', '))}
                </div>
              </div>
            `;
          } catch (err) {
            stagedFilePayload = null;
            execBtn.disabled = true;
            previewArea.innerHTML = `<div class="banner banner-error">⚠ ${escapeHtml(err.message)}</div>`;
          }
        });

        execBtn?.addEventListener('click', async () => {
          if (!stagedFilePayload) return;
          const mode = root.querySelector('#dm-import-mode')?.value || 'replace';
          try {
            execBtn.disabled = true;
            const res = await apiRequest('POST', '/api/data/import/execute', {
              ...stagedFilePayload,
              mode,
            });
            if (rollbackBtn) rollbackBtn.disabled = false;
            await loadAllData();
            showToast(
              `インポート完了: 企業 ${res.counts.companies}社${res.profileRestored ? '・就活プロフィール' : ''}を取り込みました`,
              'success'
            );
          } catch (err) {
            execBtn.disabled = false;
            showToast(err.message, 'error');
          }
        });

        rollbackBtn?.addEventListener('click', async () => {
          try {
            await apiRequest('POST', '/api/data/import/rollback');
            rollbackBtn.disabled = true;
            await loadAllData();
            showToast('直前のインポート前の状態にロールバックしました。', 'success');
          } catch (err) {
            showToast(err.message, 'error');
          }
        });

        root.querySelector('#btn-check-update')?.addEventListener('click', (event) => openUpdatesModal(event.currentTarget));

      }
    );
  }

  function openUpdatesModal(triggerElement) {
    if (state.activeModal && !requestCloseModal()) return;
    openModal(`
      <div class="modal-dialog modal-sm" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <div class="modal-header"><h2 class="modal-title" id="update-title">バージョン情報・更新確認</h2>
          <button type="button" class="btn btn-ghost" data-modal-close aria-label="閉じる">✕</button></div>
        <div class="modal-body">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;background:var(--m3-surface-container);border-radius:var(--radius-md);margin-bottom:12px">
            <div>
              <div style="font-weight:700;font-size:0.95rem;color:var(--m3-on-surface)">就活トラッカー</div>
              <div style="font-size:0.8rem;color:var(--m3-on-surface-variant);margin-top:2px">現在のバージョン: <strong id="modal-current-version" style="color:var(--m3-on-surface)">v${escapeHtml(state.updateStatus?.currentVersion || '2.0.0')}</strong></div>
            </div>
            <span class="status-pill status-pill-success" style="background:var(--m3-primary-container);color:var(--m3-on-primary-container);font-size:0.75rem">Desktop</span>
          </div>
          <p id="update-message" role="status" aria-live="polite">更新情報を確認しています…</p>
          <p id="update-signature" class="muted"></p>
          <pre id="update-notes" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
        </div>
        <div class="modal-footer" style="flex-wrap:wrap">
          <button type="button" class="btn btn-outlined" id="update-check">再確認</button>
          <button type="button" class="btn btn-primary" id="update-download" hidden>ダウンロード</button>
          <button type="button" class="btn btn-primary" id="update-install" hidden>インストーラーを開く</button>
        </div>
      </div>`, triggerElement, (root) => {
      const check = root.querySelector('#update-check');
      const download = root.querySelector('#update-download');
      const install = root.querySelector('#update-install');
      let busy = false;
      const render = (status) => {
        state.updateStatus = status;
        if (status.currentVersion) {
          const verEl = root.querySelector('#modal-current-version');
          if (verEl) verEl.textContent = `v${status.currentVersion}`;
        }
        const labels = { checking: '確認中…', downloading: 'ダウンロード中…', current: '現在のバージョンは最新です。', ready: 'ファイルのサイズとSHA-256を検証しました。', opened: 'インストーラーを開きました。', available: `バージョン ${status.latestVersion || ''} を利用できます。` };
        if (!root.querySelector('#update-message')) return;
        root.querySelector('#update-message').textContent = status.error || status.notice || labels[status.status] || '更新を確認できます。';
        root.querySelector('#update-notes').textContent = status.releaseNotes || '';
        root.querySelector('#update-signature').textContent = ['available', 'ready'].includes(status.status)
          ? 'コード署名の有効性はOS側で別途確認してください。インストーラーは確認操作後に開きます。' : '';
        download.hidden = status.status !== 'available';
        install.hidden = status.status !== 'ready';
      };
      const run = async (method) => {
        if (busy) return;
        busy = true;
        check.disabled = download.disabled = install.disabled = true;
        const message = root.querySelector('#update-message');
        if (message) message.textContent = method === 'downloadUpdate' ? '取得してサイズとハッシュを検証しています…' : method === 'installUpdate' ? 'インストーラーを開いています…' : '更新情報を確認しています…';
        try {
          const result = await ipcInvoke(method);
          render(method === 'installUpdate' ? { ...state.updateStatus, status: 'opened' } : result);
        } catch (error) { render({ ...state.updateStatus, error: error.message }); }
        finally { busy = false; check.disabled = download.disabled = install.disabled = false; }
      };
      check.addEventListener('click', () => run('checkForUpdates'));
      download.addEventListener('click', () => run('downloadUpdate'));
      install.addEventListener('click', () => {
        if (window.confirm('検証した更新ファイルのインストーラーを開きますか？ OSの署名・権限の確認画面も確認してください。')) run('installUpdate');
      });
      run('checkForUpdates');
    });
  }

  async function openAppSettingsModal(trigger) {
    try {
      const settings = await ipcInvoke('getAppSettings');
      const capability = settings.authentication;
      openModal(`
        <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="app-settings-title">
          <div class="modal-header"><h2 id="app-settings-title" class="modal-title">アプリ設定</h2><button type="button" class="btn btn-ghost" data-modal-close aria-label="閉じる">✕</button></div>
          <form id="app-settings-form" class="settings-form">
            <div class="modal-body">
              <div class="form-grid">
                <label class="form-field col-span-2"><span class="form-label">テーマ</span><select id="setting-theme" class="select">${[['system','システムに合わせる'],['light','ライト'],['dark','ダーク']].map(([value,label]) => `<option value="${value}" ${settings.theme === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
                <fieldset class="theme-options col-span-2"><legend class="form-label">アクセント色</legend>
                  <div class="theme-options-grid">${[['purple','パープル'],['blue','ブルー'],['green','グリーン'],['rose','ローズ']].map(([value,label]) => `
                    <label class="theme-option">
                      <input type="radio" name="setting-accent" value="${value}" ${settings.accent === value ? 'checked' : ''}>
                      <span class="theme-option-content">
                        <span class="theme-option-name">${label}<span class="theme-selected" aria-hidden="true">✓</span></span>
                        <span class="theme-preview-pair" aria-hidden="true">${[['light','ライト'],['dark','ダーク']].map(([mode,name]) => `<span class="theme-preview" data-color-mode="${mode}" data-accent="${value}"><span class="theme-preview-label">${name}</span><span class="theme-preview-primary">Aa</span><span class="theme-preview-container">Aa</span></span>`).join('')}</span>
                      </span>
                    </label>`).join('')}</div>
                </fieldset>
              </div>
              <h3>起動時ロック</h3>
              <label class="checkbox-row"><input id="setting-lock" type="checkbox" ${settings.lockOnStartup ? 'checked' : ''} ${capability.available ? '' : 'disabled'}><span>アプリ起動時にOS認証を求める</span></label>
              <p class="settings-note">${escapeHtml(capability.label)}を使います。有効化・無効化するときにも認証が必要です。</p>
              ${capability.available ? '' : `<p class="settings-note" role="status">${escapeHtml(capability.reason)}</p>`}
              <p class="settings-note">初期設定はオフです。認証をキャンセルするとアプリは開きません。この機能はアプリを開く際のロックで、保存済みDBを暗号化するものではありません。</p>
              <p id="app-settings-message" role="status" aria-live="polite"></p>
            </div>
            <div class="modal-footer"><button type="button" class="btn btn-outlined" data-modal-close>キャンセル</button><button type="submit" class="btn btn-primary">保存</button></div>
          </form>
        </div>`, trigger, (root) => {
        root.querySelector('#app-settings-form').addEventListener('submit', async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const message = root.querySelector('#app-settings-message');
          const theme = root.querySelector('#setting-theme').value;
          const accent = root.querySelector('input[name="setting-accent"]:checked').value;
          const lockOnStartup = root.querySelector('#setting-lock').checked;
          const button = root.querySelector('button[type=submit]');
          if (button.disabled) return;
          button.disabled = true;
          message.textContent = lockOnStartup !== settings.lockOnStartup ? 'OSの認証画面で確認してください…' : '保存しています…';
          try {
            const saved = await ipcInvoke('saveAppSettings', { theme, accent, lockOnStartup });
            window.JobTrackerAppearance.apply(saved.theme, saved.accent);
            if (state.activeModal === root && root.contains(form)) requestCloseModal(true);
            showToast('アプリ設定を保存しました', 'success');
          } catch (error) {
            message.textContent = error.message;
          } finally { button.disabled = false; }
        });
      });
    } catch (error) { showToast(error.message, 'error'); }
  }

  function initApp() {
    window.setInterval(renderNextEvent, 60000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) renderNextEvent();
    });
    document.querySelectorAll('.view-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeView = btn.getAttribute('data-view') || 'kanban';
        renderAll();
      });
    });

    document.getElementById('btn-add-manual')?.addEventListener('click', (e) => openManualAddModal(e.currentTarget));
    document.getElementById('btn-add-prompt')?.addEventListener('click', (e) => openPromptAddModal(e.currentTarget));
    document.getElementById('btn-career-profile')?.addEventListener('click', (e) => openCareerProfileModal(e.currentTarget));
    document.getElementById('btn-data-manage')?.addEventListener('click', (e) => openDataManagementModal(e.currentTarget));
    document.getElementById('btn-app-settings')?.addEventListener('click', (e) => openAppSettingsModal(e.currentTarget));
    document.getElementById('btn-version')?.addEventListener('click', (event) => openUpdatesModal(event.currentTarget));
    document.getElementById('btn-refresh')?.addEventListener('click', (event) => openUpdatesModal(event.currentTarget));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && state.activeModal) {
        const items = [...state.activeModal.querySelectorAll('button, input, select, textarea, a[href], [tabindex=\"0\"]')].filter((el) => !el.disabled && !el.hidden && el.getClientRects().length);
        const first = items[0], last = items[items.length - 1];
        if (items.length && ((!e.shiftKey && document.activeElement === last) || (e.shiftKey && document.activeElement === first))) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      }
      if (e.key === 'Escape' && state.activeModal) {
        e.preventDefault();
        requestCloseModal();
      } else if (e.key === 'Escape' && kanbanExpansion) {
        e.preventDefault();
        collapseKanbanLane();
      }
    });

    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get('view');
    if (viewParam && ['kanban', 'table', 'schedule', 'compensation'].includes(viewParam)) {
      state.activeView = viewParam;
    }
    if (params.get('zoom') === '200') {
      document.documentElement.classList.add('is-zoom-200');
      document.documentElement.style.zoom = '2';
    }

    loadAllData().then(() => {
      ipcInvoke('checkForUpdates').then((status) => {
        state.updateStatus = status;
        if (status.available) showToast('アプリの新版があります。バージョンボタン（Desktop v2.0）から内容を確認できます。', 'info');
      }).catch(() => {});
      const modalParam = params.get('modal');
      if (modalParam === 'prompt') {
        openPromptAddModal(document.getElementById('btn-add-prompt'));
      } else if (modalParam === 'manual') {
        openManualAddModal(document.getElementById('btn-add-manual'));
      } else if (modalParam === 'profile') {
        openCareerProfileModal(document.getElementById('btn-career-profile'));
      } else if (modalParam === 'data') {
        openDataManagementModal(document.getElementById('btn-data-manage'));
      } else if (modalParam === 'detail' && state.companies.length > 0) {
        openCompanyDetailModal(state.companies[0].id, null, params.get('tab') || 'steps');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
