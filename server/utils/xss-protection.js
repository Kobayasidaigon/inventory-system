// XSS対策用のユーティリティ

/**
 * HTMLエスケープ関数
 * @param {string} text - エスケープする文字列
 * @returns {string} - エスケープされた文字列
 */
function escapeHtml(text) {
    if (typeof text !== 'string') {
        return text;
    }

    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
        '/': '&#x2F;'
    };

    return text.replace(/[&<>"'/]/g, (char) => map[char]);
}

/**
 * HTMLタグとスクリプトを除去するサニタイズ
 * @param {string} dirty - サニタイズする文字列
 * @returns {string} - サニタイズされた文字列
 */
function sanitizeHtml(dirty) {
    if (typeof dirty !== 'string') {
        return dirty;
    }

    // HTMLタグを完全に除去
    let sanitized = dirty.replace(/<[^>]*>/g, '');

    // スクリプトタグの内容も除去
    sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

    // イベントハンドラを除去
    sanitized = sanitized.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
    sanitized = sanitized.replace(/on\w+\s*=\s*[^\s>]*/gi, '');

    // javascript:プロトコルを除去
    sanitized = sanitized.replace(/javascript:/gi, '');

    // 基本的なHTMLエンティティエスケープ
    return escapeHtml(sanitized);
}

/**
 * オブジェクトの全プロパティをエスケープ
 * @param {Object} obj - エスケープするオブジェクト
 * @param {Array} fields - エスケープ対象のフィールド名の配列
 * @returns {Object} - エスケープされたオブジェクト
 */
function sanitizeObject(obj, fields) {
    const sanitized = { ...obj };

    fields.forEach(field => {
        if (sanitized[field] !== undefined && sanitized[field] !== null) {
            sanitized[field] = sanitizeHtml(sanitized[field]);
        }
    });

    return sanitized;
}

module.exports = {
    escapeHtml,
    sanitizeHtml,
    sanitizeObject
};
