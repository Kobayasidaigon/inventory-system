/**
 * ジョブカン取り込みテストスクリプト
 *
 * 2 つに分けて確かめる。
 *
 * 1. シフト表の解析（jsdom で作った HTML に対して）
 *    ジョブカンの画面構成が変わるとここが最初に壊れる。実際のログインなしで
 *    「どういう構造を前提にしているか」を固定しておく。
 *
 * 2. 取り込み API（実サーバーを起動して叩く）
 *    こちらは本番のデータを書き換える側なので、検証と権限まわりを厚めに見る。
 *
 * 使い方: node test-jobcan.js
 */

const fs = require('fs');
const { JSDOM } = require('jsdom');
const {
    createResults,
    createTempDbDir,
    createClient,
    startServer,
    setupLocationUser
} = require('./test-helpers');
const {
    extractSchedules,
    maskPersonalText,
    resolveTargetMonth,
    resolveGroups,
    DEFAULT_GROUPS
} = require('./scripts/scrape-jobcan');

const PORT = 3994;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = createTempDbDir('inventory-jobcan');
const IMPORT_SECRET = 'test-import-secret';

const { results, addResult, printSummary } = createResults();

// ---------------------------------------------------------------------------
// 1. シフト表の解析
// ---------------------------------------------------------------------------

/**
 * ジョブカンのシフト表を模した HTML を組み立てる。
 *
 * 構造は scripts/scrape-jobcan.js の extractSchedules() が前提にしているもの:
 *   - 日付ヘッダーは th.day
 *   - スタッフ名は th.first[colspan="2"]
 *   - 各日のセルは td.day / td.applying.day
 *   - 時刻は span[style*="font-size: 10px"] の中に <br> 区切り
 */
function buildShiftTable(days, staffRows) {
    const headerCells = days.map(d => `<th class="day">${d}</th>`).join('');

    const bodyRows = staffRows.map(row => {
        const cells = row.cells.map(cell => {
            const inner = cell
                ? `<span style="font-size: 10px">${cell[0]}<br>${cell[1]}</span>`
                : '';
            return `<td class="day">${inner}</td>`;
        }).join('');

        return `<tr><th class="first" colspan="2">${row.name}</th>${cells}</tr>`;
    }).join('');

    return `
        <html><body>
        <table class="note">
            <tr><th class="first" colspan="2">日</th>${headerCells}</tr>
            ${bodyRows}
        </table>
        </body></html>
    `;
}

function parseHtml(html) {
    return extractSchedules(new JSDOM(html).window.document);
}

