const { mainDb } = require('../db/database-admin');

/**
 * Remember Me トークンからログイン状態を作り直す。
 *
 * セッションが失われる場面はいくつもある。サーバーの再起動、セッションの期限切れ。
 * そのたびに現場でログインし直すのは現実的でないので、1 年有効のトークンが
 * 残っていれば黙って復帰させる。
 *
 * @param {object} req - リクエスト（成功すると req.session が埋まる）
 * @returns {Promise<object|null>} 復帰できたユーザー
 */
async function restoreSessionFromRememberToken(req) {
    const token = req.cookies && req.cookies.remember_token;

    if (!token) {
        return null;
    }

    const tokenData = await mainDb.get(
        'SELECT * FROM remember_tokens WHERE token = ? AND expires_at > datetime("now")',
        [token]
    );

    if (!tokenData) {
        return null;
    }

    const user = await mainDb.get('SELECT * FROM users WHERE id = ?', [tokenData.user_id]);

    if (!user) {
        return null;
    }

    req.session.userId = user.id;
    req.session.userName = user.user_name;
    req.session.isAdmin = user.is_admin === 1;

    // 一般ユーザーは拠点の情報がないと在庫の API が使えない
    if (!req.session.isAdmin) {
        const location = await mainDb.get(
            'SELECT * FROM locations WHERE id = ?',
            [user.location_id]
        );

        if (location) {
            req.session.locationId = location.id;
            req.session.locationCode = location.location_code;
        }
    }

    return user;
}

/**
 * セッションがなければ Remember Me トークンで復帰させる。
 *
 * ルートごとではなく全体の前段に置く。管理画面の API は requireAuth を通らず
 * 各ルートが自前で req.session.isAdmin を見ているので、ここで直しておかないと
 * 管理画面だけ復帰できないことになる。
 *
 * 復帰できなくても素通しする。誰を弾くかは、この後の requireAuth や
 * 各ルートの権限チェックが決める。
 */
async function attachRememberedSession(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }

    try {
        await restoreSessionFromRememberToken(req);
    } catch (err) {
        console.error('セッションの復帰に失敗しました:', err);
    }

    next();
}

/**
 * ログインしていないリクエストを弾く。
 *
 * 復帰の処理は attachRememberedSession が先に済ませている。
 */
function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'ログインが必要です' });
    }
    next();
}

module.exports = { requireAuth, attachRememberedSession, restoreSessionFromRememberToken };
