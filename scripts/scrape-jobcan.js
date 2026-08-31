/**
 * ジョブカン勤怠から店舗ごとの勤務予定を取得し、在庫システムへ取り込むスクリプト。
 *
 * 使い方:
 *   node scripts/scrape-jobcan.js              # 対象月を自動で決める
 *   node scripts/scrape-jobcan.js 2026-09      # 対象月を指定する
 *   node scripts/scrape-jobcan.js --dry-run    # 取得だけして送信しない
 *
 * 必要な環境変数:
 *   JOBCAN_EMAIL / JOBCAN_PASSWORD  ジョブカンのログイン情報
 *   API_BASE                        取り込み先（例 https://inventory-system-aburiva.fly.dev）
 *   IMPORT_SECRET                   取り込み口の合言葉（サーバー側と同じ値）
 *   JOBCAN_GROUPS                   店舗の指定（JSON）。未設定なら既定の 3 店舗
 *
 * 注意: ジョブカンの HTML が変わるとセレクタが動かなくなる。
 * 0 件になったら debug/ に保存される HTML を見て、extractSchedules() の
 * セレクタを直すこと。ここが一番壊れやすい。
 *
 * debug/ の HTML は maskPersonalText() で中身の文字を伏せてから保存する。
 * このリポジトリは公開されていて、GitHub Actions のアーティファクトは
 * 誰でも取得できるため、スタッフの氏名や勤務時間を素のまま置けない。
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'https://id.jobcan.jp/users/sign_in?app_key=atd&redirect_to=https://ssl.jobcan.jp/jbcoauth/callback';
const MANAGER_URL = 'https://ssl.jobcan.jp/employee/login-manager/?cmi=5';
const SCHEDULE_URL = 'https://ssl.jobcan.jp/client/shift-schedule/';

// 既定の店舗。ジョブカンのシフト表 URL の group_id で確認できる。
const DEFAULT_GROUPS = [
    { id: '3', name: '萩野通店' },
    { id: '5', name: '笠寺店' },
    { id: '6', name: '枇杷島店' }
];

// 1 回の送信に含める件数。多すぎるとサーバー側で弾かれる。
const CHUNK_SIZE = 100;

// 送信の間隔（ミリ秒）。相手のレート制限に当たらないように空ける。
const CHUNK_INTERVAL_MS = 1000;

// 1 回の送信を待つ上限（ミリ秒）。
// fetch は既定で待ち続けるので、相手が黙り込むとジョブが何時間も居座る。
// Fly のマシンは停止していることがあり、起き上がるのに十数秒かかるため、
// 短すぎない値にしている。
const REQUEST_TIMEOUT_MS = 60000;

// 各操作のあとの待ち時間。描画前に読むと 0 件になるので必ず待つ。
const WAIT_AFTER_ACTION_MS = 2000;
const WAIT_AFTER_SEARCH_MS = 5000;

const DEBUG_DIR = path.join(__dirname, '..', 'debug');

// GitHub Actions で動いているか。
// このリポジトリは公開されていて、実行ログもアーティファクトも誰でも読める。
// 手元で動かすときだけ、スタッフ名と取得結果そのものを出す。
const IS_CI = Boolean(process.env.CI);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

/**
 * 取得対象の店舗を決める。
 *
 * JOBCAN_GROUPS に [{"id":"3","name":"萩野通店"}, ...] の JSON を入れると差し替えられる。
 */
function resolveGroups() {
    const raw = process.env.JOBCAN_GROUPS;

    if (!raw) {
        return DEFAULT_GROUPS;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`JOBCAN_GROUPS が JSON として読めません: ${err.message}`);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('JOBCAN_GROUPS は [{ "id": "3", "name": "店舗名" }] の形の配列で指定してください');
    }

    for (const group of parsed) {
        if (!group || !group.id || !group.name) {
            throw new Error('JOBCAN_GROUPS の各要素には id と name が必要です');
        }
    }

    return parsed;
}

/**
 * 対象月を決める。
 *
 * 月末の実行で翌月ぶんを先取りしたいので、25 日以降は翌月を見る。
 * 引数で YYYY-MM を渡したらそれを優先する。
 */
function resolveTargetMonth(argument, now = new Date()) {
    if (argument) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(argument)) {
            throw new Error(`対象月は YYYY-MM 形式で指定してください: ${argument}`);
        }
        return argument;
    }

    const base = now.getDate() >= 25
        ? new Date(now.getFullYear(), now.getMonth() + 1, 1)
        : now;

    return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// シフト表の解析