function testExtract() {
    // --- 基本形 ---
    const basic = parseHtml(buildShiftTable(
        [1, 2, 3],
        [
            { name: '山田 太郎', cells: [null, ['19:00', '23:00'], null] },
            { name: '佐藤 花子', cells: [['09:00', '17:00'], null, ['10:00', '18:30']] }
        ]
    ));

    addResult(
        '解析: 勤務のあるセルだけ拾う',
        basic.length === 3,
        `${basic.length} 件（期待値 3）`
    );
    addResult(
        '解析: スタッフ名・日付・時刻が対応している',
        basic[0].staffName === '山田 太郎' && basic[0].day === 2 &&
            basic[0].startTime === '19:00' && basic[0].endTime === '23:00',
        JSON.stringify(basic[0])
    );
    addResult(
        '解析: 2 人目の日付がずれない',
        basic[2].staffName === '佐藤 花子' && basic[2].day === 3 &&
            basic[2].startTime === '10:00',
        JSON.stringify(basic[2])
    );

    // --- 申請中のセル (td.applying.day) も対象 ---
    const applying = parseHtml(`
        <table class="note">
            <tr><th class="first" colspan="2">日</th><th class="day">5</th></tr>
            <tr><th class="first" colspan="2">鈴木 一郎</th>
                <td class="applying day"><span style="font-size: 10px">08:00<br>12:00</span></td></tr>
        </table>
    `);
    addResult(
        '解析: 申請中のセルも取り込む',
        applying.length === 1 && applying[0].day === 5 && applying[0].startTime === '08:00',
        JSON.stringify(applying[0] || null)
    );

    // --- 時刻が 1 つしかないセルは無視する ---
    const single = parseHtml(`
        <table class="note">
            <tr><th class="first" colspan="2">日</th><th class="day">1</th></tr>
            <tr><th class="first" colspan="2">田中 次郎</th>
                <td class="day"><span style="font-size: 10px">10:00</span></td></tr>
        </table>
    `);
    addResult(
        '解析: 開始だけで終了がないセルは取り込まない',
        single.length === 0,
        `${single.length} 件（期待値 0）`
    );

    // --- 時刻でない文字が混ざっても落とす ---
    const noisy = parseHtml(`
        <table class="note">
            <tr><th class="first" colspan="2">日</th><th class="day">7</th></tr>
            <tr><th class="first" colspan="2">高橋 三郎</th>
                <td class="day"><span style="font-size: 10px">有給<br>13:00<br>21:00</span></td></tr>
        </table>
    `);
    addResult(
        '解析: 時刻でない文字は読み飛ばす',
        noisy.length === 1 && noisy[0].startTime === '13:00' && noisy[0].endTime === '21:00',
        JSON.stringify(noisy[0] || null)
    );

    // --- テーブルが無い / 構造が変わった場合 ---
    addResult(
        '解析: table.note が無ければ 0 件を返す（例外にしない）',
        parseHtml('<html><body><p>該当するスタッフがみつかりません</p></body></html>').length === 0,
        '0 件'
    );
    addResult(
        '解析: 日付ヘッダーが無ければ 0 件を返す',
        parseHtml('<table class="note"><tr><th class="first" colspan="2">山田</th></tr></table>').length === 0,
        '0 件'
    );
}

// ---------------------------------------------------------------------------
// 1b. 調査用 HTML の伏せ字
//
// このリポジトリは公開されている。GitHub Actions のアーティファクトは誰でも
// 取得できるので、debug/ に残す HTML にスタッフの氏名や勤務時間が素のまま
// 入っていてはいけない。一方で、セレクタを直すのに要る構造は残す必要がある。
// その両立をここで固定する。
// ---------------------------------------------------------------------------

function maskHtml(html) {
    return maskPersonalText(new JSDOM(html).window.document);
}

