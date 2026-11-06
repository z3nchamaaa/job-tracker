(function () {
  'use strict';
  const RETENTION_CHOICES = [3, 5, 10, 20, 30];
  const counts = (p) => `企業 ${Number(p.companies) || 0}社 ／ 選考 ${Number(p.steps) || 0}件 ／ 面接記録 ${Number(p.interviews) || 0}件 ／ 予定 ${Number(p.events) || 0}件`;
  const when = (value) => (Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '日時不明');
  const confirmUpload = (p) => window.confirm(`次のバックアップをGoogle Driveへ送信しますか？\n${counts(p.counts)}\n約${Math.ceil(p.bytes / 1024)} KiB\n\n就活プロフィール・企業メモ・マイページID等を含む、暗号化されていないJSONです。認証トークンとパスワードは含みません。`);
  const uploadMessage = (result) => {
    if (result.pruneError) return `Driveへバックアップを保存しました。ただし古いバックアップの自動削除に失敗しました：${result.pruneError}`;
    return result.pruned ? `Driveへバックアップを保存し、古いバックアップを${result.pruned}件削除しました。` : 'Driveへバックアップを保存しました。';
  };
  const restoreBanner = (escapeHtml, preview, heading) => `<div class="banner banner-info drive-restore"><strong>${heading}復元内容：${escapeHtml(counts(preview.counts))}</strong><p>就活プロフィール：${preview.hasCareerProfile ? '復元対象' : '既存を維持'}。実行前の状態はローカルに退避し、既存の取り消し機能で戻せます。</p><label>復元方法 <select class="select" data-drive-restore-mode data-no-dirty><option value="merge">既存データへ追加</option><option value="replace">既存データを置換</option></select></label><button type="button" class="btn btn-primary" data-drive-restore>この内容で復元する</button></div>`;
  const RESTORED = 'バックアップを復元しました。必要なら「データ管理」の「直前のインポートをロールバック」で取り消せます。';

  // Compact panel for the data management modal: save now, or restore the newest backup.
  // Connecting, browsing, deleting and retention stay in app settings.
  function mountQuick(root, { invoke, escapeHtml, onRestore }) {
    const panel = root.querySelector('#drive-quick-panel');
    let status = {}, busy = false, restoreToken = '';
    panel.innerHTML = `
      <h3 class="panel-title" style="margin-bottom:6px">Google Driveバックアップ</h3>
      <p class="settings-note">Google Driveへの接続・解除、一覧からの復元、古いバックアップの削除は「アプリ設定」のGoogle Drive項目から行えます。</p>
      <p id="drive-quick-status" class="settings-note"></p>
      <div class="drive-actions">
        <button type="button" class="btn btn-sm btn-primary" id="drive-quick-upload" disabled>内容を確認してDriveへ保存</button>
        <button type="button" class="btn btn-sm btn-outlined" id="drive-quick-latest" disabled>最新のバックアップから復元</button>
      </div>
      <p id="drive-quick-message" role="status" aria-live="polite"></p>
      <div id="drive-quick-preview"></div>`;
    const message = panel.querySelector('#drive-quick-message'), area = panel.querySelector('#drive-quick-preview');
    const alive = () => panel.isConnected;
    const render = () => {
      if (!alive()) return;
      const ready = status.connected && !busy && !status.busy && !status.signingIn;
      panel.querySelector('#drive-quick-status').textContent = !status.configured
        ? 'このビルドにはGoogle接続設定が含まれていないため、Driveバックアップは利用できません。'
        : status.connected ? 'Google Driveに接続済みです。'
        : 'Google Driveに接続していません。「アプリ設定」のGoogle Drive項目から接続してください。';
      panel.querySelector('#drive-quick-upload').disabled = !ready;
      panel.querySelector('#drive-quick-latest').disabled = !ready;
      const restore = area.querySelector('[data-drive-restore]');
      if (restore) restore.disabled = !ready;
    };
    const run = async (action) => {
      if (busy) return;
      busy = true; message.textContent = '処理しています…'; render();
      try { const text = await action(); if (alive()) message.textContent = text || ''; }
      catch (e) { if (alive()) message.textContent = e.message; }
      finally {
        try { status = await invoke('getGoogleDriveStatus'); } catch {}
        busy = false; render();
      }
    };
    panel.querySelector('#drive-quick-upload').addEventListener('click', () => run(async () => {
      const p = await invoke('prepareGoogleDriveBackup');
      if (!confirmUpload(p)) return 'Driveへの保存を中止しました。';
      return uploadMessage(await invoke('uploadGoogleDriveBackup', { token: p.token }));
    }));
    panel.querySelector('#drive-quick-latest').addEventListener('click', () => run(async () => {
      restoreToken = ''; area.replaceChildren();
      const [latest] = (await invoke('listGoogleDriveBackups', {})).files;
      if (!latest) return 'Driveにバックアップはありません。';
      const result = await invoke('previewGoogleDriveBackup', { id: latest.id });
      restoreToken = result.token;
      area.innerHTML = restoreBanner(escapeHtml, result.preview, `最新（${escapeHtml(when(latest.createdTime))}）の`);
      area.querySelector('[data-drive-restore]').addEventListener('click', () => {
        if (!restoreToken || !window.confirm(`${when(latest.createdTime)} のバックアップをローカルへ復元しますか？ 選んだ復元方法と件数を確認してください。`)) return;
        run(async () => {
          await invoke('restoreGoogleDriveBackup', { token: restoreToken, mode: area.querySelector('[data-drive-restore-mode]').value });
          restoreToken = ''; area.replaceChildren(); await onRestore(); return RESTORED;
        });
      });
      return '最新のバックアップをプレビューしました。まだローカルデータは変更していません。';
    }));
    root.addEventListener('jt-modal-close', () => { invoke('cancelGoogleDriveTransfer').catch(() => {}); }, { once: true });
    invoke('getGoogleDriveStatus').then((value) => { status = value; render(); }).catch((e) => { if (alive()) message.textContent = e.message; });
    render();
  }

  function mount(root, { invoke, escapeHtml, onRestore }) {
    const panel = root.querySelector('#google-drive-panel');
    let status = {}, busy = false, timer = null, restoreToken = '', pageToken = '', files = [], listed = false;
    panel.innerHTML = `
      <h3 class="panel-title">Google Driveバックアップ</h3>
      <p class="settings-note">Googleアカウントで一度ログインするだけで、このアプリ専用の保存領域へバックアップできます。通常のDrive画面には表示されず、ほかのDriveファイルにはアクセスしません。自動同期は行いません。</p>
      <p id="drive-status" class="settings-note"></p>
      <div id="drive-controls" class="drive-actions"></div>
      <p id="drive-message" role="status" aria-live="polite"></p>
      <fieldset class="drive-retention" id="drive-retention">
        <legend class="form-label">古いバックアップの整理</legend>
        <label class="drive-inline">残す件数
          <select id="drive-retention-count" class="select" data-no-dirty>${RETENTION_CHOICES.map((n) => `<option value="${n}">最新${n}件</option>`).join('')}</select>
        </label>
        <label class="checkbox-row"><input id="drive-auto-prune" type="checkbox" data-no-dirty><span>Driveへ保存したとき、残す件数より古いバックアップを自動で削除する</span></label>
        <button type="button" class="btn btn-sm btn-outlined" id="drive-prune">今すぐ古いバックアップを削除</button>
        <p class="settings-note" id="drive-limits"></p>
      </fieldset>
      <div id="drive-backups" class="drive-backups"></div>
      <div id="drive-preview"></div>`;
    const message = panel.querySelector('#drive-message'), controls = panel.querySelector('#drive-controls');
    const countSelect = panel.querySelector('#drive-retention-count'), autoPrune = panel.querySelector('#drive-auto-prune');
    const alive = () => panel.isConnected;
    const resetResults = () => { files = []; pageToken = ''; listed = false; restoreToken = ''; renderFiles(); panel.querySelector('#drive-preview').replaceChildren(); };
    const render = () => {
      if (!alive()) return;
      const locked = busy || status.signingIn || status.busy;
      panel.querySelector('#drive-status').textContent = !status.configured
        ? 'このビルドにはGoogle接続設定が含まれていないため、Driveバックアップは利用できません。JSONバックアップをご利用ください。'
        : status.signingIn ? 'ブラウザーでGoogleアカウントを選び、接続を承認してください。'
        : status.connected ? 'Google Driveに接続済みです。'
        : status.needsReconnect ? '接続方式が変わりました。お手数ですが「Googleに接続」からもう一度ログインしてください。'
        : '「Googleに接続」を押し、ブラウザーで自分のGoogleアカウントを選ぶだけで利用できます。';
      controls.innerHTML = status.signingIn ? '<button type="button" class="btn btn-sm btn-outlined" id="drive-cancel-login">接続を中断</button>' : `
        <button type="button" class="btn btn-sm ${status.connected ? 'btn-outlined' : 'btn-primary'}" id="drive-connect" ${busy || !status.configured || !status.encryptedStorageAvailable ? 'disabled' : ''}>${status.connected ? 'Googleに再接続' : 'Googleに接続'}</button>
        <button type="button" class="btn btn-sm btn-primary" id="drive-upload" ${busy || !status.connected ? 'disabled' : ''}>内容を確認してDriveへ保存</button>
        <button type="button" class="btn btn-sm btn-outlined" id="drive-list" ${busy || !status.connected ? 'disabled' : ''}>バックアップ一覧を取得</button>
        ${status.connected || status.needsReconnect ? `<button type="button" class="btn btn-sm btn-outlined" id="drive-disconnect" ${busy ? 'disabled' : ''}>Googleの許可を解除</button><button type="button" class="btn btn-sm btn-outlined" id="drive-forget" ${busy ? 'disabled' : ''}>この端末の接続情報だけ削除</button>` : ''}
        ${busy || status.busy ? '<button type="button" class="btn btn-sm btn-outlined" id="drive-cancel-transfer">転送を中断</button>' : ''}`;
      const settings = status.settings || {}, limits = status.limits || {};
      if (settings.retentionCount && document.activeElement !== countSelect) countSelect.value = String(settings.retentionCount);
      autoPrune.checked = Boolean(settings.autoPrune);
      countSelect.disabled = autoPrune.disabled = locked || !status.configured;
      panel.querySelector('#drive-prune').disabled = locked || !status.connected;
      panel.querySelector('#drive-limits').textContent = status.configured
        ? `使いすぎを防ぐため、Driveへの保存は1日${limits.uploadsPerDay}回・${limits.uploadIntervalSeconds}秒に1回まで、保存できるバックアップは${limits.maxStored}件までです（本日の保存：${status.usage?.uploadsToday || 0}回）。削除したバックアップは元に戻せません。`
        : '';
      controls.querySelector('#drive-connect')?.addEventListener('click', () => run(async () => { await invoke('beginGoogleDriveLogin'); return 'ブラウザーでGoogleの接続を承認してください。'; }));
      controls.querySelector('#drive-cancel-login')?.addEventListener('click', () => run(async () => { await invoke('cancelGoogleDriveLogin'); return '接続を中断しました。'; }));
      controls.querySelector('#drive-cancel-transfer')?.addEventListener('click', () => invoke('cancelGoogleDriveTransfer').catch((e) => { message.textContent = e.message; }));
      controls.querySelector('#drive-upload')?.addEventListener('click', () => run(async () => {
        const p = await invoke('prepareGoogleDriveBackup');
        if (!confirmUpload(p)) return 'Driveへの保存を中止しました。';
        const result = await invoke('uploadGoogleDriveBackup', { token: p.token });
        if (listed) await refreshFiles();
        const text = uploadMessage(result);
        return result.pruneError || result.pruned ? text : text + '一覧から確認できます。';
      }));
      controls.querySelector('#drive-list')?.addEventListener('click', () => loadFiles(false));
      for (const [id, localOnly] of [['drive-disconnect', false], ['drive-forget', true]]) {
        controls.querySelector('#' + id)?.addEventListener('click', () => {
          if (!window.confirm(localOnly ? 'この端末の接続情報だけを削除しますか？ Google側の許可は残ります。Driveのバックアップとローカルデータは削除しません。' : 'このアプリに与えたGoogleの許可を解除しますか？ Driveのバックアップとローカルデータは削除しません。')) return;
          run(async () => { await invoke('disconnectGoogleDrive', { localOnly }); resetResults(); return '接続を解除しました。'; });
        });
      }
    };
    const poll = () => {
      clearTimeout(timer);
      if (!alive() || !status.signingIn) return;
      timer = setTimeout(async () => {
        try { status = await invoke('getGoogleDriveStatus'); render(); if (status.error) message.textContent = status.error; }
        catch (e) { if (alive()) message.textContent = e.message; }
        poll();
      }, 1000);
    };
    const run = async (action) => {
      if (busy) return;
      busy = true; message.textContent = '処理しています…'; render();
      try { const text = await action(); if (alive()) message.textContent = text || ''; }
      catch (e) { if (alive()) message.textContent = e.message; }
      finally {
        try { status = await invoke('getGoogleDriveStatus'); } catch {}
        busy = false; render(); poll();
      }
    };
    const renderFiles = () => {
      if (!alive()) return;
      const list = panel.querySelector('#drive-backups');
      list.innerHTML = files.length ? `<ul class="drive-backup-list">${files.map((f) => `<li><span>${escapeHtml(f.name)}<small>${escapeHtml(when(f.createdTime))} ／ ${Math.ceil(f.bytes / 1024)} KiB</small></span><span class="drive-file-actions"><button type="button" class="btn btn-sm btn-outlined" data-drive-preview="${escapeHtml(f.id)}">復元内容をプレビュー</button><button type="button" class="btn btn-sm btn-danger" data-drive-delete="${escapeHtml(f.id)}" data-drive-label="${escapeHtml(when(f.createdTime))}">削除</button></span></li>`).join('')}</ul>${pageToken ? '<button type="button" class="btn btn-sm btn-outlined" id="drive-more">さらに表示</button>' : ''}`
        : `<p class="settings-note">${listed ? 'Driveにバックアップはありません。' : 'バックアップは表示されていません。「バックアップ一覧を取得」で確認できます。'}</p>`;
      list.querySelector('#drive-more')?.addEventListener('click', () => loadFiles(true));
      list.querySelectorAll('[data-drive-delete]').forEach((button) => button.addEventListener('click', () => {
        if (!window.confirm(`${button.dataset.driveLabel} のバックアップをGoogle Driveから削除しますか？\n削除したバックアップは元に戻せません。ローカルデータは変更しません。`)) return;
        run(async () => {
          await invoke('deleteGoogleDriveBackup', { id: button.dataset.driveDelete });
          files = files.filter((f) => f.id !== button.dataset.driveDelete); renderFiles();
          panel.querySelector('#drive-preview').replaceChildren(); restoreToken = '';
          return 'バックアップを削除しました。';
        });
      }));
      list.querySelectorAll('[data-drive-preview]').forEach((button) => button.addEventListener('click', () => run(async () => {
        restoreToken = ''; const area = panel.querySelector('#drive-preview'); area.replaceChildren();
        const result = await invoke('previewGoogleDriveBackup', { id: button.dataset.drivePreview });
        restoreToken = result.token;
        area.innerHTML = restoreBanner(escapeHtml, result.preview, '');
        const restore = area.querySelector('[data-drive-restore]');
        restore.id = 'drive-restore'; area.querySelector('[data-drive-restore-mode]').id = 'drive-restore-mode';
        restore.addEventListener('click', () => {
          if (!restoreToken || !window.confirm('プレビューしたバックアップをローカルへ復元しますか？ 選んだ復元方法と件数を確認してください。')) return;
          run(async () => { await invoke('restoreGoogleDriveBackup', { token: restoreToken, mode: area.querySelector('#drive-restore-mode').value }); restoreToken = ''; area.replaceChildren(); await onRestore(); return RESTORED; });
        });
        return 'プレビューしました。まだローカルデータは変更していません。';
      })));
    };
    const refreshFiles = async () => {
      const result = await invoke('listGoogleDriveBackups', {});
      files = result.files; pageToken = result.nextPageToken; listed = true; renderFiles();
    };
    const loadFiles = (more) => run(async () => {
      if (!more) { await refreshFiles(); return 'バックアップ一覧を取得しました。'; }
      const result = await invoke('listGoogleDriveBackups', { pageToken });
      files = files.concat(result.files); pageToken = result.nextPageToken;
      renderFiles(); return 'バックアップ一覧を取得しました。';
    });
    const saveSettings = () => {
      // Read the inputs before run() re-renders them from the last saved status.
      const next = { retentionCount: Number(countSelect.value), autoPrune: autoPrune.checked };
      status = { ...status, settings: next };
      return run(async () => {
        await invoke('saveGoogleDriveSettings', next);
        return next.autoPrune ? `Driveへ保存するたびに、最新${next.retentionCount}件より古いバックアップを自動で削除します。` : `残す件数を最新${next.retentionCount}件に設定しました。古いバックアップは自動では削除しません。`;
      });
    };
    countSelect.addEventListener('change', saveSettings);
    autoPrune.addEventListener('change', () => {
      if (autoPrune.checked && !window.confirm(`Driveへ保存するたびに、最新${countSelect.value}件より古いバックアップを自動で削除します。削除したバックアップは元に戻せません。有効にしますか？`)) { autoPrune.checked = false; return; }
      saveSettings();
    });
    panel.querySelector('#drive-prune').addEventListener('click', () => run(async () => {
      const keep = Number(countSelect.value);
      const plan = await invoke('prepareGoogleDrivePrune', { keep });
      if (!plan.count) return `削除対象はありません（Driveのバックアップ：${plan.total}件、残す件数：最新${keep}件）。`;
      if (!window.confirm(`最新${keep}件を残し、古いバックアップ${plan.count}件をGoogle Driveから削除しますか？\n対象：${when(plan.oldest)} 〜 ${when(plan.newest)}\n削除したバックアップは元に戻せません。ローカルデータは変更しません。${plan.more ? '\n\n件数が多いため、一度に削除できない分は再度実行してください。' : ''}`)) return '削除を中止しました。';
      const result = await invoke('pruneGoogleDriveBackups', { token: plan.token });
      panel.querySelector('#drive-preview').replaceChildren(); restoreToken = '';
      if (listed) await refreshFiles();
      return `古いバックアップを${result.deleted}件削除しました。`;
    }));
    root.addEventListener('jt-modal-close', () => { clearTimeout(timer); invoke('cancelGoogleDriveLogin').catch(() => {}); invoke('cancelGoogleDriveTransfer').catch(() => {}); }, { once: true });
    invoke('getGoogleDriveStatus').then((value) => { status = value; if (alive()) { render(); poll(); } }).catch((e) => { if (alive()) message.textContent = e.message; });
    render(); renderFiles();
  }
  window.JobTrackerDrive = Object.freeze({ mount, mountQuick });
})();
