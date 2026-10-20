'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
class AgentError extends Error {}

const DEFINITIONS = [
  ['openai', 'OpenAI API', 'https://api.openai.com/v1/responses', 'responses', 'API利用枠・ChatGPT契約とは別', 'https://platform.openai.com/api-keys'],
  ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1/chat/completions', 'chat', 'OpenRouterのAPIクレジット', 'https://openrouter.ai/keys'],
  ['anthropic', 'Claude API', 'https://api.anthropic.com/v1/messages', 'anthropic', 'API利用枠・Claude Pro／Maxとは別', 'https://platform.claude.com/'],
  ['gemini', 'Gemini API', 'https://generativelanguage.googleapis.com/v1beta/models/', 'gemini', 'Gemini API利用枠・Google AI契約とは別', 'https://aistudio.google.com/apikey'],
  ['xai', 'Grok API', 'https://api.x.ai/v1/responses', 'responses', 'API利用枠・SuperGrok契約とは別', 'https://console.x.ai/'],
  ['perplexity', 'Perplexity Agent API', 'https://api.perplexity.ai/v1/agent', 'responses', 'API組織への課金・Pro契約とは別／Web検索あり', 'https://console.perplexity.ai/'],
  ['deepseek', 'DeepSeek API', 'https://api.deepseek.com/chat/completions', 'chat', '通常API利用枠', 'https://platform.deepseek.com/'],
  ['mistral', 'Mistral API', 'https://api.mistral.ai/v1/chat/completions', 'chat', 'StudioのAPI利用枠', 'https://console.mistral.ai/'],
  ['zai', 'GLM／Z.AI API', 'https://api.z.ai/api/paas/v4/chat/completions', 'chat', '通常API専用・Coding Planは使用不可', 'https://z.ai/'],
  ['kimi', 'Kimi／Moonshot API', 'https://api.moonshot.ai/v1/chat/completions', 'chat', '通常API専用・Kimi Code会員枠は使用不可', 'https://platform.moonshot.ai/'],
  ['minimax', 'MiniMax API', 'https://api.minimax.io/v1/chat/completions', 'chat', '通常API利用枠', 'https://platform.minimax.io/'],
  ['minimax-plan', 'MiniMax M Plan', 'https://api.minimax.io/v1/chat/completions', 'chat', 'M Plan専用Subscription Keyの利用枠', 'https://platform.minimax.io/'],
];
const CATALOG = Object.freeze(DEFINITIONS.map(([id, label, endpoint, protocol, billing, consoleUrl]) => Object.freeze({ id, label, endpoint, protocol, billing, consoleUrl, webSearch: id === 'perplexity' })));
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k))) throw new AgentError('エージェントの入力形式が不正です。');
}
function entry(value) {
  object(value, ['id', 'name', 'provider', 'model', 'apiKey']);
  if (typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.id) || !CATALOG.some((p) => p.id === value.provider) ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || /[\x00-\x1f]/.test(value.name) ||
      typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value.model) ||
      typeof value.apiKey !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(value.apiKey)) throw new AgentError('接続先・表示名・モデルID・APIキーを確認してください。');
  if (value.provider === 'gemini' && !/^[A-Za-z0-9._-]+$/.test(value.model)) throw new AgentError('GeminiのモデルIDだけを入力してください（URLではありません）。');
  if (value.provider === 'minimax-plan' && !value.apiKey.startsWith('sk-cp-')) throw new AgentError('M Plan専用のSubscription Keyを入力してください。');
}

