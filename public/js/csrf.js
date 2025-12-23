// CSRF対策用のユーティリティ

let csrfToken = null;

/**
 * CSRFトークンを取得する
 * @returns {Promise<string>} CSRFトークン
 */
async function getCsrfToken() {
    if (csrfToken) {
        return csrfToken;
    }

    try {
        const response = await fetch('/api/csrf-token');
        const data = await response.json();

        if (data.success && data.csrfToken) {
            csrfToken = data.csrfToken;
            return csrfToken;
        }

        throw new Error('CSRFトークンの取得に失敗しました');
    } catch (error) {
        console.error('CSRF token error:', error);
        throw error;
    }
}

/**
 * CSRFトークンをリセット（再取得が必要な場合）
 */
function resetCsrfToken() {
    csrfToken = null;
}

/**
 * fetchリクエストにCSRFトークンを追加するラッパー関数
 * @param {string} url - リクエストURL
 * @param {Object} options - fetchオプション
 * @returns {Promise<Response>} fetchレスポンス
 */
async function fetchWithCsrf(url, options = {}) {
    // GETリクエストの場合はCSRFトークン不要
    if (!options.method || options.method.toUpperCase() === 'GET') {
        return fetch(url, options);
    }

    try {
        const token = await getCsrfToken();

        // FormDataの場合はヘッダーではなくbodyに追加
        if (options.body instanceof FormData) {
            options.body.append('_csrf', token);
            return fetch(url, options);
        }

        // JSON等の場合はヘッダーにCSRFトークンを追加
        const headers = {
            ...options.headers,
            'X-CSRF-Token': token
        };

        return fetch(url, { ...options, headers });
    } catch (error) {
        console.error('Fetch with CSRF error:', error);
        throw error;
    }
}

/**
 * HTMLエスケープ（XSS対策）
 * @param {string} text - エスケープする文字列
 * @returns {string} エスケープされた文字列
 */
function escapeHtml(text) {
    if (typeof text !== 'string') {
        return text;
    }

    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * テキストコンテンツを安全に設定（XSS対策）
 * @param {HTMLElement} element - 要素
 * @param {string} text - 設定するテキスト
 */
function setTextContent(element, text) {
    element.textContent = text;
}

// グローバルに公開
window.getCsrfToken = getCsrfToken;
window.resetCsrfToken = resetCsrfToken;
window.fetchWithCsrf = fetchWithCsrf;
window.escapeHtml = escapeHtml;
window.setTextContent = setTextContent;
