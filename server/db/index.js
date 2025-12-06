// 環境に応じてデータベース接続を切り替える
const useAzureSQL = process.env.USE_AZURE_SQL === 'true';

if (useAzureSQL) {
    console.log('Using Azure SQL Database');
    module.exports = require('./database-azure');
} else {
    console.log('Using SQLite Database');
    module.exports = require('./database');
}
