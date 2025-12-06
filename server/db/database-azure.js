const sql = require('mssql');

// Azure SQL Database接続設定
const config = {
    server: process.env.AZURE_SQL_SERVER, // 例: your-server.database.windows.net
    database: process.env.AZURE_SQL_DATABASE,
    user: process.env.AZURE_SQL_USER,
    password: process.env.AZURE_SQL_PASSWORD,
    port: 1433,
    options: {
        encrypt: true, // Azure接続には必須
        trustServerCertificate: false,
        enableArithAbort: true,
        connectionTimeout: 30000,
        requestTimeout: 30000
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

// グローバルな接続プールを作成
let poolPromise;

const getPool = () => {
    if (!poolPromise) {
        poolPromise = new sql.ConnectionPool(config)
            .connect()
            .then(pool => {
                console.log('Azure SQL Database に接続しました');
                return pool;
            })
            .catch(err => {
                console.error('Azure SQL Database 接続エラー:', err);
                poolPromise = null; // エラー時はリセット
                throw err;
            });
    }
    return poolPromise;
};

// SQLite風のインターフェースを提供するヘルパー関数
const db = {
    // SELECT文（単一行）
    get: async (query, params = []) => {
        try {
            const pool = await getPool();
            const request = pool.request();

            // パラメータをバインド
            params.forEach((param, index) => {
                request.input(`param${index}`, param);
            });

            // SQLクエリのパラメータを?から@param0形式に変換
            let azureQuery = query;
            params.forEach((_, index) => {
                azureQuery = azureQuery.replace('?', `@param${index}`);
            });

            const result = await request.query(azureQuery);
            return result.recordset[0] || null;
        } catch (err) {
            console.error('Database query error:', err);
            throw err;
        }
    },

    // SELECT文（複数行）
    all: async (query, params = []) => {
        try {
            const pool = await getPool();
            const request = pool.request();

            // パラメータをバインド
            params.forEach((param, index) => {
                request.input(`param${index}`, param);
            });

            // SQLクエリのパラメータを?から@param0形式に変換
            let azureQuery = query;
            params.forEach((_, index) => {
                azureQuery = azureQuery.replace('?', `@param${index}`);
            });

            const result = await request.query(azureQuery);
            return result.recordset;
        } catch (err) {
            console.error('Database query error:', err);
            throw err;
        }
    },

    // INSERT/UPDATE/DELETE文
    run: async (query, params = []) => {
        try {
            const pool = await getPool();
            const request = pool.request();

            // パラメータをバインド
            params.forEach((param, index) => {
                request.input(`param${index}`, param);
            });

            // SQLクエリのパラメータを?から@param0形式に変換
            let azureQuery = query;
            params.forEach((_, index) => {
                azureQuery = azureQuery.replace('?', `@param${index}`);
            });

            const result = await request.query(azureQuery);

            return {
                lastID: result.recordset && result.recordset[0] ? result.recordset[0].id : null,
                changes: result.rowsAffected[0]
            };
        } catch (err) {
            console.error('Database query error:', err);
            throw err;
        }
    },

    // トランザクション開始
    beginTransaction: async () => {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        return transaction;
    },

    // 接続を閉じる
    close: async () => {
        if (poolPromise) {
            const pool = await poolPromise;
            await pool.close();
            poolPromise = null;
        }
    }
};

// プロセス終了時に接続を閉じる
process.on('SIGINT', async () => {
    await db.close();
    process.exit(0);
});

module.exports = db;
module.exports.sql = sql; // 直接SQLを使いたい場合用
