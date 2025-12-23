// CSRF対策ミドルウェア
const csrf = require('csrf');
const tokens = new csrf();

// CSRFトークンを生成してセッションに保存
function generateCsrfToken(req, res, next) {
    // セッションにCSRFシークレットがない場合は新規作成
    if (!req.session.csrfSecret) {
        req.session.csrfSecret = tokens.secretSync();
    }

    // トークンを生成
    req.csrfToken = () => tokens.create(req.session.csrfSecret);

    next();
}

// CSRFトークンを検証
function verifyCsrfToken(req, res, next) {
    // GETリクエスト、CSRFトークン取得、LINE webhookは検証不要
    if (
        req.method === 'GET' ||
        req.path === '/csrf-token' ||
        req.path === '/line-webhook' ||
        req.path.includes('/api/auth/check')  // 認証チェックも除外
    ) {
        return next();
    }

    // multipart/form-dataの場合、後でmulterがパースするのでスキップ
    // （各ルートで個別に検証）
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
        return next();
    }

    // CSRFトークンを取得（ヘッダーまたはボディから）
    const token = req.headers['x-csrf-token'] || req.body._csrf;

    if (!token) {
        return res.status(403).json({
            success: false,
            error: 'CSRFトークンが見つかりません'
        });
    }

    // セッションのシークレットがない場合
    if (!req.session.csrfSecret) {
        return res.status(403).json({
            success: false,
            error: 'セッションが無効です'
        });
    }

    // トークンを検証
    if (!tokens.verify(req.session.csrfSecret, token)) {
        return res.status(403).json({
            success: false,
            error: 'CSRFトークンが無効です'
        });
    }

    next();
}

// CSRF検証を個別に実行するヘルパー関数
function verifyCsrfTokenManual(req, res) {
    const token = req.body._csrf;

    if (!token) {
        return { valid: false, error: 'CSRFトークンが見つかりません' };
    }

    if (!req.session.csrfSecret) {
        return { valid: false, error: 'セッションが無効です' };
    }

    if (!tokens.verify(req.session.csrfSecret, token)) {
        return { valid: false, error: 'CSRFトークンが無効です' };
    }

    return { valid: true };
}

// CSRFトークンを取得するAPI
function getCsrfToken(req, res) {
    res.json({
        success: true,
        csrfToken: req.csrfToken()
    });
}

module.exports = {
    generateCsrfToken,
    verifyCsrfToken,
    verifyCsrfTokenManual,
    getCsrfToken
};
