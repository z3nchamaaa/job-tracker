(function () {
  'use strict';
  function mount(root, { invoke, escapeHtml, onRestore }) {
    const panel = root.querySelector('#google-drive-panel');
    let status = {}, busy = false, timer = null, restoreToken = '', pageToken = '', files = [];
    panel.innerHTML = `
      <h3 class="panel-title">Google Driveバックアップ</h3>
      <p class="settings-note">このアプリ専用の保存領域へ、必要なときだけバックアップします。通常のDrive画面には表示されません。自動同期や他のDriveファイルへのアクセスは行いません。</p>
      <details class="drive-config"><summary>詳細設定（独自のGoogle接続設定）</summary>
        <p class="settings-note">通常は設定せず「Googleに接続」から利用できます。独自のGoogle Cloudプロジェクトを使う場合だけ、「デスクトップ アプリ」用クライアントを登録してください。接続先を変更すると再ログインが必要になり、以前のアプリ専用領域のバックアップは新しい接続先から表示できない場合があります。</p>
        <form id="drive-config-form" class="drive-form">
          <label class="form-field"><span class="form-label">クライアントJSONを読み込む</span><input id="drive-client-file" type="file" accept=".json,application/json" class="input"></label>
          <label class="form-field"><span class="form-label">Client ID</span><input id="drive-client-id" class="input" autocomplete="off" maxlength="256" required></label>
          <label class="form-field"><span class="form-label">Client Secret（JSONに含まれる場合）</span><input id="drive-client-secret" class="input" type="password" autocomplete="new-password" maxlength="256" placeholder="保存済みの場合、空欄なら保持"></label>
          <button type="submit" class="btn btn-sm btn-outlined">接続設定を保存</button>
        </form>
        <button type="button" id="drive-use-bundled" class="btn btn-sm btn-outlined" hidden>アプリ共通の接続設定に戻す</button>
      </details>
      <p id="drive-status" class="settings-note"></p>
      <div id="drive-controls" class="drive-actions"></div>
      <p id="drive-message" role="status" aria-live="polite"></p>
      <div id="drive-backups" class="drive-backups"></div>
      <div id="drive-preview"></div>`;
    const message = panel.querySelector('#drive-message'), controls = panel.querySelector('#drive-controls');
    const alive = () => panel.isConnected;
    const counts = (p) => `企業 ${Number(p.companies) || 0}社 ／ 選考 ${Number(p.steps) || 0}件 ／ 面接記録 ${Number(p.interviews) || 0}件 ／ 予定 ${Number(p.events) || 0}件`;
    const render = () => {
      if (!alive()) return;
      panel.querySelector('#drive-status').textContent = status.signingIn ? 'ブラウザーでGoogleの接続を承認してください。' : status.connected ? 'Google Driveに接続済み' : status.configured ? (status.configurationSource === 'bundled' ? '「Googleに接続」から、自分のGoogleアカウントでログインしてください。' : '独自の接続設定を使用しています。「Googleに接続」からログインしてください。') : 'このビルドには共通のGoogle接続設定が含まれていません。詳細設定から独自の接続設定を登録できます。';
      const useBundled = panel.querySelector('#drive-use-bundled');
      useBundled.hidden = !status.bundledAvailable || status.configurationSource === 'bundled';
      useBundled.disabled = busy || status.signingIn || status.busy;
      panel.querySelectorAll('#drive-config-form input, #drive-config-form button').forEach((el) => { el.disabled = busy || status.signingIn; });
      controls.innerHTML = status.signingIn ? '<button type="button" class="btn btn-sm btn-outlined" id="drive-cancel-login">接続を中断</button>' : `
        <button type="button" class="btn btn-sm btn-outlined" id="drive-connect" ${busy || !status.configured || !status.encryptedStorageAvailable ? 'disabled' : ''}>${status.connected ? 'Googleに再接続' : 'Googleに接続'}</button>
        <button type="button" class="btn btn-sm btn-primary" id="drive-upload" ${busy || !status.connected ? 'disabled' : ''}>内容を確認してDriveへ保存</button>
        <button type="button" class="btn btn-sm btn-outlined" id="drive-list" ${busy || !status.connected ? 'disabled' : ''}>バックアップ一覧を取得</button>
        ${status.connected ? `<button type="button" class="btn btn-sm btn-outlined" id="drive-disconnect" ${busy ? 'disabled' : ''}>Googleの許可を解除</button><button type="button" class="btn btn-sm btn-outlined" id="drive-forget" ${busy ? 'disabled' : ''}>この端末の接続情報だけ削除</button>` : ''}
        ${busy || status.busy ? '<button type="button" class="btn btn-sm btn-outlined" id="drive-cancel-transfer">転送を中断</button>' : ''}`;
      controls.querySelector('#drive-connect')?.addEventListener('click', () => run(async () => { await invoke('beginGoogleDriveLogin'); return 'ブラウザーでGoogleの接続を承認してください。'; }));
      controls.querySelector('#drive-cancel-login')?.addEventListener('click', () => run(async () => { await invoke('cancelGoogleDriveLogin'); return '接続を中断しました。'; }));
      controls.querySelector('#drive-cancel-transfer')?.addEventListener('click', () => invoke('cancelGoogleDriveTransfer').catch((e) => { message.textContent = e.message; }));
      controls.querySelector('#drive-upload')?.addEventListener('click', () => run(async () => {
        const p = await invoke('prepareGoogleDriveBackup');
        if (!window.confirm(`次のバックアップをGoogle Driveへ送信しますか？\n${counts(p.counts)}\n約${Math.ceil(p.bytes / 1024)} KiB\n\n就活プロフィール・企業メモ・マイページID等を含む、暗号化されていないJSONです。認証トークンとパスワードは含みません。`)) return 'Driveへの保存を中止しました。';
        await invoke('uploadGoogleDriveBackup', { token: p.token }); return 'Driveへバックアップを保存しました。一覧から確認できます。';
      }));
      controls.querySelector('#drive-list')?.addEventListener('click', () => loadFiles(false));
      for (const [id, localOnly] of [['drive-disconnect', false], ['drive-forget', true]]) {
        controls.querySelector('#' + id)?.addEventListener('click', () => {
          if (!window.confirm(localOnly ? 'この端末の接続情報だけを削除しますか？ Google側の許可は残ります。Driveのバックアップとローカルデータは削除しません。' : 'このアプリに与えたGoogleの許可を解除しますか？ Driveのバックアップとローカルデータは削除しません。')) return;
          run(async () => { await invoke('disconnectGoogleDrive', { localOnly }); files = []; restoreToken = ''; renderFiles(); panel.querySelector('#drive-preview').replaceChildren(); return '接続を解除しました。'; });
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
      list.innerHTML = files.length ? `<ul class="drive-backup-list">${files.map((f) => `<li><span>${escapeHtml(f.name)}<small>${escapeHtml(Number.isFinite(Date.parse(f.createdTime)) ? new Date(f.createdTime).toLocaleString() : '日時不明')} ／ ${Math.ceil(f.bytes / 1024)} KiB</small></span><button type="button" class="btn btn-sm btn-outlined" data-drive-preview="${escapeHtml(f.id)}">復元内容をプレビュー</button></li>`).join('')}</ul>${pageToken ? '<button type="button" class="btn btn-sm btn-outlined" id="drive-more">さらに表示</button>' : ''}` : '<p class="settings-note">バックアップは表示されていません。「一覧を取得」で確認できます。</p>';
      list.querySelector('#drive-more')?.addEventListener('click', () => loadFiles(true));
      list.querySelectorAll('[data-drive-preview]').forEach((button) => button.addEventListener('click', () => run(async () => {
        restoreToken = ''; const area = panel.querySelector('#drive-preview'); area.replaceChildren();
        const result = await invoke('previewGoogleDriveBackup', { id: button.dataset.drivePreview });
        restoreToken = result.token;
        area.innerHTML = `<div class="banner banner-info drive-restore"><strong>復元内容：${escapeHtml(counts(result.preview.counts))}</strong><p>就活プロフィール：${result.preview.hasCareerProfile ? '復元対象' : '既存を維持'}。実行前の状態はローカルに退避し、既存の取り消し機能で戻せます。</p><label>復元方法 <select class="select" id="drive-restore-mode"><option value="merge">既存データへ追加</option><option value="replace">既存データを置換</option></select></label><button type="button" class="btn btn-primary" id="drive-restore">この内容で復元する</button></div>`;
        area.querySelector('#drive-restore').addEventListener('click', () => {
          if (!restoreToken || !window.confirm('プレビューしたバックアップをローカルへ復元しますか？ 選んだ復元方法と件数を確認してください。')) return;
          run(async () => { await invoke('restoreGoogleDriveBackup', { token: restoreToken, mode: area.querySelector('#drive-restore-mode').value }); restoreToken = ''; area.replaceChildren(); await onRestore(); return 'バックアップを復元しました。必要なら「直前のインポートをロールバック」で取り消せます。'; });
        });
        return 'プレビューしました。まだローカルデータは変更していません。';
      })));
    };
    const loadFiles = (more) => run(async () => {
      const result = await invoke('listGoogleDriveBackups', more ? { pageToken } : {});
      files = more ? files.concat(result.files) : result.files; pageToken = result.nextPageToken;
      renderFiles(); return 'バックアップ一覧を取得しました。';
    });
    panel.querySelector('#drive-client-file').addEventListener('change', async (event) => {
      try {
        const file = event.target.files?.[0]; if (!file) return;
        if (file.size > 65536) throw new Error('OAuthクライアントJSONのサイズが大きすぎます。');
        const value = JSON.parse(await file.text());
        if (!value.installed || typeof value.installed.client_id !== 'string') throw new Error('「デスクトップ アプリ」用のクライアントJSONを選んでください。');
        panel.querySelector('#drive-client-id').value = value.installed.client_id;
        panel.querySelector('#drive-client-secret').value = typeof value.installed.client_secret === 'string' ? value.installed.client_secret : '';
        message.textContent = '設定値を読み取りました。「接続設定を保存」を押してください。';
      } catch { message.textContent = 'クライアントJSONを読み取れません。サイズと、デスクトップ アプリ用のJSONかを確認してください。'; }
      finally { event.target.value = ''; }
    });
    panel.querySelector('#drive-config-form').addEventListener('submit', (event) => {
      event.preventDefault();
      if (status.connected && !window.confirm('Googleの接続設定を変更しますか？ 接続先が変わる場合は再ログインが必要です。以前の接続先のバックアップはそのまま残ります。')) return;
      run(async () => {
        const secret = panel.querySelector('#drive-client-secret');
        try { await invoke('configureGoogleDrive', { clientId: panel.querySelector('#drive-client-id').value.trim(), ...(secret.value ? { clientSecret: secret.value } : {}) }); }
        finally { secret.value = ''; }
        files = []; restoreToken = ''; renderFiles(); panel.querySelector('#drive-preview').replaceChildren();
        return '接続設定を保存しました。「Googleに接続」から承認してください。';
      });
    });
    panel.querySelector('#drive-use-bundled').addEventListener('click', () => {
      if (!window.confirm('アプリ共通のGoogle接続設定に戻しますか？ 接続先が変わる場合は再ログインが必要です。以前の接続先のバックアップはそのまま残ります。')) return;
      run(async () => {
        status = await invoke('configureGoogleDrive', { useBundled: true });
        panel.querySelector('#drive-client-id').value = status.clientId || '';
        panel.querySelector('#drive-client-secret').value = '';
        files = []; restoreToken = ''; renderFiles(); panel.querySelector('#drive-preview').replaceChildren();
        return 'アプリ共通の接続設定に戻しました。「Googleに接続」からログインできます。';
      });
    });
    root.addEventListener('jt-modal-close', () => { clearTimeout(timer); panel.querySelector('#drive-client-secret').value = ''; invoke('cancelGoogleDriveLogin').catch(() => {}); invoke('cancelGoogleDriveTransfer').catch(() => {}); }, { once: true });
    invoke('getGoogleDriveStatus').then((value) => { status = value; if (alive()) { panel.querySelector('#drive-client-id').value = status.clientId || ''; render(); poll(); } }).catch((e) => { if (alive()) message.textContent = e.message; });
    render(); renderFiles();
  }
  window.JobTrackerDrive = Object.freeze({ mount });
})();
