/**
 * German POS Z-Report (Tagesabschluss) Parser Engine
 * Universally compatible: Works in Node.js backend AND browser frontend.
 * 
 * Recognizes and extracts:
 * - 3 Specific Stores:
 *     1. Volkradstraße (Lichtenberg) -> store_1788358842956_bolf
 *     2. Bruno-Taut-Straße (Grünau) -> store_1788358914508_zv8v
 *     3. Cottbuser Straße (Königs Wusterhausen) -> store_1788358943648_q74l
 * - Date of daily closing (DD.MM.YYYY, YYYY-MM-DD, etc.)
 * - Total revenue (Gesamtumsatz)
 * - Cash payments (Barumsatz)
 * - Card payments (Kartenzahlung, EC, Girocard, Kreditkarte)
 * - Taxes (MwSt 19%, MwSt 7%)
 * - Receipt number (Z-Nr, Beleg-Nr)
 * - Transaction / Customer count
 * - Mathematical cross-checks (Cash + Card == Total)
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ReceiptParser = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    function parseGermanAmount(str) {
        if (!str) return 0;
        let clean = str.replace(/[^\d,\.\-]/g, '').trim();
        if (clean.includes(',') && clean.includes('.')) {
            // e.g. "1.381,86" -> 1381.86
            clean = clean.replace(/\./g, '').replace(',', '.');
        } else if (clean.includes(',')) {
            // e.g. "1381,86" -> 1381.86
            clean = clean.replace(',', '.');
        }
        const val = parseFloat(clean);
        return isNaN(val) ? 0 : Math.round(val * 100) / 100;
    }

    function extractAmountFromLine(line) {
        // Matches German amounts like 1.381,86 or 1381,86 or 396,96 or 40.00
        const matches = [...line.matchAll(/(-?\d{1,3}(?:\.\d{3})+,\d{2}|-?\d+,\d{2}|-?\d{1,3}(?:,\d{3})+\.\d{2}|-?\d+\.\d{2})/g)];
        if (matches.length > 0) {
            return parseGermanAmount(matches[matches.length - 1][1]);
        }
        return 0;
    }

    function parseGermanReceiptText(text) {
        if (!text) text = '';
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const result = {
            storeId: null,
            storeName: null,
            storeConfidence: 0,
            date: null,
            dateConfidence: 0,
            total: 0,
            cash: 0,
            card: 0,
            other: 0,
            tax19: 0,
            tax7: 0,
            receiptNumber: null,
            transactionCount: null,
            sumCheck: 'UNKNOWN',
            warnings: [],
            confidence: 0,
            rawText: text
        };

        // 1. STORE RECOGNITION (Exact Match for the User's 3 Branches)
        const textLower = text.toLowerCase();

        let scoreLichtenberg = 0;
        if (textLower.includes('volkrad')) scoreLichtenberg += 50;
        if (textLower.includes('lichtenberg')) scoreLichtenberg += 30;
        if (textLower.includes('10319')) scoreLichtenberg += 40;

        let scoreGwenau = 0;
        if (textLower.includes('bruno-taut') || textLower.includes('bruno taut') || textLower.includes('brunotaut')) scoreGwenau += 50;
        if (textLower.includes('grünau') || textLower.includes('gruenau')) scoreGwenau += 30;
        if (textLower.includes('12524')) scoreGwenau += 40;

        let scoreKW = 0;
        if (textLower.includes('cottbuser') || textLower.includes('cottbus')) scoreKW += 50;
        if (textLower.includes('königs wusterhausen') || textLower.includes('koenigs wusterhausen') || textLower.includes('wusterhausen')) scoreKW += 30;
        if (textLower.includes('15711')) scoreKW += 40;

        if (scoreLichtenberg > scoreGwenau && scoreLichtenberg > scoreKW && scoreLichtenberg >= 40) {
            result.storeId = 'store_1788358842956_bolf';
            result.storeName = 'Volkradstraße (Lichtenberg)';
            result.storeConfidence = Math.min(scoreLichtenberg, 100);
        } else if (scoreGwenau > scoreLichtenberg && scoreGwenau > scoreKW && scoreGwenau >= 40) {
            result.storeId = 'store_1788358914508_zv8v';
            result.storeName = 'Bruno-Taut-Straße (Grünau)';
            result.storeConfidence = Math.min(scoreGwenau, 100);
        } else if (scoreKW > scoreLichtenberg && scoreKW > scoreGwenau && scoreKW >= 40) {
            result.storeId = 'store_1788358943648_q74l';
            result.storeName = 'Cottbuser Straße (Königs Wusterhausen)';
            result.storeConfidence = Math.min(scoreKW, 100);
        } else {
            result.warnings.push('Filiale konnte anhand der Adresse nicht eindeutig erkannt werden. Bitte manuell auswählen.');
        }

        // 2. DATE RECOGNITION
        const dateRegexes = [
            /(?:datum|abschluss|vom|am|date)?\s*[:\s]*([0-3]?\d)[\.\/\-]([0-1]?\d)[\.\/\-](20\d{2}|\d{2})\b/i,
            /\b(20\d{2})[\.\/\-]([0-1]\d)[\.\/\-]([0-3]\d)\b/
        ];

        for (const line of lines) {
            const m1 = line.match(dateRegexes[0]);
            if (m1) {
                let day = m1[1].padStart(2, '0');
                let month = m1[2].padStart(2, '0');
                let year = m1[3];
                if (year.length === 2) year = '20' + year;
                result.date = `${year}-${month}-${day}`;
                result.dateConfidence = 95;
                break;
            }
            const m2 = line.match(dateRegexes[1]);
            if (m2) {
                result.date = `${m2[1]}-${m2[2]}-${m2[3]}`;
                result.dateConfidence = 95;
                break;
            }
        }

        if (!result.date) {
            result.warnings.push('Datum des Tagesabschlusses nicht eindeutig gefunden. Bitte überprüfen.');
        }

        // 3. AMOUNTS & KEY VALUES
        for (const line of lines) {
            const lineLow = line.toLowerCase();

            // RECEIPT NUMBER
            if (!result.receiptNumber && (lineLow.includes('z-nr') || lineLow.includes('z-bericht') || lineLow.includes('z-zähler') || lineLow.includes('beleg-nr') || lineLow.includes('abschluss-nr') || lineLow.includes('z1-nr') || lineLow.includes('bon-nr'))) {
                const numMatch = line.match(/(?:nr\.?|zähler)\s*[:\s]*([a-z0-9\-_]+)/i);
                if (numMatch) result.receiptNumber = numMatch[1];
            }

            // TRANSACTION COUNT
            if (!result.transactionCount && (lineLow.includes('kunden') || lineLow.includes('bons') || lineLow.includes('belege') || lineLow.includes('transaktionen') || lineLow.includes('anzahl'))) {
                const cntMatch = line.match(/(?:kunden|bons|belege|transaktionen|anzahl)\s*[:\s]*(\d+)/i);
                if (cntMatch) result.transactionCount = parseInt(cntMatch[1]);
            }

            // TOTAL REVENUE
            if (!result.total && (
                lineLow.includes('gesamtumsatz') ||
                lineLow.includes('tagesumsatz') ||
                lineLow.includes('umsatz gesamt') ||
                lineLow.includes('tages-gesamt') ||
                lineLow.includes('endsumme') ||
                lineLow.includes('bruttoumsatz') ||
                lineLow.includes('brutto-umsatz') ||
                lineLow.startsWith('total') ||
                lineLow.startsWith('gesamt') ||
                lineLow.startsWith('summe')
            )) {
                const amt = extractAmountFromLine(line);
                if (amt > 0) result.total = amt;
            }

            // CASH REVENUE
            if (!result.cash && (
                lineLow.includes('barumsatz') ||
                lineLow.includes('bar-umsatz') ||
                lineLow.includes('bargeld') ||
                lineLow.includes('barzahlung') ||
                lineLow.includes('kasse bar') ||
                lineLow.includes('bar brutto') ||
                lineLow.startsWith('bar') ||
                lineLow.includes('bar:')
            )) {
                const amt = extractAmountFromLine(line);
                if (amt > 0) result.cash = amt;
            }

            // CARD REVENUE
            if (!result.card && (
                lineLow.includes('kartenzahlung') ||
                lineLow.includes('kartenzahlungen') ||
                lineLow.includes('ec-karte') ||
                lineLow.includes('ec karte') ||
                lineLow.includes('electronic cash') ||
                lineLow.includes('girocard') ||
                lineLow.includes('kreditkarte') ||
                lineLow.includes('unbar') ||
                lineLow.includes('mastercard') ||
                lineLow.includes('visa') ||
                lineLow.includes('zvt') ||
                lineLow.includes('eft') ||
                lineLow.startsWith('karte') ||
                lineLow.includes('karte:')
            )) {
                const amt = extractAmountFromLine(line);
                if (amt > 0) result.card = amt;
            }

            // TAX AMOUNTS
            if (!result.tax19 && (lineLow.includes('19%') || lineLow.includes('19,00%') || lineLow.includes('19.00%'))) {
                const parts = line.split(/19(?:,00|\.00)?%/);
                if (parts.length > 1) {
                    const amt = extractAmountFromLine(parts[1]);
                    if (amt > 0) result.tax19 = amt;
                }
            }
            if (!result.tax7 && (lineLow.includes('7%') || lineLow.includes('7,00%') || lineLow.includes('7.00%'))) {
                const parts = line.split(/7(?:,00|\.00)?%/);
                if (parts.length > 1) {
                    const amt = extractAmountFromLine(parts[1]);
                    if (amt > 0) result.tax7 = amt;
                }
            }
        }

        // 4. MATHEMATICAL VERIFICATION & CROSS-CHECKS
        const sumPay = Math.round((result.cash + result.card + result.other) * 100) / 100;
        
        if (result.total > 0 && sumPay > 0) {
            if (Math.abs(sumPay - result.total) <= 0.05) {
                result.sumCheck = 'MATCH';
            } else {
                result.sumCheck = 'MISMATCH';
                result.warnings.push(`Summenabweichung: Bar (${result.cash.toFixed(2)} €) + Karte (${result.card.toFixed(2)} €) = ${sumPay.toFixed(2)} €, aber Gesamtumsatz ist ${result.total.toFixed(2)} €.`);
            }
        } else if (result.total > 0 && result.card > 0 && result.cash === 0) {
            result.sumCheck = 'PARTIAL';
        } else if (result.total > 0 && result.cash > 0 && result.card === 0) {
            result.sumCheck = 'PARTIAL';
        } else {
            result.sumCheck = 'INCOMPLETE';
            if (result.total === 0) result.warnings.push('Gesamtumsatz konnte nicht eindeutig ausgelesen werden.');
        }

        // Overall Confidence Score
        let conf = 0;
        if (result.storeId) conf += 35;
        if (result.date) conf += 25;
        if (result.total > 0) conf += 20;
        if (result.sumCheck === 'MATCH') conf += 20;
        else if (result.cash > 0 || result.card > 0) conf += 10;
        result.confidence = conf;

        return result;
    }

    return {
        parseGermanReceiptText,
        parseGermanAmount,
        extractAmountFromLine
    };
}));
