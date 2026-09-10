// 記録に「誰が操作したか」を出すところ。
//
// 拠点のアカウント（users）は店舗で共用することがある。清掃管理表から
// リンクで入ると全員が同じ「清掃管理表」というアカウントになるので、
// user_id だけでは誰が入力したのか分からない。
//
// そこで、入場リンクが操作者名を持っていれば、その名前を記録の行そのもの
// （operator_name 列）にも残している。表示するときは行に残った名前を先に見て、
// 無ければこれまで通りアカウント名を使う。
//
// 列を足す前の記録や、普通にログインして入力したぶんは operator_name が空なので、
// 自動的にアカウント名の表示になる。

/**
 * 行に操作者の名前を付ける。
 *
 * operator_name が入っていればそれを使い、無いときだけ user_id から
 * アカウント名を引く。同じ人が並ぶことが多いので、引いた名前は覚えておく。
 *
 * @param {object} mainDb - メインデータベース（users を持っている方）
 * @param {Array<object>} rows - user_id と operator_name を持つ行の配列
 * @param {string} [field='username'] - 名前を入れる項目名。画面によって
 *        username だったり created_by だったりするため
 * @returns {Promise<Array<object>>} 名前を足した同じ配列
 */
async function attachOperatorNames(mainDb, rows, field = 'username') {
    const accountNames = new Map();

    for (const row of rows) {
        if (row.operator_name) {
            row[field] = row.operator_name;
            continue;
        }

        if (!accountNames.has(row.user_id)) {
            const user = await mainDb.get(
                'SELECT user_name FROM users WHERE id = ?',
                [row.user_id]
            );
            accountNames.set(row.user_id, user ? user.user_name : '不明');
        }

        row[field] = accountNames.get(row.user_id);
    }

    return rows;
}

module.exports = { attachOperatorNames };
