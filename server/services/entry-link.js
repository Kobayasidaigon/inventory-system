// 清掃管理表など、こちらで信頼している別のサイトから、ログインなしで入れるための
// 署名付きリンク。
//
// 「どこから来たか」は Referer では判定できない。あれは送る側が自由に書ける値なので、
// 認証には使えない。代わりに、両サイトで持つ合言葉で署名を作り、それを検証する。
// 署名を作れるのは合言葉を知っているサーバーだけなので、偽装できない。
//
// 想定する使い方:
//   1. 清掃管理表側で、ログイン済みの人にだけ署名付きリンクを出す
//   2. その人がリンクを踏む
//   3. こちらで署名・期限・使い捨てを確かめ、セッションを作る
//
// 効き目は「清掃管理表のログインと同じ強さ」まで。向こうが破られればこちらも入られる。
// そういう関係を結ぶということなので、向こうのログインが弱いなら結ばない方がよい。

const crypto = require('crypto');
const { StockError } = require('../utils/stock');

/**
 * リンクの寿命の上限（秒）。
 *
 * exp は絶対時刻なので、これを見ないと exp=2099年 のリンクを 1 本作られただけで
 * 永久パスになる。発行側が期限を伸ばしすぎていないかを、受け取る側でも確かめる。
 */
const MAX_LINK_LIFETIME_SECONDS = 600;

/** nonce の長さの許容範囲。short すぎると当てられ、長すぎると DB を膨らませられる。 */
const NONCE_MIN_LENGTH = 16;
const NONCE_MAX_LENGTH = 128;

/** 署名の対象にする項目。順序も含めてこの通りに並べる。 */
const SIGNED_FIELDS = ['loc', 'user', 'exp', 'nonce'];

/**
 * 署名の対象になる文字列を組み立てる。
 *
 * 値を URL エンコードしてから連結する。生のまま繋ぐと、区切り文字を含む値で
 * 別々の入力が同じ文字列になりうる（loc="a&user=b" のような形）。
 */
function canonicalString(params) {
    return SIGNED_FIELDS
        .map(key => `${key}=${encodeURIComponent(String(params[key]))}`)
        .join('&');
}

/**
 * 署名を作る。発行側（清掃管理表）でも同じ計算をする。
 *
 * @param {object} params - { loc, user, exp, nonce }
 * @param {string} secret - 両サイトで共有する合言葉
 * @returns {string} 16 進の署名
 */
function sign(params, secret) {
    return crypto
        .createHmac('sha256', secret)
        .update(canonicalString(params))
        .digest('hex');
}

/**
 * 入るためのリンクを組み立てる。テストと手順書で同じ作り方を使うために置いている。
 *
 * @param {string} baseUrl - 例 https://inventory-system-aburiva.fly.dev
 * @param {object} params - { loc, user }
 * @param {string} secret - 合言葉
 * @param {object} [options]
 * @param {number} [options.lifetimeSeconds=300] - 有効時間（秒）
 * @param {number} [options.now] - 現在時刻（UNIX 秒）。テスト用
 * @returns {string} 署名付きの URL
 */
function buildEntryUrl(baseUrl, { loc, user }, secret, options = {}) {
    const lifetime = options.lifetimeSeconds ?? 300;
    const now = options.now ?? Math.floor(Date.now() / 1000);

    const params = {
        loc,
        user,
        exp: now + lifetime,
        nonce: crypto.randomBytes(16).toString('hex')
    };

    const query = canonicalString(params) + `&sig=${sign(params, secret)}`;
    return `${String(baseUrl).replace(/\/$/, '')}/enter?${query}`;
}

/** 合言葉を読む。未設定なら受け付けない。 */
function getSecret() {
    const secret = process.env.LINK_SECRET;

    if (!secret) {
        // 未設定のまま素通しするより、動かない方が安全。
        throw new StockError(
            'LINK_SECRET が設定されていないため、リンクからの入場は受け付けられません',
            503
        );
    }

    return secret;
}

