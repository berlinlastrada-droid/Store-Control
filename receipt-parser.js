/**
 * StoreControl Pro - German POS Z-Report (Tagesabschluss) Parser Engine
 * Universally compatible: Works in Node.js backend AND browser frontend.
 * 
 * Recognizes and extracts:
 * - 3 Specific Branches:
 *     1. Volkradstraße 32 (Lichtenberg) -> store_1788358842956_bolf
 *     2. Bruno-Taut-Straße 1 (Grünau) -> store_1788358914508_zv8v
 *     3. Cottbuser Straße 41 (Königs Wusterhausen) -> store_1788358943648_q74l
 * - Date of daily closing (DD.MM.YYYY, DD/MM/YYYY, etc.), prioritizing closing date over previous report date
 * - Total revenue (GESAMTUMSATZ, SCHUBLADEN TOTAL, BRUTTO STEUER)
 * - Cash payments (BAR TOTAL, BAR IN LADE, Barumsatz, etc.)
 * - Card payments (EC Karte TOTAL, EC Karte IN LADE, Kartenzahlung, etc.)
 * - Taxes (STEUER 1, MwSt 19%, MwSt 7%, strictly separated from gross revenue)
 * - Dedicated rule for 100% EC days (no cash revenue reported)
 * - Multi-line lookahead over transaction counts (e.g. GESAMTUMSATZ \n 7 \n €610.94)
 * - Currency symbols (€, £ OCR misread, $, EUR) and comma/dot decimals
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
        // Replace pound sign (£ is often OCR's misread of €) and euro sign
        let cleanLine = line.replace(/[€£$]/g, ' EUR ');
        // Normalize OCR spaces around comma or dot (e.g. "478 . 97" or "478 , 97" -> "478.97")
        cleanLine = cleanLine.replace(/(\d+)\s*([,\.])\s*(\d{2})\b/g, '$1$2$3');
        
        // Match amounts with 2 decimals
        const matches = [...cleanLine.matchAll(/(-?\d{1,3}(?:\.\d{3})+,\d{2}|-?\d+,\d{2}|-?\d{1,3}(?:,\d{3})+\.\d{2}|-?\d+\.\d{2})/g)];
        if (matches.length > 0) {
            return parseGermanAmount(matches[matches.length - 1][1]);
        }
        return 0;
    }

    function normalizeReceiptLine(line) {
        if (!line) return '';
        let l = line.toLowerCase().replace(/[\u2018\u2019\u201A\u201B\u2032\u2035'"]/g, '').replace(/\s+/g, ' ').trim();
        // Collapse common OCR letter-spacing
        l = l.replace(/\bb\s+a\s+r\b/g, 'bar');
        l = l.replace(/\bt\s+o\s+t\s+a\s+l\b/g, 'total');
        l = l.replace(/\bl\s+a\s+d\s+e\b/g, 'lade');
        l = l.replace(/\bg\s+e\s+s\s+a\s+m\s+t\b/g, 'gesamt');
        l = l.replace(/\bu\s+m\s+s\s+a\s+t\s+z\b/g, 'umsatz');
        l = l.replace(/\bs\s+t\s+e\s+u\s+e\s+r\b/g, 'steuer');
        l = l.replace(/\bk\s+a\s+r\s+t\s+e\b/g, 'karte');
        l = l.replace(/\bs\s+c\s+h\s+u\s+b\s+l\s+a\s+d\s+e\s+n\b/g, 'schubladen');
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
            isAllCard: false,
            warnings: [],
            confidence: 0,
            rawText: text
        };

        const textLower = text.toLowerCase();

        // 1. STORE RECOGNITION (Exact Match for the User's 3 Branches)
        let scoreLichtenberg = 0;
        if (textLower.includes('volkrad')) scoreLichtenberg += 50;
        if (textLower.includes('lichtenberg')) scoreLichtenberg += 40;
        if (textLower.includes('10319')) scoreLichtenberg += 40;

        let scoreGwenau = 0;
        if (textLower.includes('bruno') || textLower.includes('taut')) scoreGwenau += 50;
        if (textLower.includes('grünau') || textLower.includes('gruenau')) scoreGwenau += 40;
        if (textLower.includes('12524')) scoreGwenau += 40;
        if (textLower.includes('32/215/00914') || textLower.includes('3221500914') || textLower.includes('de3221500914')) scoreGwenau += 50;

        let scoreKW = 0;
        if (textLower.includes('cottbus') || textLower.includes('cottbuser')) scoreKW += 50;
        if (textLower.includes('königs wusterhausen') || textLower.includes('koenigs wusterhausen') || textLower.includes('wusterhausen')) scoreKW += 40;
        if (textLower.includes('15711')) scoreKW += 40;

        if (scoreLichtenberg > scoreGwenau && scoreLichtenberg > scoreKW && scoreLichtenberg >= 30) {
            result.storeId = 'store_1788358842956_bolf';
            result.storeName = 'Volkradstraße (Lichtenberg)';
            result.storeConfidence = Math.min(scoreLichtenberg, 100);
        } else if (scoreGwenau > scoreLichtenberg && scoreGwenau > scoreKW && scoreGwenau >= 30) {
            result.storeId = 'store_1788358914508_zv8v';
            result.storeName = 'Bruno-Taut-Straße (Grünau)';
            result.storeConfidence = Math.min(scoreGwenau, 100);
        } else if (scoreKW > scoreLichtenberg && scoreKW > scoreGwenau && scoreKW >= 30) {
            result.storeId = 'store_1788358943648_q74l';
            result.storeName = 'Cottbuser Straße (Königs Wusterhausen)';
            result.storeConfidence = Math.min(scoreKW, 100);
        } else {
            result.warnings.push('Filiale konnte anhand der Adresse nicht eindeutig erkannt werden. Bitte manuell auswählen.');
        }

        // 2. DATE RECOGNITION (Prefer closing date over "letzter bericht")
        const dateRegex = /\b([0-3]?\d)[\.\/\-]([0-1]?\d)[\.\/\-](20\d{2}|\d{2})\b/;
        for (const line of rawLines) {
            const lineLow = line.toLowerCase();
            if (lineLow.includes('letzter bericht') || lineLow.includes('vorheriger')) continue;
            const m = line.match(dateRegex);
            if (m) {
                let day = m[1].padStart(2, '0');
                let month = m[2].padStart(2, '0');
                let year = m[3];
                if (year.length === 2) year = '20' + year;
                if (parseInt(year) >= 2020 && parseInt(year) <= 2035) {
                    result.date = `${year}-${month}-${day}`;
                    result.dateConfidence = 95;
                    break;
                }
            }
        }
        if (!result.date) {
            for (const line of rawLines) {
                const m = line.match(dateRegex);
                if (m) {
                    let day = m[1].padStart(2, '0');
                    let month = m[2].padStart(2, '0');
                    let year = m[3].length === 2 ? '20' + m[3] : m[3];
                    result.date = `${year}-${month}-${day}`;
                    result.dateConfidence = 85;
                    break;
                }
            }
        }
        if (!result.date) {
            result.warnings.push('Datum des Tagesabschlusses nicht eindeutig gefunden. Bitte überprüfen.');
        }

        // Helper: lookahead up to 3 lines (skips intermediate transaction counts e.g. "GESAMTUMSATZ \n 7 \n €610.94")
        function findAmountForIndex(idx) {
            for (let offset = 0; offset <= 3; offset++) {
                const curIdx = idx + offset;
                if (curIdx >= rawLines.length) break;
                const amt = extractAmountFromLine(rawLines[curIdx]);
                if (amt > 0) return amt;
            }
            return 0;
        }

        // 3. AMOUNTS & VALUES
        let barTotalCandidate = 0;
        let barInLadeCandidate = 0;
        let ecTotalCandidate = 0;
        let ecInLadeCandidate = 0;
        let gesamtCandidate = 0;
        let schubladenCandidate = 0;
        let bruttoSteuerCandidate = 0;
        let hasExplicitCashLine = false;

        for (let i = 0; i < rawLines.length; i++) {
            const line = rawLines[i];
            const lineLow = normalizeReceiptLine(line);

            // Z-Bericht Nummer
            if (!result.receiptNumber && (lineLow.includes('z 1') || lineLow.includes('z1') || lineLow.includes('z-bericht') || lineLow.includes('z-nr') || lineLow.includes('beleg-nr'))) {
                const numMatch = line.match(/(?:bericht|nr\.?|zähler)\s*[:\s]*([a-z0-9\-_]+)/i);
                if (numMatch) result.receiptNumber = numMatch[1];
            }

            // TAX / STEUER (Strict separation between tax and revenue!)
            const isTaxLine = lineLow.includes('steuer') || lineLow.includes('mwst') || lineLow.includes('ust') || lineLow.includes('tax');
            if (isTaxLine) {
                const amt = findAmountForIndex(i);
                if (amt > 0) {
                    if (lineLow.includes('brutto steuer') || lineLow.includes('brutto-steuer')) {
                        // Gross amount subject to tax rate - this matches gross revenue!
                        bruttoSteuerCandidate = amt;
                    } else if (lineLow.includes('19%') || lineLow.includes('19,00%')) {
                        result.tax19 = amt;
                        result.tax = amt;
                    } else if (lineLow.includes('7%') || lineLow.includes('7,00%')) {
                        result.tax7 = amt;
                        result.tax = amt;
                    } else if (lineLow.includes('steuer 1') || lineLow.includes('steuer1')) {
                        result.tax19 = amt;
                        result.tax = amt;
                    } else if (!result.tax) {
                        result.tax = amt;
                    }
                }
                continue; // Skip tax lines from revenue checks
            }

            // CASH / BAR
            const isUnbar = lineLow.includes('unbar');
            if (!isUnbar) {
                if (lineLow.includes('bar total') || lineLow.includes('bar-total') || lineLow.includes('bartotal')) {
                    hasExplicitCashLine = true;
                    const amt = findAmountForIndex(i);
                    if (amt > 0) barTotalCandidate = amt;
                } else if (lineLow.includes('bar in lade') || lineLow.includes('bar-in-lade') || lineLow.includes('bar in der lade')) {
                    hasExplicitCashLine = true;
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
                    hasExplicitCashLine = true;
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

            // SCHUBLADEN TOTAL (Authoritative POS closing total!)
            if (lineLow.includes('schubladen total') || lineLow.includes('schubladentotal') || lineLow.includes('schubladen-total')) {
                const amt = findAmountForIndex(i);
                if (amt > 0) schubladenCandidate = amt;
            }

            // TOTAL REVENUE / GESAMTUMSATZ
            const isNotTotal = isTaxLine || lineLow.includes('netto') || lineLow.includes('rabatt') || lineLow.includes('trinkgeld') ||
                lineLow.includes('gutschein') || /\bbar\b/i.test(lineLow) || lineLow.includes('karte') || lineLow.includes('unbar') || lineLow.includes('ec');

            if (!isNotTotal) {
                if (lineLow.includes('gesamtumsatz') || lineLow.includes('gesamt-umsatz') || lineLow.includes('gesamt umsatz') || /gesamt.*umsatz/i.test(lineLow) || /gesamtu[hm]satz/i.test(lineLow)) {
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

        // Resolve priority candidates
        if (barTotalCandidate > 0) result.cash = barTotalCandidate;
        else if (barInLadeCandidate > 0 && !result.cash) result.cash = barInLadeCandidate;

        if (ecTotalCandidate > 0) result.card = ecTotalCandidate;
        else if (ecInLadeCandidate > 0 && !result.card) result.card = ecInLadeCandidate;

        if (gesamtCandidate > 0) result.total = gesamtCandidate;
        else if (schubladenCandidate > 0) result.total = schubladenCandidate;
        else if (bruttoSteuerCandidate > 0) result.total = bruttoSteuerCandidate;

        // 4. MATHEMATICAL VERIFICATION & LOGIC FOR 100% EC RECEIPTS (User Point 2)
        const sumPay = Math.round((result.cash + result.card + result.other) * 100) / 100;

        // Case A: Both cash and card are present
        if (result.cash > 0 && result.card > 0) {
            if (result.total > 0) {
                if (Math.abs(sumPay - result.total) <= 0.05) {
                    result.sumCheck = 'MATCH';
                } else {
                    result.sumCheck = 'MISMATCH';
                    result.warnings.push(`Summenabweichung: Bar (${result.cash.toFixed(2)} €) + Karte (${result.card.toFixed(2)} €) = ${sumPay.toFixed(2)} €, aber Gesamtumsatz ist ${result.total.toFixed(2)} €.`);
                }
            } else {
                result.total = sumPay;
                result.sumCheck = 'MATCH';
            }
        }
        // Case B: ONLY card is present, NO cash line on receipt (100% EC revenue day!)
        else if (result.card > 0 && result.cash === 0 && !hasExplicitCashLine) {
            result.isAllCard = true;
            if (result.total === 0 || Math.abs(result.total - result.card) <= 0.05) {
                result.total = result.card;
                result.sumCheck = 'MATCH';
            } else {
                result.sumCheck = 'MISMATCH';
                result.warnings.push(`Prüfen: EC-Umsatz ist ${result.card.toFixed(2)} €, ausgewiesener Gesamtumsatz ist ${result.total.toFixed(2)} €.`);
            }
        }
        // Case C: ONLY cash is present
        else if (result.cash > 0 && result.card === 0) {
            if (result.total === 0 || Math.abs(result.total - result.cash) <= 0.05) {
                result.total = result.cash;
                result.sumCheck = 'MATCH';
            } else {
                result.sumCheck = 'PARTIAL';
            }
        }
        // Case D: General check if total exists
        else if (result.total > 0) {
            if (sumPay > 0 && Math.abs(sumPay - result.total) <= 0.05) {
                result.sumCheck = 'MATCH';
            } else if (sumPay > 0) {
                result.sumCheck = 'MISMATCH';
                result.warnings.push(`Summenabweichung: Zahlungsarten (${sumPay.toFixed(2)} €) != Gesamtumsatz (${result.total.toFixed(2)} €).`);
            } else {
                result.sumCheck = 'PARTIAL';
            }
        } else {
            result.sumCheck = 'INCOMPLETE';
            result.warnings.push('Gesamtumsatz und Zahlungsarten konnten nicht eindeutig erkannt werden. Bitte manuell eingeben.');
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
