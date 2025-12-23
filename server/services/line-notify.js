const line = require('@line/bot-sdk');

// LINE Messaging API クライアントの設定
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};

let client = null;

// クライアントの初期化
function initLineClient() {
    if (!config.channelAccessToken || !config.channelSecret) {
        console.warn('LINE Messaging API の設定がありません。LINE通知は無効です。');
        return false;
    }

    try {
        client = new line.messagingApi.MessagingApiClient(config);
        console.log('LINE Messaging API クライアントを初期化しました');
        return true;
    } catch (error) {
        console.error('LINE クライアントの初期化エラー:', error);
        return false;
    }
}

// 初期化
initLineClient();

/**
 * グループに発注通知メッセージを送信
 * @param {string} groupId - LINEグループID
 * @param {object} orderInfo - 発注情報
 * @returns {Promise<boolean>} 送信成功/失敗
 */
async function sendOrderNotification(groupId, orderInfo) {
    if (!client) {
        console.log('LINE クライアントが初期化されていません');
        return false;
    }

    if (!groupId) {
        console.log('グループIDが設定されていません');
        return false;
    }

    try {
        const message = {
            type: 'text',
            text: `📦 発注依頼通知\n\n` +
                  `店舗: ${orderInfo.locationName}\n` +
                  `商品: ${orderInfo.productName}\n` +
                  `現在庫: ${orderInfo.currentStock}\n` +
                  `発注点: ${orderInfo.reorderPoint}\n\n` +
                  `⚠️ 在庫が発注点を下回りました。`
        };

        await client.pushMessage({
            to: groupId,
            messages: [message]
        });

        console.log(`LINE通知を送信しました: ${orderInfo.locationName} - ${orderInfo.productName}`);
        return true;
    } catch (error) {
        console.error('LINE通知の送信エラー:', error);
        return false;
    }
}

module.exports = {
    sendOrderNotification,
    isEnabled: () => !!client
};