function testMasking() {
    const masked = maskHtml(buildShiftTable(
        [1, 2],
        [{ name: '山田 太郎', cells: [null, ['19:00', '23:00']] }]
    ));

    addResult(
        '伏せ字: スタッフの氏名が残らない',
        !masked.includes('山田') && !masked.includes('太郎'),
        masked.includes('山田') ? '氏名が残っている' : '残っていない'
    );
    addResult(
        '伏せ字: 勤務時間そのものが残らない',
        !masked.includes('19:00') && !masked.includes('23:00'),
        masked.includes('19:00') ? '時刻が残っている' : '残っていない'
    );
    addResult(
        '伏せ字: 時刻の桁と : は形として残る（構造が読める）',
        masked.includes('00:00'),
        '00:00 の形で残る'
    );
    addResult(
        '伏せ字: タグと class は残る（セレクタが直せる）',
        masked.includes('table class="note"')
            && masked.includes('class="day"')
            && masked.includes('class="first"'),
        'table.note / th.day / th.first すべて残る'
    );
    // 伏せた HTML から拾い直せるかは見ない。日付ヘッダーの数字も伏せるので
    // 解析は通らない。この HTML の役目は「セレクタが当たるか」を確かめること。
    const maskedDoc = new JSDOM(masked).window.document;
    const selectors = [
        'table.note',
        'th.day',
        'th.first[colspan=\"2\"]',
        'td.day',
        'span[style*=\"font-size: 10px\"]'
    ];
    const missing = selectors.filter(s => !maskedDoc.querySelector(s));
    addResult(
        '伏せ字: セレクタを直すのに要る構造が全部残る',
        missing.length === 0,
        missing.length === 0 ? selectors.join(' / ') : `見つからない: ${missing.join(' / ')}`
    );

    // 氏名は本文だけでなく属性にも入りうる
    const attrs = maskHtml(
        '<div title="山田 太郎" data-staff="佐藤 花子" class="keep">' +
        '<input value="鈴木 一郎" placeholder="氏名"></div>'
    );
    addResult(
        '伏せ字: title / value / placeholder も伏せる',
        !attrs.includes('山田') && !attrs.includes('鈴木') && !attrs.includes('氏名'),
        '属性に残っていない'
    );
    addResult(
        '伏せ字: data-* も伏せる',
        !attrs.includes('佐藤') && !attrs.includes('花子'),
        'data-staff に残っていない'
    );
    addResult(
        '伏せ字: class は伏せない',
        attrs.includes('class="keep"'),
        'class="keep" が残る'
    );

    // 画面に出ていなくても、script の中に一覧が埋まっていることがある
    const script = maskHtml(
        '<html><body><script>var staff = ["山田 太郎"];</script></body></html>'
    );
    addResult(
        '伏せ字: script の中の氏名も伏せる',
        !script.includes('山田'),
        'script 内にも残っていない'
    );

    // 伏せ字は複製に対して行う。元の DOM を書き換えると、このあと走る
    // extractSchedules() が伏せ字を読んで 0 件になる。
    const liveDoc = new JSDOM(buildShiftTable(
        [1, 2],
        [{ name: '山田 太郎', cells: [null, ['19:00', '23:00']] }]
    )).window.document;
    maskPersonalText(liveDoc);
    const afterMask = extractSchedules(liveDoc);
    addResult(
        '伏せ字: 元のページを書き換えない（伏せた後も取得できる）',
        afterMask.length === 1 && afterMask[0].staffName === '山田 太郎'
            && afterMask[0].startTime === '19:00',
        JSON.stringify(afterMask[0] || null)
    );

    addResult(
        '伏せ字: 中身が無くても落ちない',
        maskHtml('<html></html>').length > 0,
        '空でも例外にならない'
    );
}

// ---------------------------------------------------------------------------
// 2. 対象月の決め方
// ---------------------------------------------------------------------------

function testTargetMonth() {
    addResult(
        '対象月: 25日より前は当月',
        resolveTargetMonth(null, new Date(2026, 8, 14)) === '2026-09',
        resolveTargetMonth(null, new Date(2026, 8, 14))
    );
    addResult(
        '対象月: 25日以降は翌月',
        resolveTargetMonth(null, new Date(2026, 8, 30)) === '2026-10',
        resolveTargetMonth(null, new Date(2026, 8, 30))
    );
    addResult(
        '対象月: 12月末は翌年1月',
        resolveTargetMonth(null, new Date(2026, 11, 30)) === '2027-01',
        resolveTargetMonth(null, new Date(2026, 11, 30))
    );
    addResult(
        '対象月: 引数の指定が優先される',
        resolveTargetMonth('2026-03', new Date(2026, 8, 30)) === '2026-03',
        resolveTargetMonth('2026-03', new Date(2026, 8, 30))
    );

    let rejected = false;
    try {
        resolveTargetMonth('2026/03');
    } catch (err) {
        rejected = true;
    }
    addResult('対象月: 形式が違えば拒否する', rejected, rejected ? '拒否した' : '通してしまった');

    addResult(
        '店舗: 既定は 3 店舗',
        resolveGroups().length === 3 && DEFAULT_GROUPS[0].id === '3',
        DEFAULT_GROUPS.map(g => `${g.id}=${g.name}`).join(' , ')
    );
}

// ---------------------------------------------------------------------------
// 3. 取り込み API
// ---------------------------------------------------------------------------

