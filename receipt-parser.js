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
 * - Cash payments (BAR TOTAL, BAR IN LADE, Barumsatz, etc.)
 * - Card payments (EC Karte TOTAL, EC Karte IN LADE, Kartenzahlung, etc.)
 * - Taxes (BRUTTO STEUER, MwSt 19%, MwSt 7%)
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
            clean = clean.replace(/\./g, '').replace(',', '.');
        } else if (clean.includes(',')) {
            clean = clean.replace(',', '.');
        }
        const val = parseFloat(clean);
        return isNaN(val) ? 0 : Math.round(val * 100) / 100;
    }

    function extractAmountFromLine(line) {
        if (!line) return 0;
        // Normalize OCR spaces around comma or dot (e.g. "478 , 97" -> "478,97")
        const norm = line.replace(/(\d+)\s*([,\.])\s*(\d{2})\b/g, '$1$2$3');
        const matches = [...norm.matchAll(/(-?\d{1,3}(?:\.\d{3})+,\d{2}|-?\d+,\d{2}|-?\d{1,3}(?:,\d{3})+\.\d{2}|-?\d+\.\d{2})/g)];
        if (matches.length > 0) {
            return parseGermanAmount(matches[matches.length - 1][1]);
        }
        return 0;
    }

    function normalizeReceiptLine(line) {
        if (!line) return '';
        let l = line.toLowerCase().replace(/\s+/g, ' ').trim();
        // Collapse common OCR letter-spacing
        l = l.replace(/\bb\s+a\s+r\b/g, 'bar');
        l = l.replace(/\bt\s+o\s+t\s+a\s+l\b/g, 'total');
        l = l.replace(/\bl\s+a\s+d\s+e\b/g, 'lade');
        l = l.replace(/\bg\s+e\s+s\s+a\s+m\s+t\b/g, 'gesamt');
        l = l.replace(/\bu\s+m\s+s\s+a\s+t\s+z\b/g, 'umsatz');
        l = l.replace(/\bs\s+t\s+e\s+u\s+e\s+r\b/g, 'steuer');
        l = l.replace(/\bk\s+a\s+r\s+t\s+e\b/g, 'karte');
        return l;
    }

    function parseGermanReceiptText(text) {
        if (!text) text = '';
        const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);
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
            tax: 0,
            tax19: 0,
            tax7: 0,
            receiptNumber: null,
            transactionCount: null,
            sumCheck: 'UNKNOWN',
            warnings: [],
            confidence: 0,
            rawText: text
        };

        const textLower = text.toLowerCase();

        // 1. STORE RECOGNITION (Exact Match for the User's 3 Branches)
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

        for (const line of rawLines) {
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

        // Helper: finds amount on current line or lookahead on next 1-2 lines
        function findAmountForIndex(idx) {
            const currentAmt = extractAmountFromLine(rawLines[idx]);
            if (currentAmt > 0) return currentAmt;
            if (idx + 1 < rawLines.length) {
                const nextAmt = extractAmountFromLine(rawLines[idx + 1]);
                if (nextAmt > 0) return nextAmt;
            }
            if (idx + 2 < rawLines.length) {
                const linePlus1 = rawLines[idx + 1].toLowerCase();
                if (linePlus1.length <= 4 || /^[^0-9a-z]+$/i.test(linePlus1)) {
                    const nextNextAmt = extractAmountFromLine(rawLines[idx + 2]);
                    if (nextNextAmt > 0) return nextNextAmt;
                }
            }
            return 0;
        }

        // 3. AMOUNTS & KEY VALUES
        let barTotalCandidate = 0;
        let barInLadeCandidate = 0;
        let ecTotalCandidate = 0;
        let ecInLadeCandidate = 0;
        let gesamtCandidate = 0;

        for (let i = 0; i < rawLines.length; i++) {
            const line = rawLines[i];
            const lineLow = normalizeReceiptLine(line);

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

            // TAX / STEUER (Must NEVER be confused with Gesamtumsatz!)
            const isTaxLine = lineLow.includes('steuer') || lineLow.includes('mwst') || lineLow.includes('ust') || lineLow.includes('tax');
            if (isTaxLine) {
                const amt = findAmountForIndex(i);
                if (amt > 0) {
                    if (lineLow.includes('19%') || lineLow.includes('19,00%')) result.tax19 = amt;
                    else if (lineLow.includes('7%') || lineLow.includes('7,00%')) result.tax7 = amt;
                    else if (!result.tax) result.tax = amt;
                }
                continue; // CRITICAL: Never evaluate tax lines as revenue or payment methods!
            }

            // CASH / BAR
            const isUnbar = lineLow.includes('unbar');
            if (!isUnbar) {
                if (lineLow.includes('bar total') || lineLow.includes('bar-total') || lineLow.includes('bartotal')) {
                    const amt = findAmountForIndex(i);
                    if (amt > 0) barTotalCandidate = amt;
                } else if (lineLow.includes('bar in lade') || lineLow.includes('bar-in-lade') || lineLow.includes('bar in der lade')) {
                    const amt = findAmountForIndex(i);
                    if (amt > 0) barInLadeCandidate = amt;
                } else if (
                    lineLow.includes('barumsatz') ||
                    lineLow.includes('bar-umsatz') ||
                    lineLow.includes('bargeld') ||
                    lineLow.includes('barzahlung') ||
                    lineLow.includes('kasse bar') ||
                    lineLow.includes('bar brutto') ||
                    lineLow.includes('summe bar') ||
                    /\bbar\b/i.test(lineLow)
                ) {
                    const amt = findAmountForIndex(i);
                    if (amt > 0 && !result.cash) result.cash = amt;
                }
            }

            // CARD / EC
            if (lineLow.includes('ec karte total') || lineLow.includes('ec-karte total') || lineLow.includes('ec total') || lineLow.includes('ec-total')) {
                const amt = findAmountForIndex(i);
                if (amt > 0) ecTotalCandidate = amt;
            } else if (lineLow.includes('ec karte in lade') || lineLow.includes('ec-karte in lade') || lineLow.includes('ec in lade') || lineLow.includes('ec-in-lade')) {
                const amt = findAmountForIndex(i);
                if (amt > 0) ecInLadeCandidate = amt;
            } else if (
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
                lineLow.includes('summe karte') ||
                lineLow.startsWith('karte') ||
                lineLow.includes('karte:')
            ) {
                const amt = findAmountForIndex(i);
                if (amt > 0 && !result.card) result.card = amt;
            }

            // TOTAL REVENUE / GESAMTUMSATZ
            // Strictly exclude tax, net, discount, cash, card
            const isNotTotal = isTaxLine || lineLow.includes('netto') || lineLow.includes('rabatt') || lineLow.includes('trinkgeld') ||
                lineLow.includes('gutschein') || /\bbar\b/i.test(lineLow) || lineLow.includes('karte') || lineLow.includes('unbar') || lineLow.includes('ec');

            if (!isNotTotal) {
                if (lineLow.includes('gesamtumsatz') || lineLow.includes('gesamt-umsatz') || lineLow.includes('gesamt umsatz')) {
                    const amt = findAmountForIndex(i);
                    if (amt > 0) gesamtCandidate = amt;
                } else if (
                    lineLow.includes('tagesumsatz') ||
                    lineLow.includes('tages-umsatz') ||
                    lineLow.includes('umsatz gesamt') ||
                    lineLow.includes('tages-gesamt') ||
                    lineLow.includes('tages-total') ||
                    lineLow.includes('endsumme') ||
                    lineLow.includes('bruttoumsatz') ||
                    lineLow.includes('brutto-umsatz') ||
                    lineLow.includes('summe eur') ||
                    lineLow.includes('summe brutto') ||
                    lineLow.startsWith('total') ||
                    lineLow.startsWith('gesamt') ||
                    lineLow.startsWith('summe')
                ) {
                    const amt = findAmountForIndex(i);
                    if (amt > 0 && !result.total) result.total = amt;
                }
            }
        }

        // Resolve priority candidates (BAR TOTAL, BAR IN LADE, EC Karte TOTAL, EC Karte IN LADE)
        if (barTotalCandidate > 0) result.cash = barTotalCandidate;
        else if (barInLadeCandidate > 0 && !result.cash) result.cash = barInLadeCandidate;

        if (ecTotalCandidate > 0) result.card = ecTotalCandidate;
        else if (ecInLadeCandidate > 0 && !result.card) result.card = ecInLadeCandidate;

        if (gesamtCandidate > 0) result.total = gesamtCandidate;

        // 4. MATHEMATICAL VERIFICATION & CALCULATION (Section 2 of User Request)
        const sumPay = Math.round((result.cash + result.card + result.other) * 100) / 100;

        if (result.total > 0 && sumPay > 0) {
            if (Math.abs(sumPay - result.total) <= 0.05) {
                result.sumCheck = 'MATCH';
            } else {
                result.sumCheck = 'MISMATCH';
                result.warnings.push(`Summenabweichung: Bar (${result.cash.toFixed(2)} €) + Karte (${result.card.toFixed(2)} €) = ${sumPay.toFixed(2)} €, aber Gesamtumsatz ist ${result.total.toFixed(2)} €.`);
            }
        } else if (result.total === 0 && result.cash > 0 && result.card > 0) {
            // Automatic calculation when cash and card are distinctly recognized
            result.total = sumPay;
            result.sumCheck = 'MATCH';
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