// ---------------------------------------------------------------------------

/**
 * シフト表のテーブルから勤務予定を取り出す。
 *
 * ブラウザの中でも Node のテストからも呼べるように、document を引数で受け取る
 * （省略時はブラウザの document を使う）。Puppeteer に渡す都合上、この関数は
 * 外側の変数を参照してはいけない。
 *
 * @param {Document} [doc]
 * @returns {Array<{staffName: string, day: number, startTime: string, endTime: string}>}
 */
function extractSchedules(doc) {
    const targetDocument = doc || document;
    const results = [];

    const table = targetDocument.querySelector('table.note');
    if (!table) {
        return results;
    }

    const rows = table.querySelectorAll('tr');

    // 日付ヘッダー（1, 2, 3 ...）を並び順のまま拾う
    let dayHeaders = [];
    rows.forEach(row => {
        const dayCells = row.querySelectorAll('th.day');
        if (dayCells.length > dayHeaders.length) {
            dayHeaders = Array.from(dayCells).map(th => parseInt(th.textContent.trim(), 10));
        }
    });

    if (dayHeaders.length === 0) {
        return results;
    }

    rows.forEach(row => {
        const nameCell = row.querySelector('th.first[colspan="2"]');
        if (!nameCell) {
            return;
        }

        const staffName = nameCell.textContent.trim();
        if (!staffName) {
            return;
        }

        const dayCells = row.querySelectorAll('td.day, td.applying.day');

        dayCells.forEach((cell, index) => {
            const day = dayHeaders[index];
            if (!day) {
                return;
            }

            const timeSpan = cell.querySelector('span[style*="font-size: 10px"]');
            if (!timeSpan) {
                return;
            }

            // "19:00<br>23:00" の形から時刻を 2 つ取り出す
            const times = timeSpan.innerHTML
                .split(/<br\s*\/?>/i)
                .map(part => part.replace(/<[^>]*>/g, '').trim())
                .filter(part => /^\d{1,2}:\d{2}$/.test(part));

            if (times.length >= 2) {
                results.push({
                    staffName: staffName,
                    day: day,
                    startTime: times[0],
                    endTime: times[1]
                });
            }
        });
    });

    return results;
}

// ---------------------------------------------------------------------------
// ブラウザ操作
// ---------------------------------------------------------------------------

/**
 * ページから読み取れる文字をすべて伏せた HTML を返す。
 *
 * セレクタを直すのに要るのはタグと class の構造だけで、書かれている文字は
 * 要らない。そこで桁数と区切り記号の位置は残したまま、数字を 0、それ以外の
 * 文字を ● に置き換える。
 *
 *   山田 太郎 -> ●● ●●
 *   19:00     -> 00:00
 *
 * 構造は読めるが、誰の何時のシフトかは読めない。
 *
 * extractSchedules() と同じく、引数なしならブラウザの document を使う。
 * こうしておくと page.evaluate() からも jsdom のテストからも呼べる。
 */
function maskPersonalText(doc) {
    const targetDocument = doc || document;

    if (!targetDocument.documentElement) {
        return '';
    }

    // 複製に対して伏せる。元の DOM を書き換えると、このあと走る
    // extractSchedules() が伏せ字を読んで 0 件になってしまう。
    const root = targetDocument.documentElement.cloneNode(true);

    // 時刻らしさが分かるよう : - / と空白は残す
    const mask = text => text.replace(/[0-9]/g, '0').replace(/[^\s0:\-/]/g, '●');

    // 人が読める内容が入りうる属性。class や id は選び出すのに要るので残す。
    const MASKED_ATTRIBUTES = ['title', 'alt', 'value', 'placeholder', 'aria-label'];

    const walker = targetDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    const textNodes = [];

    while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
    }

    for (const node of textNodes) {
        node.nodeValue = mask(node.nodeValue);
    }

    for (const element of root.querySelectorAll('*')) {
        for (const name of MASKED_ATTRIBUTES) {
            if (element.hasAttribute(name)) {
                element.setAttribute(name, mask(element.getAttribute(name)));
            }
        }
        // data-* は何が入っているか分からないので一律で伏せる
        for (const attribute of [...element.attributes]) {
            if (attribute.name.startsWith('data-')) {
                element.setAttribute(attribute.name, mask(attribute.value));
            }
        }
    }

    return root.outerHTML;
}

