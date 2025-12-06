const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// データベースディレクトリのパス（環境変数または既定値）
const DB_DIR = process.env.DB_DIR || path.join(__dirname);

// データベースディレクトリが存在しない場合は作成
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

// ユーザーごとのデータベース接続を管理
const dbConnections = new Map();

// テーブル作成SQL
const createTablesSql = [
    // ユーザーテーブル（メインDBのみ）
    `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        db_name TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

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
    )`
];

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

// テーブルを作成する関数
async function createTables(db, includeUsersTable = false) {
    const tables = includeUsersTable ? createTablesSql : createTablesSql.slice(1);

    for (const sql of tables) {
        await db.run(sql);
    }
}

// メインデータベース（ユーザー管理用）
const mainDbPath = path.join(DB_DIR, 'users.db');
const mainDb = addPromiseMethods(new sqlite3.Database(mainDbPath));

// メインDBのテーブル作成
createTables(mainDb, true).catch(err => {
    console.error('Error creating main database tables:', err);
});

// ユーザーのデータベースを取得または作成
function getUserDatabase(username) {
    if (dbConnections.has(username)) {
        return dbConnections.get(username);
    }

    // ユーザー名をサニタイズしてファイル名に使用
    const sanitizedUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dbPath = path.join(DB_DIR, `inventory_${sanitizedUsername}.db`);

    const db = addPromiseMethods(new sqlite3.Database(dbPath));

    // テーブル作成
    createTables(db, false).catch(err => {
        console.error(`Error creating tables for user ${username}:`, err);
    });

    dbConnections.set(username, db);
    return db;
}

// データベース接続を閉じる
function closeUserDatabase(username) {
    if (dbConnections.has(username)) {
        const db = dbConnections.get(username);
        db.close();
        dbConnections.delete(username);
    }
}

// すべての接続を閉じる
function closeAllDatabases() {
    mainDb.close();
    for (const [username, db] of dbConnections) {
        db.close();
    }
    dbConnections.clear();
}

module.exports = {
    mainDb,
    getUserDatabase,
    closeUserDatabase,
    closeAllDatabases
};
