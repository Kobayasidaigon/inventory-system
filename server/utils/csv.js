// CSV の組み立て。在庫・履歴・発注依頼の出力で共通に使う。

/**
 * 行の配列を CSV 文字列にする。
 *
 * 商品名に「,」や「"」が入っていても列がずれないようにエスケープする。
 * Excel で開いたときに文字化けしないよう BOM を付ける。
 *
 * @param {string[]} headers - 見出し行
 * @param {Array<Array<*>>} rows - 各行の値（headers と同じ順序）
 */
function toCsv(headers, rows) {
    const escape = (value) => {
        const text = value === null || value === undefined ? '' : String(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [headers.map(escape).join(',')];
    for (const row of rows) {
        lines.push(row.map(escape).join(','));
    }

    return '﻿' + lines.join('\n');
}

module.exports = { toCsv };