async function testImportApi(client) {
    const { request } = client;
    await setupLocationUser(client);

    const post = (body) => request('POST', '/api/staff/import-schedules', body);

    const sample = (overrides = {}) => ({
        staffName: '山田 太郎',
        day: 6,
        startTime: '19:00',
        endTime: '23:00',
        groupId: '3',
        groupName: 'テスト店',
        ...overrides
    });

    // --- 認証 ---
    const noSecret = await post({ schedules: [sample()], targetMonth: '2026-09' });
    addResult(
        '取り込み: 合言葉なしは拒否する',
        noSecret.status === 401,
        `status ${noSecret.status} / ${noSecret.body.error || ''}`
    );

    const wrongSecret = await post({ secret: 'wrong', schedules: [sample()], targetMonth: '2026-09' });
    addResult(
        '取り込み: 合言葉が違えば拒否する',
        wrongSecret.status === 401,
        `status ${wrongSecret.status} / ${wrongSecret.body.error || ''}`
    );

    // --- 入力の検証 ---
    const badCases = [
        ['対象月の形式', { secret: IMPORT_SECRET, schedules: [sample()], targetMonth: '2026/09' }],
        ['存在しない日', { secret: IMPORT_SECRET, schedules: [sample({ day: 31 })], targetMonth: '2026-09' }],
        ['スタッフ名が空', { secret: IMPORT_SECRET, schedules: [sample({ staffName: '  ' })], targetMonth: '2026-09' }],
        ['時刻の形式', { secret: IMPORT_SECRET, schedules: [sample({ startTime: '19時' })], targetMonth: '2026-09' }],
        ['空の一覧', { secret: IMPORT_SECRET, schedules: [], targetMonth: '2026-09' }]
    ];

    for (const [label, body] of badCases) {
        const res = await post(body);
        addResult(
            `取り込み: ${label}が不正なら拒否する`,
            res.status === 400,
            `status ${res.status} / ${res.body.error || ''}`
        );
    }

    // 1 件でも不正なら 1 件も入らない
    const partial = await post({
        secret: IMPORT_SECRET,
        schedules: [sample({ staffName: '正常 太郎' }), sample({ staffName: '' })],
        targetMonth: '2026-09'
    });
    const afterPartial = await request('GET', '/api/staff/schedules?month=2026-09');
    addResult(
        '取り込み: 1 件でも不正なら 1 件も保存しない',
        partial.status === 400 && afterPartial.body.count === 0,
        `status ${partial.status} / 保存 ${afterPartial.body.count} 件`
    );

    // --- 正常系 ---
    const ok = await post({
        secret: IMPORT_SECRET,
        schedules: [
            sample(),
            sample({ staffName: '佐藤 花子', day: 6, startTime: '09:00', endTime: '17:00' }),
            sample({ staffName: '山田 太郎', day: 7, startTime: '19:00', endTime: '23:00' })
        ],
        targetMonth: '2026-09'
    });
    addResult(
        '取り込み: 正しいデータを保存する',
        ok.status === 200 && ok.body.created === 3 && ok.body.staffCreated === 2,
        `新規 ${ok.body.created} / スタッフ新規 ${ok.body.staffCreated}`
    );

    // --- 二重取り込みで増えない（同じ日・同じ開始時刻は 1 件） ---
    const again = await post({
        secret: IMPORT_SECRET,
        schedules: [sample(), sample({ staffName: '佐藤 花子', day: 6, startTime: '09:00', endTime: '17:00' })],
        targetMonth: '2026-09'
    });
    addResult(
        '取り込み: 同じ内容を二度送っても増えない',
        again.status === 200 && again.body.created === 0 && again.body.updated === 2,
        `新規 ${again.body.created} / 更新 ${again.body.updated}`
    );

    // --- 終了時刻が変わったら上書きする ---
    await post({
        secret: IMPORT_SECRET,
        schedules: [sample({ endTime: '22:00' })],
        targetMonth: '2026-09'
    });
    const afterUpdate = await request('GET', '/api/staff/schedules?month=2026-09');
    const yamada = afterUpdate.body.schedules.find(
        s => s.staff_name === '山田 太郎' && s.date === '2026-09-06'
    );
    addResult(
        '取り込み: 終了時刻の変更は行を増やさず上書きする',
        yamada && yamada.end_time === '22:00' && afterUpdate.body.count === 3,
        `終了 ${yamada && yamada.end_time} / 合計 ${afterUpdate.body.count} 件`
    );

    // --- 拠点名が一致すれば結びつく ---
    // setupLocationUser が作る拠点名は「テスト店」。sample() の groupName と同じなので、
    // jobcan_group_id を設定していなくても名前で結びつくはず。
    addResult(
        '取り込み: 拠点名が一致すれば結びつく',
        Array.isArray(ok.body.unmatchedGroups) && ok.body.unmatchedGroups.length === 0,
        `未対応: ${JSON.stringify(ok.body.unmatchedGroups)}`
    );

    const withLocation = await request('GET', '/api/staff/schedules?month=2026-09');
    const linked = withLocation.body.schedules.find(s => s.staff_name === '佐藤 花子');
    addResult(
        '取り込み: 結びついた拠点名が読み出せる',
        linked && linked.location_name === 'テスト店',
        `拠点 ${linked && linked.location_name}`
    );

    // --- どの拠点にも当たらない店舗は報告する（設定漏れに気づけるように） ---
    const unknown = await post({
        secret: IMPORT_SECRET,
        schedules: [sample({ staffName: '鈴木 一郎', day: 8, groupId: '99', groupName: '未登録店' })],
        targetMonth: '2026-09'
    });
    addResult(
        '取り込み: 拠点に結びつかない店舗を報告する',
        unknown.status === 200 && unknown.body.unmatchedGroups.includes('未登録店'),
        `未対応: ${JSON.stringify(unknown.body.unmatchedGroups)}`
    );

    // 一般ユーザーには自分の拠点ぶんしか見えないので、拠点不明の行は出てこない
    const asStaff = await request('GET', '/api/staff/schedules?month=2026-09');
    addResult(
        '読み出し: 一般ユーザーには自分の拠点ぶんだけ返る',
        asStaff.body.schedules.every(s => s.location_name === 'テスト店'),
        `拠点: ${[...new Set(asStaff.body.schedules.map(s => String(s.location_name)))].join(', ')}`
    );

    // --- 読み出しはログインが要る ---
    const noAuth = await fetch(`${BASE_URL}/api/staff/schedules?month=2026-09`);
    addResult(
        '読み出し: ログインしていなければ拒否する',
        noAuth.status === 401,
        `status ${noAuth.status}`
    );

    // --- 管理者は全拠点を見られる。拠点不明の行もここで確認する ---
    await request('POST', '/api/auth/logout');
    client.resetSession();
    await client.refreshCsrfToken();
    await request('POST', '/api/auth/admin/login', {
        username: 'admin',
        password: 'test-password-1234'
    });
    await client.refreshCsrfToken();

    const asAdmin = await request('GET', '/api/staff/schedules?month=2026-09');
    const orphan = asAdmin.body.schedules.find(s => s.staff_name === '鈴木 一郎');
    addResult(
        '取り込み: 拠点が分からなくても勤務予定自体は残す',
        orphan && orphan.location_name === null,
        `拠点 ${orphan ? String(orphan.location_name) : '(行が無い)'}`
    );
    addResult(
        '読み出し: 管理者は拠点をまたいで見られる',
        asAdmin.body.count > asStaff.body.count,
        `管理者 ${asAdmin.body.count} 件 / 一般 ${asStaff.body.count} 件`
    );
}

// ---------------------------------------------------------------------------

(async () => {
    console.log('========================================');
    console.log('ジョブカン取り込みテスト開始');
    console.log('========================================\n');

    testExtract();
    testMasking();
    testTargetMonth();

    const { server, waitUntilReady } = startServer({
        port: PORT,
        dbDir: DB_DIR,
        env: { IMPORT_SECRET }
    });

    try {
        await waitUntilReady(BASE_URL);
        await testImportApi(createClient(BASE_URL));
    } catch (err) {
        results.failed++;
        console.error('\n❌ テストの実行中にエラーが発生しました:', err.message);
    } finally {
        server.kill();
        fs.rmSync(DB_DIR, { recursive: true, force: true });
    }

    printSummary();
    process.exit(results.failed > 0 ? 1 : 0);
})();