class AiAgents {
  constructor({ dataDir, safeStorage, fetch: request = globalThis.fetch }) {
    this.file = path.join(dataDir, 'api-agents.enc');
    this.storage = safeStorage;
    this.fetch = request;
    this.pending = null;
  }
  catalog() { return CATALOG.map(({ endpoint, protocol, ...visible }) => visible); }
  read() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new AgentError('invalid file');
      const data = JSON.parse(this.storage.decryptString(fs.readFileSync(this.file)));
      if (data.version !== 1 || !Array.isArray(data.agents) || data.agents.length > 16) throw new AgentError('invalid store');
      data.agents.forEach(entry);
      return data.agents;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new AgentError('登録済みエージェントを復号・読み込みできません。保存済みの認証情報は変更していません。');
    }
  }
  write(agents) {
    if (!this.storage.isEncryptionAvailable()) throw new AgentError('OSの暗号化機能が必要です。ネイティブアプリから登録してください。');
    const encrypted = this.storage.encryptString(JSON.stringify({ version: 1, agents }));
    const temporary = `${this.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
  }
  list() { return this.read().map(({ apiKey, ...visible }) => visible); }
  save(value) {
    object(value, ['name', 'provider', 'model', 'apiKey']);
    const candidate = { ...value, id: crypto.randomUUID() };
    entry(candidate);
    const agents = this.read();
    if (agents.length >= 16) throw new AgentError('登録できるエージェントは16件までです。');
    agents.push(candidate); this.write(agents);
    return this.list();
  }
  remove(value) {
    object(value, ['id']);
    if (typeof value.id !== 'string') throw new AgentError('登録IDが不正です。');
    const agents = this.read();
    if (!agents.some((a) => a.id === value.id)) throw new AgentError('登録が見つかりません。');
    if (this.pending?.id === value.id) this.cancel();
    this.write(agents.filter((a) => a.id !== value.id));
    return this.list();
  }
  cancel() { this.pending?.controller.abort(); return { cancelled: true }; }
  async generate(request) {
    object(request, ['id', 'input']);
    if (typeof request.id !== 'string' || typeof request.input !== 'string' || !request.input.trim() || request.input.length > 60000) throw new AgentError('生成するプロンプトを確認してください。');
    if (this.pending) throw new AgentError('別の生成が進行中です。完了または中断してから実行してください。');
    const agent = this.read().find((a) => a.id === request.id);
    if (!agent) throw new AgentError('登録済みエージェントを選択してください。');
    const provider = CATALOG.find((p) => p.id === agent.provider);
    const controller = new AbortController();
    const pending = { id: agent.id, controller }; this.pending = pending;
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
      const prompt = request.input + (provider.webSearch
        ? '\n出典と確認日を明記し、未確認の事実を推測で埋めず、要求された企業JSONだけを返してください。'
        : '\nこの接続にはWeb検索ツールがありません。最新の日程・待遇・情報確認日を確認済みと偽らず、不明な項目はnullか空欄にしてください。要求された企業JSONだけを返してください。');
      let url = provider.endpoint;
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      let body;
      if (provider.protocol === 'gemini') {
        url += encodeURIComponent(agent.model) + ':generateContent';
        headers['x-goog-api-key'] = agent.apiKey;
        body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 8192 } };
      } else if (provider.protocol === 'anthropic') {
        headers['x-api-key'] = agent.apiKey; headers['anthropic-version'] = '2023-06-01';
        body = { model: agent.model, max_tokens: 8192, messages: [{ role: 'user', content: prompt }] };
      } else {
        headers.Authorization = `Bearer ${agent.apiKey}`;
        body = provider.protocol === 'responses'
          ? { model: agent.model, input: prompt, stream: false, store: false, max_output_tokens: 8192 }
          : { model: agent.model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 8192 };
        if (provider.webSearch) body.tools = [{ type: 'web_search' }];
      }
      const response = await this.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel?.();
        const reasons = { 401: 'APIキーが無効か期限切れです。', 403: 'このモデル・APIを利用する権限がありません。', 402: 'API残高・契約を確認してください。', 429: '利用上限に達しました。時間をおくか利用枠を確認してください。' };
        throw new AgentError(reasons[response.status] || `提供元がリクエストを受け付けませんでした（HTTP ${response.status}）。モデルIDと利用条件を確認してください。`);
      }
      let raw = '', size = 0;
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { controller.abort(); throw new AgentError('応答が大きすぎるため中断しました。'); }
        raw += decoder.decode(chunk, { stream: true });
      }
      raw += decoder.decode();
      if (controller.signal.aborted) throw new AgentError('aborted');
      let data;
      try { data = JSON.parse(raw); } catch { throw new AgentError('提供元の応答を読み取れませんでした。'); }
      if (data.status === 'incomplete' || data.stop_reason === 'max_tokens' || ['length', 'MAX_TOKENS'].includes(data.choices?.[0]?.finish_reason || data.candidates?.[0]?.finishReason)) throw new AgentError('出力が途中で終了しました。条件を短くして再実行してください。');
      let text;
      if (provider.protocol === 'gemini') text = data.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || '').join('');
      else if (provider.protocol === 'anthropic') text = data.content?.filter((p) => p.type === 'text').map((p) => p.text).join('');
      else if (provider.protocol === 'responses') text = data.output?.filter((p) => p.type === 'message').flatMap((p) => p.content || []).filter((p) => p.type === 'output_text').map((p) => p.text).join('');
      else text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new AgentError('テキストの回答がありません。モデルの対応形式を確認してください。');
      return text;
    } catch (error) {
      if (controller.signal.aborted) throw new AgentError('生成を中断しました。タイムアウトの場合は入力を短くしてください。');
      // Do not forward provider response bodies or transport errors, which may contain secrets.
      if (error instanceof AgentError) throw error;
      throw new AgentError('提供元に接続できませんでした。ネットワークとモデルの設定を確認してください。');
    } finally { clearTimeout(timeout); if (this.pending === pending) this.pending = null; }
  }
}
module.exports = { AiAgents, CATALOG };