// 調査用のファイルを残す。中身は maskPersonalText() で伏せてから渡すこと。
function saveDebugArtifact(name, content) {
    if (!fs.existsSync(DEBUG_DIR)) {
        fs.mkdirSync(DEBUG_DIR, { recursive: true });
    }
    fs.writeFileSync(path.join(DEBUG_DIR, name), content);
}

async function login(page) {
    const email = process.env.JOBCAN_EMAIL;
    const password = process.env.JOBCAN_PASSWORD;

    if (!email || !password) {
        throw new Error('JOBCAN_EMAIL と JOBCAN_PASSWORD を設定してください');
    }

    console.log('ジョブカンにログインしています...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
    await page.type('input[name="user[email]"]', email);
    await page.type('input[name="user[password]"]', password);

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('#login_button')
    ]);
    await sleep(WAIT_AFTER_ACTION_MS);

    // ログインに失敗するとサインイン画面に留まる。
    // ここで気づかないと「0 件取得」という分かりにくい失敗になるので、はっきり落とす。
    if (page.url().includes('/users/sign_in')) {
        saveDebugArtifact('login-failed.html', await page.evaluate(maskPersonalText));
        throw new Error(
            'ログインできませんでした。JOBCAN_EMAIL と JOBCAN_PASSWORD を確認してください'
        );
    }

    console.log('ログインしました。管理者ページへ切り替えます...');
    await page.goto(MANAGER_URL, { waitUntil: 'networkidle2' });
    await sleep(WAIT_AFTER_ACTION_MS);
}

async function scrapeGroup(page, group, targetMonth) {
    const [year, month] = targetMonth.split('-');
    console.log(`\n--- ${group.name}（group_id=${group.id}） ---`);

    await page.goto(
        `${SCHEDULE_URL}?group_id=${group.id}&tab_type=shift_schedule`,
        { waitUntil: 'networkidle2' }
    );
    await sleep(WAIT_AFTER_ACTION_MS);

    await page.select('select[name="from[month][y]"]', year);
    // 月の選択肢は先頭 0 なし（"9" であって "09" ではない）
    await page.select('select[name="from[month][m]"]', String(parseInt(month, 10)));

    const clicked = await page.evaluate(() => {
        const button = document.querySelector('.btn-info');
        if (!button) {
            return false;
        }
        button.click();
        return true;
    });

    if (!clicked) {
        saveDebugArtifact(`no-display-button-${group.id}.html`, await page.evaluate(maskPersonalText));
        throw new Error(
            `「表示」ボタン (.btn-info) が見つかりません（${group.name}）。` +
            'ジョブカンの画面構成が変わった可能性があります'
        );
    }

    // 描画を待つ。待たずに読むと 0 件になる。
    await sleep(WAIT_AFTER_SEARCH_MS);

    // うまくいかなかったときに原因を追えるよう、毎回残しておく。
    // スクリーンショットは撮らない。画像は中身を伏せられないため。
    saveDebugArtifact(`schedule-${group.id}.html`, await page.evaluate(maskPersonalText));

    const schedules = await page.evaluate(extractSchedules);

    // 取れているか目視できるよう先頭を数件出す。
    // CI では氏名を伏せる。実行ログは公開されていて誰でも読めるため。
    console.log(`${schedules.length} 件を取得しました`);
    schedules.slice(0, 3).forEach(s => {
        const who = IS_CI ? '' : `${s.staffName} `;
        console.log(`  ${who}${s.day}日 ${s.startTime}-${s.endTime}`);
    });

    return schedules.map(s => ({ ...s, groupId: group.id, groupName: group.name }));
}

async function scrapeAll(targetMonth, groups) {
    const puppeteer = require('puppeteer');

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.setDefaultTimeout(30000);

        await login(page);

        const all = [];
        for (const group of groups) {
            all.push(...await scrapeGroup(page, group, targetMonth));
        }
        return all;
    } finally {
        await browser.close();
    }
}

// ---------------------------------------------------------------------------
// 取り込み
// ---------------------------------------------------------------------------

