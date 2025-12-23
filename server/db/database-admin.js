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

// メインデータベース（拠点とユーザー管理用）
const mainDbPath = path.join(DB_DIR, 'main.db');
const mainDb = addPromiseMethods(new sqlite3.Database(mainDbPath));

// メインDBのテーブル作成
async function initMainDatabase() {
    // 拠点テーブル
    await mainDb.run(`
        CREATE TABLE IF NOT EXISTS locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location_code TEXT UNIQUE NOT NULL,
            location_name TEXT NOT NULL,
            db_name TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ユーザーテーブル
    await mainDb.run(`
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
    await mainDb.run(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Remember Meトークンテーブル
    await mainDb.run(`
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
    await mainDb.run(`
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
    await mainDb.run(`
        CREATE TABLE IF NOT EXISTS feedbacks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location_id INTEGER,
            feedback_text TEXT NOT NULL,
            status TEXT DEFAULT 'new' CHECK(status IN ('new', 'read', 'resolved')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL
        )
    `);

    // インデックス作成
    await mainDb.run(`CREATE INDEX IF NOT EXISTS idx_users_location ON users(location_id)`);
    await mainDb.run(`CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id)`);
    await mainDb.run(`CREATE INDEX IF NOT EXISTS idx_remember_tokens_token ON remember_tokens(token)`);
    await mainDb.run(`CREATE INDEX IF NOT EXISTS idx_remember_tokens_user_id ON remember_tokens(user_id)`);
    await mainDb.run(`CREATE INDEX IF NOT EXISTS idx_qr_tokens_token ON qr_tokens(token)`);
    await mainDb.run(`CREATE INDEX IF NOT EXISTS idx_qr_tokens_user_id ON qr_tokens(user_id)`);
    await mainDb.run(`CREATE INDEX IF NOT EXISTS idx_feedbacks_location ON feedbacks(location_id)`);
    await mainDb.run(`CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status)`);
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
        image_url TEXT,
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

// 拠点のデータベースを取得または作成
function getLocationDatabase(locationCode) {
    if (dbConnections.has(locationCode)) {
        return dbConnections.get(locationCode);
    }

    // 拠点コードをサニタイズしてファイル名に使用
    const sanitizedCode = locationCode.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dbPath = path.join(DB_DIR, `location_${sanitizedCode}.db`);

    const db = addPromiseMethods(new sqlite3.Database(dbPath));

    // テーブル作成
    createLocationTables(db).catch(err => {
        console.error(`Error creating tables for location ${locationCode}:`, err);
    });

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

// 初期化
initMainDatabase().catch(err => {
    console.error('Error creating main database tables:', err);
});

module.exports = {
    mainDb,
    getLocationDatabase,
    closeLocationDatabase,
    closeAllDatabases
};
