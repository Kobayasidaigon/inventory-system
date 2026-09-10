/**
 * 画面を実際に触って確かめるテスト。
 *
 * 絞り込みと個数入力は、配線が外れても単体テストでは気づけない（サーバー側は
 * 何も変わらないため）。ブラウザで実際に押して、在庫と履歴まで見る。
 *
 * ブラウザが要るので npm test には入れていない。
 *
 *   npm run test:ui
 *
 * 手元にブラウザが無ければ CHROME_PATH で場所を渡す。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = __dirname;
const OUT = path.join(os.tmpdir(), 'inventory-ui-shots');
const PORT = 3973;
const BASE = `http://localhost:${PORT}`;
// 未指定なら puppeteer が持っているブラウザを使う
const CHROME = process.env.CHROME_PATH || undefined;
const PASSWORD = 'test-password-1234';
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, ok, detail) {
    if (ok) { passed++; console.log(`✅ ${name}: ${detail}`); }
    else { failed++; console.log(`❌ ${name}: ${detail}`); }
}

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interact-'));
const server = spawn('node', [path.join(REPO, 'server', 'app.js')], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), DB_DIR: dbDir, NODE_ENV: 'test',
           SHIFT_MONITOR: 'off', API_RATE_LIMIT_MAX: '100000' },
    stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', () => {});
server.stderr.on('data', () => {});

const jar = new Map();
let csrf = '';
function cookieHeader() {
    return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorb(res) {
    for (const raw of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [n, ...r] = raw.split(';')[0].split('=');
        jar.set(n, r.join('='));
    }
}

async function api(method, urlPath, body) {
    const headers = {};
    if (cookieHeader()) headers.Cookie = cookieHeader();
    if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
    let payload;
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify({ ...body, _csrf: csrf });
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: payload });
    absorb(res);
    const t = await res.text();
    try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: {} }; }
}
const refresh = async () => { csrf = (await api('GET', '/api/csrf-token')).body.csrfToken; };

/** 写真の代わり。色と文字だけの画像を作る。 */
async function makeImage(label, color) {
    const svg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
           <rect width="400" height="400" fill="${color}"/>
           <text x="200" y="230" font-size="80" text-anchor="middle" fill="white"
                 font-family="sans-serif">${label}</text>
         </svg>`
    );
    return sharp(svg).png().toBuffer();
}

/** 実際の経路（multipart）で写真つきの商品を作る */
async function createProductWithImage({ name, category, stock, reorder }, image) {
    const form = new FormData();
    form.append('name', name);
    form.append('category', category);
    form.append('reorder_point', String(reorder));
    form.append('current_stock', String(stock));
    form.append('_csrf', csrf);
    form.append('image', new Blob([image], { type: 'image/png' }), 'photo.png');
    const res = await fetch(`${BASE}/api/products`, {
        method: 'POST',
        headers: { Cookie: cookieHeader(), 'X-CSRF-Token': csrf },
        body: form
    });
    absorb(res);
    return res.ok;
}

/** 撮れなくてもテストは続ける。画面の確認が主で、画像はおまけ。 */
async function screenshot(page, file) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file });
    } catch (err) {
        console.log(`  （スクリーンショットは撮れませんでした: ${err.message}）`);
    }
}

(async () => {
    let browser;
    try {
        for (let i = 0; i < 80; i++) {
            try { if ((await fetch(`${BASE}/api/csrf-token`)).ok) break; } catch {}
            await sleep(250);
        }
        await refresh();
        await api('POST', '/api/auth/admin/init', { username: 'admin', password: PASSWORD });
        await refresh();
        await api('POST', '/api/auth/admin/login', { username: 'admin', password: PASSWORD });
        await refresh();
        const loc = await api('POST', '/api/auth/admin/locations', { locationName: '萩野通店' });
        await api('POST', '/api/auth/admin/users', {
            locationId: loc.body.locationId, userId: 'staff', userName: '現場担当', password: PASSWORD
        });
        await api('POST', '/api/auth/logout');
        jar.clear();
        await refresh();
        await api('POST', '/api/auth/login', {
            locationCode: loc.body.locationCode, userId: 'staff', password: PASSWORD, rememberMe: true
        });
        await refresh();

        for (const [name, cat, stock, re] of [
            ['ペーパータオル', '消耗品', 50, 10],
            ['ゴミ袋 45L', '消耗品', 2, 5],
            ['割り箸', '備品', 120, 50],
            ['紙コップ 200ml', '備品', 44, 30]
        ]) {
            await api('POST', '/api/products', { name, category: cat, reorder_point: re, current_stock: stock });
        }

        browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
        page.on('pageerror', e => { failed++; console.log('❌ 画面のエラー:', e.message); });

        await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
        await page.waitForSelector(`#location-select option[value="${loc.body.locationCode}"]`, { timeout: 15000 });
        await page.select('#location-select', loc.body.locationCode);
        await page.type('#user-id', 'staff');
        await page.type('#password', PASSWORD);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
            page.click('#login-form button[type="submit"]')
        ]);
        await sleep(3000);

        const cardNames = () => page.$$eval('.stock-row-name, .stock-card-name', els => els.map(e => e.textContent.trim()));

        check('一覧: 4 品目が出る', (await cardNames()).length === 4, `${(await cardNames()).length} 件`);

        // --- 絞り込み ---
        await page.type('#stock-search', 'ゴミ');
        await sleep(500);
        let names = await cardNames();
        check('絞り込み: 名前の一部で絞れる', names.length === 1 && names[0].includes('ゴミ袋'), names.join(', ') || '(なし)');
        await screenshot(page, path.join(OUT, '06-search.png'));

        // 当てはまらないとき
        await page.click('#stock-search', { clickCount: 3 });
        await page.type('#stock-search', 'ぞうきん');
        await sleep(500);
        const emptyShown = await page.$eval('#stock-empty', el => el.style.display !== 'none' && el.textContent.trim());
        check('絞り込み: 0 件のとき案内が出る', Boolean(emptyShown), String(emptyShown));

        // 消すボタン
        await page.click('#stock-search-clear');
        await sleep(500);
        check('絞り込み: × で全部戻る', (await cardNames()).length === 4, `${(await cardNames()).length} 件`);

        // --- 個数を直接入れる ---
        await page.type('#stock-search', 'ペーパー');
        await sleep(500);
        const before = await page.$eval('.stock-now', el => parseInt(el.textContent, 10));
        await page.click('.stock-now');
        await sleep(400);
        const modalOpen = await page.$eval('#quantity-modal', el => el.style.display === 'block');
        check('個数入力: 数字をタップすると開く', modalOpen, `現在庫 ${before}`);
        await screenshot(page, path.join(OUT, '07-quantity-modal.png'));

        // 変な値は弾く
        await page.type('#quantity-input', '0');
        await page.click('#quantity-modal button.btn-primary');
        await sleep(400);
        const errShown = await page.$eval('#quantity-modal-error', el => el.style.display !== 'none');
        const stillOpen = await page.$eval('#quantity-modal', el => el.style.display === 'block');
        check('個数入力: 0 は弾いて開いたままにする', errShown && stillOpen, `エラー表示 ${errShown} / 開いたまま ${stillOpen}`);

        // 12 個出庫
        await page.click('#quantity-input', { clickCount: 3 });
        await page.type('#quantity-input', '12');
        await page.click('#quantity-modal button.btn-primary');
        await sleep(2500);
        const after = await page.$eval('.stock-now', el => parseInt(el.textContent, 10));
        check('個数入力: 12 個の出庫が 1 回で通る', after === before - 12, `${before} → ${after}（期待 ${before - 12}）`);

        const closed = await page.$eval('#quantity-modal', el => el.style.display !== 'block');
        check('個数入力: 登録したら閉じる', closed, `閉じた ${closed}`);

        // 履歴が 1 行だけ増えていること（4 回押した形になっていない）
        const hist = await api('GET', '/api/inventory/history');
        const rows = (hist.body || []).filter(h => h.quantity === 12);
        check('個数入力: 履歴が 1 行にまとまる', rows.length === 1, `12 個の行 ${rows.length} 件`);

        await page.click('#stock-search-clear');
        await sleep(600);
        await screenshot(page, path.join(OUT, '08-after.png'));

        // --- 写真 ---
        //
        // 写真の見え方は、写真を持つ商品を用意しないと確かめられない。
        // 一度これを怠って「写真が小さすぎる」「名前の左端が揃わない」を
        // 出してしまったので、ここで固定しておく。

        // 写真がまだ 1 枚も無い状態
        const thumbsBefore = await page.$$eval('.stock-row-thumb, .stock-card-thumb', els => els.length);
        check('写真: 誰も使っていなければ枠を出さない', thumbsBefore === 0, `枠 ${thumbsBefore} 個`);

        await refresh();
        await createProductWithImage(
            { name: '写真つき洗剤', category: '清掃', stock: 9, reorder: 3 },
            await makeImage('洗', '#3d5a80')
        );
        await page.reload({ waitUntil: 'networkidle2' });
        await sleep(3000);

        const thumbs = await page.$$eval('.stock-row-thumb, .stock-card-thumb', els => els.map(e => {
            const img = e.querySelector('img');
            const r = e.getBoundingClientRect();
            return {
                width: Math.round(r.width),
                height: Math.round(r.height),
                loaded: img ? img.naturalWidth > 0 : null
            };
        }));

        check(
            '写真: 1 つでも使っていれば、全部の商品に枠を出す',
            thumbs.length === 5,
            `枠 ${thumbs.length} 個 / 商品 5 件`
        );

        const withPhoto = thumbs.filter(t => t.loaded === true);
        check(
            '写真: 実際に読み込まれて表示される',
            withPhoto.length === 1,
            `読み込めた写真 ${withPhoto.length} 枚`
        );

        // 36px だと商品を見分けられなかった。表示によらず 40px は保つ。
        check(
            '写真: 見て分かる大きさで出る（40px 以上）',
            thumbs.every(t => t.width >= 40 && t.height >= 40),
            thumbs.map(t => `${t.width}x${t.height}`).join(', ')
        );

        // 写真のある商品と無い商品で、名前の左端が揃っていること
        const lefts = await page.$$eval('.stock-row-name, .stock-card-name', els =>
            els.map(e => Math.round(e.getBoundingClientRect().left))
        );
        const spread = Math.max(...lefts) - Math.min(...lefts);
        check(
            '写真: 写真の有無で名前の左端がずれない',
            spread <= 4,
            `左端の幅 ${spread}px（${lefts.join(', ')}）`
        );

        await screenshot(page, path.join(OUT, '09-with-photo.png'));

        // --- 表示の切り替え ---
        //
        // 既定はコンパクト。1 品目 1 枚のカードだと、50 品目で 8 画面ぶん
        // スクロールすることになる。カードの方が見やすい場面もあるので残す。

        const rowHeight = await page.$eval('.stock-row', el => Math.round(el.getBoundingClientRect().height));
        check('表示: 既定はコンパクト（1 行 1 品目）', rowHeight > 0 && rowHeight <= 72, `1 行 ${rowHeight}px`);

        await page.click('#stock-view-toggle');
        await sleep(800);
        const cardHeight = await page.$eval('.stock-card', el => Math.round(el.getBoundingClientRect().height));
        check('表示: カード表示に切り替えられる', cardHeight > rowHeight, `1 カード ${cardHeight}px（行 ${rowHeight}px）`);

        // カード表示には入庫のボタンも並ぶ
        const inButtons = await page.$$eval('.stock-card .btn-quick-in', els => els.length);
        check('表示: カード表示には入庫のボタンも出る', inButtons > 0, `+1/+5 が ${inButtons} 個`);

        // 選んだ表示を覚えていること
        await page.reload({ waitUntil: 'networkidle2' });
        await sleep(3000);
        const keptCards = await page.$$eval('.stock-card', els => els.length);
        check('表示: 選んだ表示を覚えている', keptCards > 0, `開き直してもカード表示（${keptCards} 枚）`);

        await page.click('#stock-view-toggle');
        await sleep(800);
        const backToRows = await page.$$eval('.stock-row', els => els.length);
        check('表示: コンパクトに戻せる', backToRows > 0, `${backToRows} 行`);

        // コンパクトでも、数字から個数を入れられる（入庫もここから）
        await page.click('.stock-row .stock-now');
        await sleep(400);
        const modalInCompact = await page.$eval('#quantity-modal', el => el.style.display === 'block');
        check('表示: コンパクトでも個数入力を開ける', modalInCompact, `開いた ${modalInCompact}`);
        await page.evaluate(() => closeQuantityModal());
    } catch (err) {
        failed++;
        console.error('失敗:', err.message);
    } finally {
        if (browser) await browser.close();
        server.kill();
    }
    console.log(`\n成功: ${passed} 件 / 失敗: ${failed} 件`);
    process.exitCode = failed > 0 ? 1 : 0;
})();
