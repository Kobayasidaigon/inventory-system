// 信頼している別サイト（清掃管理表）からの入場。
//
// 署名の検証そのものは services/entry-link.js にある。ここは HTTP の受け口と、
// セッションを作るところだけを持つ。

const express = require('express');
const { mainDb } = require('../db/database-admin');
const {
    isConfigured,
    verifyEntryParams,
    consumeNonce,
    purgeExpiredNonces
} = require('../services/entry-link');

const router = express.Router();

/**
 * 失敗したときはログイン画面へ回す。
 *
 * ここに来るのは現場の人で、JSON のエラーを見せても何もできない。理由は
 * サーバーのログに残し、画面には普通のログインを出す。
 */
function sendToLogin(res, reason) {
    console.warn(`[入場リンク] 拒否: ${reason}`);
    res.redirect('/?entry=failed');
}

router.get('/', async (req, res) => {
    if (!isConfigured()) {
        return sendToLogin(res, 'LINK_SECRET が未設定');
    }

    let params;
    try {
        params = verifyEntryParams(req.query);
    } catch (err) {
        return sendToLogin(res, err.message);
    }

    try {
        // 使い捨て。同じリンクを二度は通さない。
        const fresh = await consumeNonce(mainDb, params.nonce, params.exp);
        if (!fresh) {
            return sendToLogin(res, '使用済みのリンク');
        }

        // ついでに古い記録を掃除する。専用の定期処理を増やすほどの量ではない。
        purgeExpiredNonces(mainDb).catch(err => {
            console.error('[入場リンク] 古い nonce の掃除に失敗しました:', err);
        });

        const location = await mainDb.get(
            'SELECT * FROM locations WHERE location_code = ?',
            [params.loc]
        );

        if (!location) {
            return sendToLogin(res, `拠点が見つからない: ${params.loc}`);
        }

        const user = await mainDb.get(
            'SELECT * FROM users WHERE location_id = ? AND user_id = ?',
            [location.id, params.user]
        );

        if (!user) {
            return sendToLogin(res, `利用者が見つからない: ${params.loc}/${params.user}`);
        }

        // 管理者にはこの経路で入らせない。リンク 1 本で全拠点を触れる状態は作らない。
        if (user.is_admin) {
            return sendToLogin(res, '管理者はリンクからは入れません');
        }

        req.session.userId = user.id;
        // 画面に出す名前。リンクが操作者名（by）を持っていればそちらを使う。
        //
        // users のアカウントは店舗で共用していて、清掃管理表から入ると全員が
        // 同じ「清掃管理表」になる。それだと誰が触っているのか画面からも履歴からも
        // 分からないので、向こうで選ばれている担当者の名前を受け取って上書きする。
        req.session.userName = params.by || user.user_name;
        // 記録に残す操作者名。by が無いリンクでは付けない（従来どおりアカウント名で出る）。
        req.session.operatorName = params.by || null;
        req.session.locationId = location.id;
        req.session.locationCode = location.location_code;
        req.session.isAdmin = false;
        // このセッションがリンク由来であることを残す。あとで経路を絞りたくなったときに要る。
        req.session.enteredByLink = true;

        // ログにはアカウントと操作者の両方を残す。どのアカウントで入ったかも要るため。
        const who = params.by ? `${user.user_name}（${params.by}）` : user.user_name;
        console.log(`[入場リンク] ${location.location_name} / ${who} が入りました`);

        // 署名付きの URL を残さないよう、素の URL へ送り直す。
        // アドレス欄・履歴・次の遷移の Referer から消える。
        res.redirect('/');
    } catch (err) {
        console.error('[入場リンク] 処理に失敗しました:', err);
        sendToLogin(res, '内部エラー');
    }
});

module.exports = router;
