// 環境に応じてデータベース初期化を切り替える
const useAzureSQL = process.env.USE_AZURE_SQL === 'true';

if (useAzureSQL) {
    module.exports = require('./init-azure');
} else {
    module.exports = require('./init');
}
