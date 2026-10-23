'use strict';
// Desktop OAuth clients are public clients. These are application identifiers,
// never user access/refresh tokens or service-account credentials.
function normalizeClient(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.clientId !== 'string' || !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.clientId) ||
      typeof value.clientSecret !== 'string' || !/^[\x21-\x7e]{0,256}$/.test(value.clientSecret) ||
      Object.keys(value).some((key) => !['clientId', 'clientSecret'].includes(key))) {
    throw new Error('Googleのデスクトップ用OAuthクライアント設定が不正です。');
  }
  return Object.freeze({ clientId: value.clientId, clientSecret: value.clientSecret });
}
function desktopClient(value) {
  if (!value?.installed || value.web || value.type === 'service_account') {
    throw new Error('Googleの「デスクトップ アプリ」用クライアントJSONを指定してください。');
  }
  return normalizeClient({ clientId: value.installed.client_id, clientSecret: value.installed.client_secret ?? '' });
}
function bundledClient() {
  const value = require('./google-oauth-client.json');
  return Object.keys(value).length ? normalizeClient(value) : null;
}
module.exports = { normalizeClient, desktopClient, bundledClient };
