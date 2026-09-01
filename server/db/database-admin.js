const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// データベースディレクトリのパス（環境変数または既定値）
const DB_DIR = process.env.DB_DIR || path.join(__dirname);

// データベースディレクトリが存在しない場合は作成
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

// 拠点ごとのデータベース接続を管理
const dbConnections = new Map();

// Promiseベースのメソッドを追加する関数
function addPromiseMethods(db) {
    const originalGet = db.get.bind(db);
    const originalAll = db.all.bind(db);
    const originalRun = db.run.bind(db);

    db.get = function(query, params = []) {
        return new Promise((resolve, reject) => {
            originalGet(query, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    };

    db.all = function(query, params = []) {
        return new Promise((resolve, reject) => {
            originalAll(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    };

    db.run = function(query, params = []) {
        return new Promise((resolve, reject) => {
            originalRun(query, params, function(err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    };

    return db;
}

/**
 * 初期化（テーブル作成・マイグレーション）が終わるまでクエリを待たせる。
 *
 * sqlite3 の Database は接続直後から使えてしまうので、テーブルができる前の
 * SELECT が「テーブルがない」「行がまだ入っていない」状態を読んでしまう。
 * 初期化そのものは待たせるわけにいかないので、初期化には差し替え前の
 * メソッド（raw）を渡し、外から使うメソッドだけ差し替える。
 *
 * @param {object} db - 対象のデータベース
 * @param {Function} initialize - raw を受け取って初期化する関数
 * @returns {object} 初期化に使う素のメソッド
 */
function gateUntilReady(db, initialize) {
    const raw = {
        get: db.get,
        all: db.all,
        run: db.run
    };

    db.ready = initialize(raw);

    for (const name of ['get', 'all', 'run']) {
        db[name] = async function (query, params = []) {
            await db.ready;
            return raw[name](query, params);
        };
    }

    return raw;
}

// メインデータベース（拠点とユーザー管理用）
const mainDbPath = path.join(DB_DIR, 'main.db');
const mainDb = addPromiseMethods(new sqlite3.Database(mainDbPath));

// メインDBのテーブル作成
async function initMainDatabase(db) {
    // 拠点テーブル
    await db.run(`
        CREATE TABLE IF NOT EXISTS locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location_code TEXT UNIQUE NOT NULL,
            location_name TEXT NOT NULL,
            db_name TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ユーザーテーブル
    await db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location_id INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            user_name TEXT NOT NULL,
            password TEXT NOT NULL,
            is_admin BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (location_id) REFERENCES locations(id),
            UNIQUE(location_id, user_id)
        )
    `);

    // 設定テーブル（LINE通知用など）
    await db.run(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 入場リンクの nonce（使い捨ての印）
    //
    // 信頼している別サイトからの署名付きリンクを、1 回しか通さないための記録。
    // リンクは履歴に残るし共有もされうるので、同じものを二度は使えないようにする。
    // expires_at は UNIX 秒。過ぎたものは期限切れとして弾かれるため、消してよい。
    await db.run(`
        CREATE TABLE IF NOT EXISTS entry_nonces (
            nonce TEXT PRIMARY KEY,
            expires_at INTEGER NOT NULL,
            used_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Remember Meトークンテーブル
    await db.run(`
        CREATE TABLE IF NOT EXISTS remember_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // QRコード用トークンテーブル（長期間有効）
    await db.run(`
        CREATE TABLE IF NOT EXISTS qr_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // ご意見ボックステーブル（匿名）
    await db.run(`
        CREATE TABLE IF NOT EXISTS feedbacks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location_id INTEGER,
            feedback_text TEXT NOT NULL,
            status TEXT DEFAULT 'new' CHECK(status IN ('new', 'read', 'resolved')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL
        )
    `);

    // スタッフテーブル（ジョブカンから取り込む勤務者）
    //
    // users（このアプリのログイン用アカウント）とは別物。
    // ジョブカンに載る勤務者全員が対象で、アプリにログインするとは限らない。
    await db.run(`
        CREATE TABLE IF NOT EXISTS staff (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // スタッフの勤務予定テーブル
    //
    // 同じ日・同じ開始時刻の予定は 1 件に保つ（UNIQUE）。終了時刻が変わったときは
    // 行を増やさず上書きしたいので、終了時刻はキーに含めない。
    await db.run(`
        CREATE TABLE IF NOT EXISTS staff_schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            staff_id INTEGER NOT NULL,
            location_id INTEGER,
            date DATE NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'jobcan',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(staff_id, date, start_time),
            FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
            FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL
        )
    `);

    // インデックス作成
    await db.run(`CREATE INDEX IF NOT EXISTS idx_users_location ON users(location_id)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_remember_tokens_token ON remember_tokens(token)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_remember_tokens_user_id ON remember_tokens(user_id)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_qr_tokens_token ON qr_tokens(token)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_qr_tokens_user_id ON qr_tokens(user_id)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_feedbacks_location ON feedbacks(location_id)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_staff_schedules_date ON staff_schedules(date)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_staff_schedules_staff ON staff_schedules(staff_id)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_staff_schedules_location ON staff_schedules(location_id)`);

    await migrateMainTables(db);
}

// メインデータベースに後から追加した列。
// 拠点データベース側と同じ理由で、PRAGMA で調べてから ALTER TABLE する。
const mainColumnMigrations = [
    // ジョブカンの店舗（グループ）ID。どの拠点がジョブカンのどの店舗かを結びつける。
    { table: 'locations', column: 'jobcan_group_id', definition: 'TEXT' }
];

async function migrateMainTables(db) {
    for (const { table, column, definition } of mainColumnMigrations) {
        const columns = await db.all(`PRAGMA table_info(${table})`);

        if (columns.some(info => info.name === column)) {
            continue;
        }

        await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`列を追加しました: ${table}.${column}`);
    }
}

// 拠点データベースのテーブル作成SQL
const locationTablesSql = [
    // 商品マスターテーブル
    `CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT,
        reorder_point INTEGER DEFAULT 0,
        current_stock INTEGER DEFAULT 0,
        unit_price REAL NOT NULL DEFAULT 0,
        image_url TEXT,
        include_in_count INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 在庫履歴テーブル
    `CREATE TABLE IF NOT EXISTS inventory_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('in', 'out', 'adjust')),
        quantity INTEGER NOT NULL,
        date DATE,
        note TEXT,
        user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id)
    )`,

    // 週次入力記録テーブル
    `CREATE TABLE IF NOT EXISTS weekly_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_start DATE NOT NULL,
        week_end DATE NOT NULL,
        user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 発注依頼テーブル
    `CREATE TABLE IF NOT EXISTS order_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        requested_quantity INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'ordered', 'received', 'cancelled')),
        user_id INTEGER NOT NULL,
        requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        note TEXT,
        FOREIGN KEY (product_id) REFERENCES products(id)
    )`,

    // シフトの区切りテーブル
    //
    // 「朝・昼・晩」のように 1 日を区切り、区切りごとに在庫の登録を確認する。
    // end_time を過ぎても確認がないと、未確認として LINE に通知する。
    `CREATE TABLE IF NOT EXISTS shifts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        end_time TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        active_days TEXT NOT NULL DEFAULT '1111111',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // シフトの確認記録テーブル
    //
    // status は確認したときの中身。
    //   registered = このシフトで在庫の登録があった
    //   no_change  = 「在庫の変化なし」を押した
    // 登録が 0 件だったとき、「何も動かなかった」のか「登録を忘れた」のかは
    // 記録がないと区別できない。この行があることが「確かに見た」の証拠になる。
    `CREATE TABLE IF NOT EXISTS shift_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shift_id INTEGER NOT NULL,
        report_date DATE NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('registered', 'no_change')),
        movement_count INTEGER NOT NULL DEFAULT 0,
        user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(shift_id, report_date),
        FOREIGN KEY (shift_id) REFERENCES shifts(id)
    )`,

    // 未確認通知の送信記録テーブル。
    // 同じ区切りについて何度も通知しないための記録。
    `CREATE TABLE IF NOT EXISTS shift_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shift_id INTEGER NOT NULL,
        report_date DATE NOT NULL,
        notified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(shift_id, report_date),
        FOREIGN KEY (shift_id) REFERENCES shifts(id)
    )`,

    // 棚卸テーブル
    `CREATE TABLE IF NOT EXISTS inventory_counts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        count_date DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'completed', 'approved')),
        user_id INTEGER NOT NULL,
        approved_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        approved_at DATETIME
    )`,

    // 棚卸明細テーブル
    `CREATE TABLE IF NOT EXISTS inventory_count_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        count_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        system_quantity INTEGER NOT NULL,
        actual_quantity INTEGER,
        difference INTEGER,
        reason TEXT,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (count_id) REFERENCES inventory_counts(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
    )`
];

// テーブルを作成する関数
async function createLocationTables(db) {
    for (const sql of locationTablesSql) {
        await db.run(sql);
    }
}

// 運用開始後に追加した列。
//
// CREATE TABLE IF NOT EXISTS は既にあるテーブルには何もしないので、
// 稼働中のデータベースには列が増えない。SQLite には「なければ追加」の構文が
// ないため、PRAGMA で現在の列を調べてから ALTER TABLE する。
const locationColumnMigrations = [
    // 棚卸の対象にするかどうか。商品登録画面のチェックボックスに対応する。
    { table: 'products', column: 'include_in_count', definition: 'INTEGER NOT NULL DEFAULT 1' },
    // 仕入れ単価。商品一覧の「単価」列に表示する。
    { table: 'products', column: 'unit_price', definition: 'REAL NOT NULL DEFAULT 0' }
];

async function migrateLocationTables(db) {
    for (const { table, column, definition } of locationColumnMigrations) {
        const columns = await db.all(`PRAGMA table_info(${table})`);

        if (columns.some(info => info.name === column)) {
            continue;
        }

        await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`列を追加しました: ${table}.${column}`);
    }

    await seedDefaultShifts(db);
}

// シフトの区切りの初期値。
// 在庫表の CSV が「朝・昼・晩」の 3 列なので、名前はそれに合わせている。
// 時刻は各区切りの「終わり」で、ここを過ぎると未確認の通知が飛ぶ。
// 拠点ごとにダッシュボードの「区切りを変更」から変えられる。
const DEFAULT_SHIFTS = [
    { name: '朝', end_time: '14:00', sort_order: 1 },
    { name: '昼', end_time: '19:00', sort_order: 2 },
    { name: '晩', end_time: '22:00', sort_order: 3 }
];

/**
 * シフトが 1 つも登録されていない拠点に既定の区切りを入れる。
 *
 * 意図的に全部消した拠点へ勝手に戻さないよう、0 件のときだけ入れる。
 */
async function seedDefaultShifts(db) {
    const existing = await db.get('SELECT COUNT(*) as count FROM shifts');

    if (existing && existing.count > 0) {
        return;
    }

    for (const shift of DEFAULT_SHIFTS) {
        await db.run(
            'INSERT INTO shifts (name, end_time, sort_order) VALUES (?, ?, ?)',
            [shift.name, shift.end_time, shift.sort_order]
        );
    }

    console.log('既定のシフト区切り（朝・昼・晩）を登録しました');
}

// 拠点のデータベースを取得または作成
function getLocationDatabase(locationCode) {
    if (dbConnections.has(locationCode)) {
        return dbConnections.get(locationCode);
    }

    // 拠点コードをサニタイズしてファイル名に使用
    const sanitizedCode = locationCode.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dbPath = path.join(DB_DIR, `location_${sanitizedCode}.db`);

    const db = addPromiseMethods(new sqlite3.Database(dbPath));

    // テーブル作成とマイグレーションが終わるまで、この接続へのクエリを待たせる
    gateUntilReady(db, raw =>
        createLocationTables(raw)
            .then(() => migrateLocationTables(raw))
            .catch(err => {
                console.error(`Error preparing tables for location ${locationCode}:`, err);
            })
    );

    dbConnections.set(locationCode, db);
    return db;
}

// データベース接続を閉じる
function closeLocationDatabase(locationCode) {
    if (dbConnections.has(locationCode)) {
        const db = dbConnections.get(locationCode);
        db.close();
        dbConnections.delete(locationCode);
    }
}

// すべての接続を閉じる
function closeAllDatabases() {
    mainDb.close();
    for (const [locationCode, db] of dbConnections) {
        db.close();
    }
    dbConnections.clear();
}

// 初期化。テーブルができるまで、この接続へのクエリを待たせる。
gateUntilReady(mainDb, raw =>
    initMainDatabase(raw).catch(err => {
        console.error('Error creating main database tables:', err);
    })
);

module.exports = {
    mainDb,
    getLocationDatabase,
    closeLocationDatabase,
    closeAllDatabases
};
