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

/**
 * ダウンロードさせるときの Content-Disposition を作る。
 *
 * 日本語のファイル名は filename*（RFC 5987）で渡す。encodeURIComponent は
 * ' ( ) * をそのまま残すが、filename* では使えない文字なので、それも % にする
 * （商品名に「(Ｍサイズ)」のような括弧はよくある）。filename* を読めない古い
 * ブラウザ向けに、英字の名前も添える。
 *
 * @param {string} fileName - 付けたいファイル名（日本語可）
 * @param {string} asciiFallback - 英数字だけのファイル名
 */
function attachmentHeader(fileName, asciiFallback) {
    const encoded = encodeURIComponent(fileName)
        .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

module.exports = { toCsv, attachmentHeader };