/** この機能が使える状態か。使えないなら普通のログイン画面へ回す。 */
function isConfigured() {
    return Boolean(process.env.LINK_SECRET);
}

/**
 * リンクの中身を確かめる。DB は見ない（nonce の使い回しはここでは分からない）。
 *
 * @param {object} query - リクエストのクエリ
 * @param {object} [options]
 * @param {number} [options.now] - 現在時刻（UNIX 秒）。テスト用
 * @returns {{loc: string, user: string, exp: number, nonce: string}}
 */
function verifyEntryParams(query, options = {}) {
    const secret = getSecret();
    const now = options.now ?? Math.floor(Date.now() / 1000);

    const loc = String(query.loc ?? '').trim();
    const user = String(query.user ?? '').trim();
    const nonce = String(query.nonce ?? '').trim();
    const sig = String(query.sig ?? '').trim();
    const expText = String(query.exp ?? '').trim();

    if (!loc || !user || !nonce || !sig || !expText) {
        throw new StockError('リンクの形式が正しくありません', 400);
    }

    if (!/^\d+$/.test(expText)) {
        throw new StockError('リンクの形式が正しくありません', 400);
    }
    const exp = Number(expText);

    if (nonce.length < NONCE_MIN_LENGTH || nonce.length > NONCE_MAX_LENGTH) {
        throw new StockError('リンクの形式が正しくありません', 400);
    }

    // 署名を先に確かめる。期限切れかどうかは、正しい署名のリンクにだけ答える。
    // 中身を作り変えながら反応の違いを見る、という調べ方をさせないため。
    const expected = sign({ loc, user, exp, nonce }, secret);

    // timingSafeEqual は長さが違うと例外になるので、先に長さで弾く
    if (sig.length !== expected.length) {
        throw new StockError('リンクが正しくありません', 401);
    }
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        throw new StockError('リンクが正しくありません', 401);
    }

    if (exp <= now) {
        throw new StockError('リンクの有効期限が切れています。開き直してください', 401);
    }

    // 期限が先すぎるものは、署名が正しくても受け付けない。
    // 発行側の作り方が間違っていても、長生きするリンクが生まれないようにする。
    if (exp - now > MAX_LINK_LIFETIME_SECONDS) {
        throw new StockError(
            `リンクの有効期限が長すぎます（上限 ${MAX_LINK_LIFETIME_SECONDS} 秒）`,
            401
        );
    }

    return { loc, user, exp, nonce };
}

/**
 * nonce を使用済みにする。すでに使われていれば false。
 *
 * リンクは履歴にも残るし、共有もされうる。1 回しか通らないようにしておけば、
 * 後から同じ URL を開かれても入れない。
 *
 * @param {object} db - メインデータベース
 * @param {string} nonce
 * @param {number} expiresAt - このリンクの exp（UNIX 秒）。掃除に使う
 * @returns {Promise<boolean>} 初めてなら true
 */
async function consumeNonce(db, nonce, expiresAt) {
    try {
        await db.run(
            'INSERT INTO entry_nonces (nonce, expires_at) VALUES (?, ?)',
            [nonce, expiresAt]
        );
        return true;
    } catch (err) {
        // UNIQUE 制約に当たった = 2 回目
        if (String(err.message || '').includes('UNIQUE')) {
            return false;
        }
        throw err;
    }
}

/**
 * 期限の切れた nonce を消す。
 *
 * 残しておく意味があるのは、そのリンクがまだ使える間だけ。過ぎたものは
 * 期限切れとして弾かれるので、記録を持っていても効き目がない。
 */
async function purgeExpiredNonces(db, now = Math.floor(Date.now() / 1000)) {
    const result = await db.run('DELETE FROM entry_nonces WHERE expires_at < ?', [now]);
    return result && result.changes ? result.changes : 0;
}

module.exports = {
    MAX_LINK_LIFETIME_SECONDS,
    NONCE_MIN_LENGTH,
    NONCE_MAX_LENGTH,
    canonicalString,
    sign,
    buildEntryUrl,
    isConfigured,
    verifyEntryParams,
    consumeNonce,
    purgeExpiredNonces
};
