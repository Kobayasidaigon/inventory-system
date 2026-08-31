// スタッフの勤務予定。
//
// 取り込みは GitHub Actions で動くスクレイパーから呼ばれる。ブラウザからの操作では
// ないので、ログインセッションではなく共有の秘密鍵で認証する。

const express = require('express');
const crypto = require('crypto');
const { mainDb } = require('../db/database-admin');
const { requireAuth } = require('../middleware/auth');
const { respondWithStockError, StockError } = require('../utils/stock');
const { importSchedules, parseTargetMonth } = require('../services/staff-schedule');

const router = express.Router();

/**
 * 取り込み用の秘密鍵を照合する。
 *
 * 長さの違いで中身が漏れないよう、ハッシュにしてから固定長で比べる。
 * 鍵が設定されていないときは通さない。設定漏れのまま誰でも書き込める状態に
 * なるより、動かない方が安全。
 */
function verifyImportSecret(req) {
    const expected = process.env.IMPORT_SECRET;

    if (!expected) {
        throw new StockError(
            'IMPORT_SECRET が設定されていないため、取り込みは受け付けられません',
            503
        );
    }

    const provided = req.body && req.body.secret;

    if (typeof provided !== 'string' || provided.length === 0) {
        throw new StockError('認証に失敗しました', 401);
    }

    const hash = value => crypto.createHash('sha256').update(String(value)).digest();

    if (!crypto.timingSafeEqual(hash(provided), hash(expected))) {
        throw new StockError('認証に失敗しました', 401);
    }
}

// ジョブカンから取得した勤務予定を取り込む
//
// body: { secret, schedules: [{ staffName, day, startTime, endTime, groupId, groupName }], targetMonth }
router.post('/import-schedules', async (req, res) => {
    try {
        verifyImportSecret(req);

        const result = await importSchedules(mainDb, {
            schedules: req.body.schedules,
            targetMonth: req.body.targetMonth
        });

        console.log(
            `[勤務予定] ${result.targetMonth}: ${result.received}件受け取り ` +
            `(新規 ${result.created} / 更新 ${result.updated} / スタッフ新規 ${result.staffCreated})`
        );

        if (result.unmatchedGroups.length > 0) {
            console.warn(
                `[勤務予定] 拠点に結びつかない店舗があります: ${result.unmatchedGroups.join('、')}` +
                '（locations.jobcan_group_id を設定してください）'
            );
        }

        res.json({ success: true, ...result });
    } catch (err) {
        respondWithStockError(res, err, '勤務予定の取り込みに失敗しました');
    }
});

// 勤務予定を月単位で返す（取り込み結果の確認と、画面から使うため）
router.get('/schedules', requireAuth, async (req, res) => {
    try {
        const month = parseTargetMonth(req.query.month);

        // 一般ユーザーは自分の拠点だけ。管理者は全拠点。
        const conditions = ['s.date LIKE ?'];
        const params = [`${month.text}-%`];

        if (!req.session.isAdmin) {
            conditions.push('s.location_id = ?');
            params.push(req.session.locationId);
        }

        const rows = await mainDb.all(
            `SELECT
                s.date,
                s.start_time,
                s.end_time,
                st.name AS staff_name,
                l.location_name
             FROM staff_schedules s
             JOIN staff st ON s.staff_id = st.id
             LEFT JOIN locations l ON s.location_id = l.id
             WHERE ${conditions.join(' AND ')}
             ORDER BY s.date ASC, s.start_time ASC, st.name ASC`,
            params
        );

        res.json({ month: month.text, count: rows.length, schedules: rows });
    } catch (err) {
        respondWithStockError(res, err, '勤務予定の取得に失敗しました');
    }
});

module.exports = router;