async function importToApi(schedules, targetMonth) {
    const apiBase = (process.env.API_BASE || '').replace(/\/$/, '');
    const secret = process.env.IMPORT_SECRET;

    if (!apiBase) {
        throw new Error('API_BASE を設定してください（例 https://inventory-system-aburiva.fly.dev）');
    }
    if (!secret) {
        throw new Error('IMPORT_SECRET を設定してください（サーバー側と同じ値）');
    }

    const totals = { created: 0, updated: 0, staffCreated: 0 };
    const unmatched = new Set();

    for (let i = 0; i < schedules.length; i += CHUNK_SIZE) {
        const chunk = schedules.slice(i, i + CHUNK_SIZE);
        const label = `${i + 1}〜${i + chunk.length}件目`;

        let res;
        try {
            res = await fetch(`${apiBase}/api/staff/import-schedules`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ secret, schedules: chunk, targetMonth }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
        } catch (err) {
            // タイムアウトも接続失敗もここに来る。何件目で止まったかを残す。
            // 取り込みは同じ内容を送り直しても増えないので、直して再実行できる。
            throw new Error(
                `取り込み先に届きませんでした (${label}): ${err.message}。` +
                `API_BASE (${apiBase}) を確認してください`
            );
        }

        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
            // サーバーの検証エラーには、どの予定が悪いかを示すためにスタッフ名が
            // 入る（例「9月に 31日 はありません（山田 太郎）」）。CI の実行ログは
            // 公開されているので、そこには出さない。中身を見たいときは手元で
            // --dry-run を付けて実行する。
            const detail = IS_CI
                ? '（内容は伏せています。手元で --dry-run を付けて実行すると出ます）'
                : body.error || '';
            throw new Error(`取り込みに失敗しました (${label}): ${res.status} ${detail}`);
        }

        totals.created += body.created || 0;
        totals.updated += body.updated || 0;
        totals.staffCreated += body.staffCreated || 0;
        (body.unmatchedGroups || []).forEach(g => unmatched.add(g));

        console.log(`${label}: 新規 ${body.created} / 更新 ${body.updated}`);

        if (i + CHUNK_SIZE < schedules.length) {
            await sleep(CHUNK_INTERVAL_MS);
        }
    }

    return { ...totals, unmatchedGroups: [...unmatched] };
}

// ---------------------------------------------------------------------------

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const monthArgument = args.find(a => !a.startsWith('--'));

    const targetMonth = resolveTargetMonth(monthArgument);
    const groups = resolveGroups();

    console.log('========================================');
    console.log(`ジョブカン シフト取得 (${targetMonth})`);
    console.log(`対象店舗: ${groups.map(g => g.name).join('、')}`);
    if (dryRun) {
        console.log('モード: 取得のみ（送信しません）');
    }
    console.log('========================================');

    const schedules = await scrapeAll(targetMonth, groups);

    console.log('\n========================================');
    console.log(`合計 ${schedules.length} 件`);
    for (const group of groups) {
        const count = schedules.filter(s => s.groupId === group.id).length;
        console.log(`  ${group.name}: ${count} 件`);
    }

    // 取得結果そのもの。氏名と勤務時間がそのまま入るので、伏せようがない。
    // 手元で中身を確かめるためのものなので、CI では書き出さない。
    // 書き出すとアーティファクトに乗り、公開リポジトリでは誰でも取得できてしまう。
    if (!IS_CI) {
        saveDebugArtifact(
            `schedules-${targetMonth}.json`,
            JSON.stringify(schedules, null, 2)
        );
    }

    if (schedules.length === 0) {
        throw new Error(
            '1 件も取得できませんでした。debug/ の HTML を開いて table.note の構造を確認してください'
        );
    }

    if (dryRun) {
        console.log('\n--dry-run のため送信しませんでした');
        return;
    }

    console.log('\n取り込んでいます...');
    const result = await importToApi(schedules, targetMonth);

    console.log('========================================');
    console.log(`新規 ${result.created} / 更新 ${result.updated} / スタッフ新規 ${result.staffCreated}`);

    if (result.unmatchedGroups.length > 0) {
        console.warn(
            `⚠ 拠点に結びつかない店舗: ${result.unmatchedGroups.join('、')}\n` +
            '  locations.jobcan_group_id を設定してください'
        );
    }

    console.log('========================================');
}

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch(error => {
            console.error('\n処理に失敗しました:', error.message);
            process.exit(1);
        });
}

module.exports = {
    DEFAULT_GROUPS,
    resolveGroups,
    resolveTargetMonth,
    extractSchedules,
    maskPersonalText
};
