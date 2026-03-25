/**
 * ============================================================
 * 🏁 SIMPLIFIED HYBRID DASHBOARD for TERMUX (XAU/USD & XAG/USD only)
 * ============================================================
 * FIXES (mobile):
 * - Alert sound now plays via browser (Web Audio API) – works on mobile.
 * - Added viewport meta tag and responsive table scrolling.
 * ============================================================
 * MODIFIED: Price fetching now uses **Puppeteer** (headless browser)
 * for more reliable data from investing.com (same logic as in the
 * enhanced hybrid dashboard).
 * ============================================================
 * ADDITIONAL FIXES (2026-03-20):
 * - Diff alert now alerts on the absolute diff value (not its change).
 * - Removed duplicate summary above table (info already in columns).
 * - Fixed raw price history: keep 30 minutes instead of 100 entries,
 *   ensuring 5‑minute price change calculation works for user‑adjustable
 *   windows (up to 20 minutes).
 * ============================================================
 * NEW UPDATES (2026-03-20):
 * - Default alert cooldown set to 10 minutes (frontend input now shows 10).
 * - Alert sound duration increased to 3 seconds.
 * - XAU Diff % column moved to second position (after Symbol).
 * ============================================================
 * FIXES (2026-03-21):
 * - First real price now resets per‑second arrays and average history,
 *   preventing contamination from default initial prices.
 * - Alert log messages now include window and are formatted as:
 *   "XAG/USD price ▲ 5min 1.23% change" and
 *   "XAG - XAU diff ▲ 5min 0.45% change".
 * ============================================================
 * NEW FEATURES (2026-03-22):
 * - Added two columns: "% from High" and "% from Low" (5‑min window)
 * - Added live charts for XAG/USD and XAU/USD below the alert log.
 * ============================================================
 * UPDATE (2026-03-24):
 * - Combined XAG/USD and XAU/USD into a single overlapping chart.
 * - Added adjustable timeframe dropdown (1min, 5min, 15min, 1hr) that
 *   controls the chart's displayed history length.
 * - Server now keeps 2 hours of price data to support 1hr view.
 * - Chart uses time‑based x‑axis, no need for manual label alignment.
 * ============================================================
 * UPDATE (2026-03-26):
 * - Chart now shows percentage change from the start of the selected
 *   timeframe (both series normalized to 0% at the first data point),
 *   enabling direct comparison of relative movements.
 * ============================================================
 * FIX (2026-03-30):
 * - Dashboard now correctly reflects current configuration values
 *   (price windows, diff windows, thresholds, etc.) upon page load.
 *   Input fields are populated with actual server defaults, not
 *   hardcoded placeholder values.
 * ============================================================
 * MODIFICATION (2026-03-31):
 * - Removed price spike filter: all fetched prices are accepted immediately.
 *   No price fluctuations are ignored.
 * ============================================================
 */

const axios = require("axios");
const chalk = require("chalk");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const puppeteer = require("puppeteer");

// ===================== CONFIG =====================
const PORT = 7000;
const CURRENT_SCRIPT = "termux_xau_xag_puppeteer.js";

let REFRESH_MS = 1000;               // main refresh (not heavily used now)
let XAGUSD_REFRESH_MS = 1000;        // XAG/USD fetch interval
let XAUUSD_REFRESH_MS = 1000;        // XAU/USD fetch interval

// Alert Cooldown (minutes)
let ALERT_COOLDOWN_MINUTES = 0.1;

// Price Alert Conditions – adjustable via UI
let PRICE_ALERT_CONDITIONS = [
    { window: 1, threshold: 0.1 },
    { window: 2, threshold: 1.2 },
    { window: 5, threshold: 2 },
    { window: 15, threshold: 3 }
];

// XAU/USD Diff Alert Conditions (adjustable)
let DIFF_ALERT_CONDITIONS = [
    { window: 5, threshold: 0.1 },
    { window: 10, threshold: 0.7 },
    { window: 15, threshold: 1 },
    { window: 30, threshold: 2 }
];

// 5‑Minute Window (adjustable)
let FIVE_MIN_WINDOW_MINUTES = 5;
let FIVE_MIN_WINDOW_MS = FIVE_MIN_WINDOW_MINUTES * 60 * 1000;

// 15‑second average window (adjustable)
let AVG_WINDOW_SECONDS = 15;
let AVG_WINDOW_MS = AVG_WINDOW_SECONDS * 1000;

// Alert Highlight Duration
const ALERT_HIGHLIGHT_DURATION_MS = 15 * 1000; // 15 seconds

// Sound toggle (frontend only now)
let isSoundEnabled = true;   // kept for compatibility, but sound is played on frontend

// ===================== STATE =====================
let xagusdPrice = 30.0;
let xagusdPrevClose = 30.0;
let xagusdHigh = 30.5;
let xagusdLow = 29.5;
let xagusdChange = 0;
let xagusdPriceHistory = [];        // now keeps up to 2 hours
let xagusdFiveMinData = {
    price: 0,
    percentChange: 0,
    averagePercent: 0,
    deviationFromAvg: 0,
    high5m: 0,
    low5m: 0
};

let xauusdPrice = 2000.0;
let xauusdPrevClose = 2000.0;
let xauusdHigh = 2010.0;
let xauusdLow = 1990.0;
let xauusdChange = 0;
let xauusdPriceHistory = [];        // now keeps up to 2 hours
let xauusdFiveMinData = {
    price: 0,
    percentChange: 0,
    averagePercent: 0,
    deviationFromAvg: 0,
    high5m: 0,
    low5m: 0
};

// Flags to reset per‑second arrays on first real price
let firstXagPriceReceived = false;
let firstXauPriceReceived = false;

// Alert history (for cooldown and highlighting)
let lastPriceAlertTime = new Map();        // symbol -> timestamp
let lastDiffAlertTime = 0;                 // for XAU/USD diff alerts

let alertHighlightHistory = {
    "XAG/USD": [],
    "XAU/USD": [],
    "DIFF": []                              // for diff alerts
};

// Alert log (for dashboard display)
let alertLog = [];                          // array of { type, message, time }
const MAX_LOG_ENTRIES = 20;

// ===================== PRICE SPIKE FILTER (REMOVED) =====================
// Now every price is accepted immediately.
function validatePrice(symbol, newPrice) {
    return true;
}

// ===================== 15‑SECOND AVERAGE & 5‑MIN CHANGE =====================
let xagusdPerSecondPrices = [];
let xauusdPerSecondPrices = [];

let xagusd15sAvgHistory = [];
let xauusd15sAvgHistory = [];

let xauusdDiffHistory = [];

function resetPerSecondArrays(symbol, price) {
    const now = Date.now();
    if (symbol === 'XAG/USD') {
        xagusdPerSecondPrices = [{ time: now, price: price }];
        xagusd15sAvgHistory = [{ time: now, avg: price }];
        firstXagPriceReceived = true;
    } else {
        xauusdPerSecondPrices = [{ time: now, price: price }];
        xauusd15sAvgHistory = [{ time: now, avg: price }];
        firstXauPriceReceived = true;
    }
    console.log(chalk.cyan(`🔄 Reset ${symbol} per‑second arrays with price ${price}`));
}

function startPerSecondSampling() {
    setInterval(() => {
        const now = Date.now();

        if (firstXagPriceReceived) {
            xagusdPerSecondPrices.push({ time: now, price: xagusdPrice });
        }
        if (firstXauPriceReceived) {
            xauusdPerSecondPrices.push({ time: now, price: xauusdPrice });
        }

        const cutoff = now - AVG_WINDOW_MS;
        xagusdPerSecondPrices = xagusdPerSecondPrices.filter(p => p.time >= cutoff);
        xauusdPerSecondPrices = xauusdPerSecondPrices.filter(p => p.time >= cutoff);

        const xagAvg = getLastAvgNow('XAG/USD');
        const xauAvg = getLastAvgNow('XAU/USD');
        if (xagAvg !== null) {
            xagusd15sAvgHistory.push({ time: now, avg: xagAvg });
        }
        if (xauAvg !== null) {
            xauusd15sAvgHistory.push({ time: now, avg: xauAvg });
        }

        const xagAvg5m = getAvg5MinChange('XAG/USD');
        const xauAvg5m = getAvg5MinChange('XAU/USD');
        if (xagAvg5m !== null && xauAvg5m !== null) {
            const diff = xagAvg5m - xauAvg5m;
            xauusdDiffHistory.push({ time: now, diff });
        }

        // Keep up to 2 hours of averages/diffs
        const twoHoursAgo = now - 2 * 60 * 60 * 1000;
        xagusd15sAvgHistory = xagusd15sAvgHistory.filter(h => h.time >= twoHoursAgo);
        xauusd15sAvgHistory = xauusd15sAvgHistory.filter(h => h.time >= twoHoursAgo);
        xauusdDiffHistory = xauusdDiffHistory.filter(h => h.time >= twoHoursAgo);
    }, 1000);
}

function getLastAvgNow(symbol) {
    const arr = symbol === 'XAG/USD' ? xagusdPerSecondPrices : xauusdPerSecondPrices;
    if (arr.length === 0) return null;
    const sum = arr.reduce((acc, p) => acc + p.price, 0);
    return sum / arr.length;
}

function getLastAvg(symbol) {
    return getLastAvgNow(symbol);
}

function getAvg5MinChange(symbol) {
    const history = symbol === 'XAG/USD' ? xagusd15sAvgHistory : xauusd15sAvgHistory;
    if (history.length < 2) return null;

    const now = Date.now();
    const fiveMinAgo = now - FIVE_MIN_WINDOW_MS;

    let closest = null;
    let minDiff = Infinity;
    for (const entry of history) {
        const diff = Math.abs(entry.time - fiveMinAgo);
        if (diff < minDiff) {
            minDiff = diff;
            closest = entry;
        }
    }
    if (!closest) return null;

    const oldAvg = closest.avg;
    const currentAvg = getLastAvg(symbol);
    if (currentAvg === null) return null;

    return ((currentAvg - oldAvg) / oldAvg) * 100;
}

// ===================== PUPPETEER SCRAPER =====================
let browser;
let xagusdPage, xauusdPage;

const PUPPETEER_TIMEOUT = 60000;
const PUPPETEER_RETRIES = 3;

async function initPuppeteerScraper() {
    try {
        console.log(chalk.cyan(`🕷️ Launching Puppeteer for XAG/USD & XAU/USD...`));
        browser = await puppeteer.launch({
            headless: "new",
            args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"]
        });

        xagusdPage = await browser.newPage();
        await xagusdPage.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        await navigateWithRetry(xagusdPage, "https://www.investing.com/currencies/xag-usd", "XAG/USD");

        xauusdPage = await browser.newPage();
        await xauusdPage.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        await navigateWithRetry(xauusdPage, "https://www.investing.com/currencies/xau-usd", "XAU/USD");

        startPuppeteerFetching();
    } catch (err) {
        console.error(chalk.red(`❌ Puppeteer initialization error: ${err.message}`));
        setTimeout(initPuppeteerScraper, 30000);
    }
}

async function navigateWithRetry(page, url, name, attempt = 1) {
    try {
        console.log(chalk.cyan(`🕷️ Attempt ${attempt} to load ${name}...`));
        await page.goto(url, { waitUntil: "networkidle2", timeout: PUPPETEER_TIMEOUT });
        await page.waitForSelector('[data-test="instrument-price-last"], #last_last', { timeout: 10000 }).catch(() => {});
        console.log(chalk.green(`✅ ${name} page loaded (attempt ${attempt})`));
    } catch (err) {
        if (attempt < PUPPETEER_RETRIES) {
            console.log(chalk.yellow(`⚠️ ${name} navigation failed, retrying in 5s...`));
            await new Promise(resolve => setTimeout(resolve, 5000));
            await navigateWithRetry(page, url, name, attempt + 1);
        } else {
            console.error(chalk.red(`❌ Failed to load ${name} after ${PUPPETEER_RETRIES} attempts`));
            throw err;
        }
    }
}

async function fetchPuppeteerPrice(page, pairName) {
    try {
        const priceText = await page.evaluate(() => {
            const el = document.querySelector('[data-test="instrument-price-last"]') ||
                       document.querySelector("#last_last");
            return el ? el.innerText : null;
        });
        if (!priceText) return null;
        return parseFloat(priceText.replace(/,/g, ''));
    } catch (err) {
        console.error(chalk.red(`❌ Error fetching ${pairName} price: ${err.message}`));
        try {
            await page.reload({ waitUntil: "networkidle2", timeout: PUPPETEER_TIMEOUT });
            const priceText = await page.evaluate(() => {
                const el = document.querySelector('[data-test="instrument-price-last"]') ||
                           document.querySelector("#last_last");
                return el ? el.innerText : null;
            });
            if (priceText) return parseFloat(priceText.replace(/,/g, ''));
        } catch (reloadErr) {
            console.error(chalk.red(`❌ Reload failed for ${pairName}: ${reloadErr.message}`));
        }
        return null;
    }
}

async function fetchXAGUSDPrice() {
    if (!xagusdPage) return false;
    const price = await fetchPuppeteerPrice(xagusdPage, "XAG/USD");
    if (price && price > 0) {
        // No validation: accept immediately
        if (!firstXagPriceReceived) {
            resetPerSecondArrays('XAG/USD', price);
        }
        xagusdPrice = price;
        if (xagusdPrevClose > 0) {
            xagusdChange = ((xagusdPrice - xagusdPrevClose) / xagusdPrevClose) * 100;
        }
        xagusdPriceHistory.push({ time: new Date(), price: xagusdPrice, change: xagusdChange });
        // Keep up to 2 hours
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
        xagusdPriceHistory = xagusdPriceHistory.filter(e => e.time >= twoHoursAgo);

        calculateXAGUSDFiveMinData();

        console.log(chalk.green(`✅ XAG/USD: ${xagusdPrice.toFixed(4)} (${xagusdChange >= 0 ? '+' : ''}${xagusdChange.toFixed(2)}%)`));
        io.emit('pricePoint', { symbol: 'XAG/USD', price: xagusdPrice, timestamp: Date.now() });
        return true;
    }
    return false;
}

async function fetchXAUUSDPrice() {
    if (!xauusdPage) return false;
    const price = await fetchPuppeteerPrice(xauusdPage, "XAU/USD");
    if (price && price > 0) {
        if (!firstXauPriceReceived) {
            resetPerSecondArrays('XAU/USD', price);
        }
        xauusdPrice = price;
        if (xauusdPrevClose > 0) {
            xauusdChange = ((xauusdPrice - xauusdPrevClose) / xauusdPrevClose) * 100;
        }
        xauusdPriceHistory.push({ time: new Date(), price: xauusdPrice, change: xauusdChange });
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
        xauusdPriceHistory = xauusdPriceHistory.filter(e => e.time >= twoHoursAgo);

        calculateXAUUSDFiveMinData();

        console.log(chalk.green(`✅ XAU/USD: ${xauusdPrice.toFixed(2)} (${xauusdChange >= 0 ? '+' : ''}${xauusdChange.toFixed(2)}%)`));
        io.emit('pricePoint', { symbol: 'XAU/USD', price: xauusdPrice, timestamp: Date.now() });
        return true;
    }
    return false;
}

let xagusdInterval, xauusdInterval;
function startPuppeteerFetching() {
    if (xagusdInterval) clearInterval(xagusdInterval);
    if (xauusdInterval) clearInterval(xauusdInterval);
    
    xagusdInterval = setInterval(async () => {
        await fetchXAGUSDPrice();
        broadcast();
    }, XAGUSD_REFRESH_MS);
    
    xauusdInterval = setInterval(async () => {
        await fetchXAUUSDPrice();
        broadcast();
    }, XAUUSD_REFRESH_MS);
    
    console.log(chalk.cyan(`🔄 Puppeteer fetch intervals started: XAG/USD ${XAGUSD_REFRESH_MS}ms, XAU/USD ${XAUUSD_REFRESH_MS}ms`));
}

// ===================== 5‑MIN CALCULATIONS =====================
function calculateXAGUSDFiveMinData() {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - FIVE_MIN_WINDOW_MS);
    const recent = xagusdPriceHistory.filter(e => e.time >= fiveMinAgo);

    if (recent.length === 0) {
        if (xagusdPriceHistory.length > 0) {
            const earliest = xagusdPriceHistory[0];
            const percentChange = ((xagusdPrice - earliest.price) / earliest.price) * 100;
            xagusdFiveMinData = {
                price: earliest.price,
                percentChange: percentChange,
                averagePercent: 0,
                deviationFromAvg: 0,
                high5m: xagusdPrice,
                low5m: xagusdPrice
            };
        } else {
            xagusdFiveMinData = {
                price: xagusdPrice,
                percentChange: 0,
                averagePercent: 0,
                deviationFromAvg: 0,
                high5m: xagusdPrice,
                low5m: xagusdPrice
            };
        }
        return;
    }

    const fiveMinPrice = recent[0].price;
    const percentChange = ((xagusdPrice - fiveMinPrice) / fiveMinPrice) * 100;
    const avgPrice = recent.reduce((s, e) => s + e.price, 0) / recent.length;
    const avgPercentChange = ((xagusdPrice - avgPrice) / avgPrice) * 100;
    const deviationFromAvg = ((1 + percentChange/100) - (1 + avgPercentChange/100)) / (1 + avgPercentChange/100) * 100;

    const prices = recent.map(e => e.price);
    const high5m = Math.max(...prices);
    const low5m = Math.min(...prices);

    xagusdFiveMinData = { price: fiveMinPrice, percentChange, averagePercent: avgPercentChange, deviationFromAvg, high5m, low5m };
}

function calculateXAUUSDFiveMinData() {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - FIVE_MIN_WINDOW_MS);
    const recent = xauusdPriceHistory.filter(e => e.time >= fiveMinAgo);

    if (recent.length === 0) {
        if (xauusdPriceHistory.length > 0) {
            const earliest = xauusdPriceHistory[0];
            const percentChange = ((xauusdPrice - earliest.price) / earliest.price) * 100;
            xauusdFiveMinData = {
                price: earliest.price,
                percentChange: percentChange,
                averagePercent: 0,
                deviationFromAvg: 0,
                high5m: xauusdPrice,
                low5m: xauusdPrice
            };
        } else {
            xauusdFiveMinData = {
                price: xauusdPrice,
                percentChange: 0,
                averagePercent: 0,
                deviationFromAvg: 0,
                high5m: xauusdPrice,
                low5m: xauusdPrice
            };
        }
        return;
    }

    const fiveMinPrice = recent[0].price;
    const percentChange = ((xauusdPrice - fiveMinPrice) / fiveMinPrice) * 100;
    const avgPrice = recent.reduce((s, e) => s + e.price, 0) / recent.length;
    const avgPercentChange = ((xauusdPrice - avgPrice) / avgPrice) * 100;
    const deviationFromAvg = ((1 + percentChange/100) - (1 + avgPercentChange/100)) / (1 + avgPercentChange/100) * 100;

    const prices = recent.map(e => e.price);
    const high5m = Math.max(...prices);
    const low5m = Math.min(...prices);

    xauusdFiveMinData = { price: fiveMinPrice, percentChange, averagePercent: avgPercentChange, deviationFromAvg, high5m, low5m };
}

// ===================== ALERT LOGIC =====================
function checkPriceAlerts(symbol, avgHistory) {
    const now = Date.now();
    const lastAlert = lastPriceAlertTime.get(symbol) || 0;
    if (now - lastAlert < ALERT_COOLDOWN_MINUTES * 60 * 1000) return null;

    const currentAvg = getLastAvg(symbol);
    if (currentAvg === null) return null;

    let triggered = null;
    let maxChange = 0;
    for (const cond of PRICE_ALERT_CONDITIONS) {
        const cutoff = now - cond.window * 60 * 1000;
        const hist = avgHistory.filter(e => e.time >= cutoff);
        if (hist.length === 0) continue;
        let oldest = hist.reduce((a, b) => a.time < b.time ? a : b);
        const change = ((currentAvg - oldest.avg) / oldest.avg) * 100;
        if (Math.abs(change) >= cond.threshold && Math.abs(change) > Math.abs(maxChange)) {
            triggered = { ...cond, changePercent: change, alertTime: now };
            maxChange = change;
        }
    }
    if (triggered) {
        lastPriceAlertTime.set(symbol, now);
        alertHighlightHistory[symbol].push({ type: 'price', time: now });
        const direction = triggered.changePercent >= 0 ? '▲' : '▼';
        const message = `${symbol} price ${direction} ${triggered.window}min ${Math.abs(triggered.changePercent).toFixed(2)}% change`;
        addAlertLog('price', message);
    }
    return triggered;
}

function checkDiffAlerts() {
    const now = Date.now();
    if (now - lastDiffAlertTime < ALERT_COOLDOWN_MINUTES * 60 * 1000) return null;

    const currentDiff = getCurrentDiff();
    if (currentDiff === null) return null;

    let triggered = null;
    let maxAbsDiff = 0;
    for (const cond of DIFF_ALERT_CONDITIONS) {
        if (Math.abs(currentDiff) >= cond.threshold && Math.abs(currentDiff) > maxAbsDiff) {
            triggered = { ...cond, changePercent: currentDiff, alertTime: now };
            maxAbsDiff = Math.abs(currentDiff);
        }
    }
    if (triggered) {
        lastDiffAlertTime = now;
        alertHighlightHistory['DIFF'].push({ time: now });
        const direction = triggered.changePercent >= 0 ? '▲' : '▼';
        const message = `XAG - XAU diff ${direction} ${triggered.window}min ${Math.abs(triggered.changePercent).toFixed(2)}% change`;
        addAlertLog('diff', message);
    }
    return triggered;
}

function addAlertLog(type, message) {
    const entry = { type, message, time: Date.now() };
    alertLog.unshift(entry);
    if (alertLog.length > MAX_LOG_ENTRIES) alertLog.pop();
    console.log(chalk.yellow(`🔔 ALERT: ${message}`));
}

function getCurrentDiff() {
    const xagAvg5m = getAvg5MinChange('XAG/USD');
    const xauAvg5m = getAvg5MinChange('XAU/USD');
    if (xagAvg5m === null || xauAvg5m === null) return null;
    return xagAvg5m - xauAvg5m;
}

// ===================== EXPRESS & SOCKET =====================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

setInterval(() => {
    const now = Date.now();
    for (let key in alertHighlightHistory) {
        alertHighlightHistory[key] = alertHighlightHistory[key].filter(e => now - e.time < ALERT_HIGHLIGHT_DURATION_MS);
    }
}, 1000);

// ===================== FRONTEND =====================
app.get("/", (req, res) => {
    // Fetch current configuration values to inject into HTML
    const xagRefresh = XAGUSD_REFRESH_MS;
    const xauRefresh = XAUUSD_REFRESH_MS;
    const fiveMinWindow = FIVE_MIN_WINDOW_MINUTES;
    const avgWindow = AVG_WINDOW_SECONDS;
    const cooldown = ALERT_COOLDOWN_MINUTES;
    const priceWindows = PRICE_ALERT_CONDITIONS.map(c => c.window).join(',');
    const priceThresholds = PRICE_ALERT_CONDITIONS.map(c => c.threshold).join(',');
    const diffWindows = DIFF_ALERT_CONDITIONS.map(c => c.window).join(',');
    const diffThresholds = DIFF_ALERT_CONDITIONS.map(c => c.threshold).join(',');

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=yes">
  <title>📊 XAU/XAG Live Dashboard (Termux)</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #0d1117; color: #eee; margin: 0; padding: 12px; }
    h1 { color: #4fc3f7; font-size: 18px; margin: 0 0 10px; }
    .config-bar { background: #1f2937; padding: 10px; border-radius: 8px; display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .setting-group { display: flex; gap: 4px; align-items: center; background: rgba(255,255,255,0.05); padding: 4px 8px; border-radius: 6px; flex-wrap: wrap; }
    .setting-group label { color: #9ca3af; font-size: 11px; }
    .setting-group input { width: 60px; padding: 4px; border-radius: 4px; border: 1px solid #374151; background: #0d1117; color: #eee; font-size: 11px; }
    .setting-group input.large { width: 100px; }
    .btn { background: #4fc3f7; color: #000; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .btn:hover { opacity: 0.9; }
    .sound-toggle { background: none; border: 1px solid #4fc3f7; color: #4fc3f7; }
    .badge { background: #374151; padding: 2px 6px; border-radius: 4px; font-size: 10px; color: #9ca3af; }
    .positive { color: #10b981; }
    .negative { color: #ef4444; }
    .table-container { overflow-x: auto; margin-top: 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 700px; }
    th, td { padding: 8px; border-bottom: 1px solid #222; text-align: left; white-space: nowrap; }
    th { background: #0f1720; color: #cde; }
    tr.xagusd { background: rgba(72, 187, 120, 0.1); border-left: 3px solid #48bb78; }
    tr.xauusd { background: rgba(236, 201, 75, 0.1); border-left: 3px solid #ecc94b; }
    tr.highlight { animation: pulse 1.5s infinite alternate; }
    @keyframes pulse { 0% { background-color: rgba(255,152,0,0.3); } 100% { background-color: rgba(255,152,0,0.1); } }
    .timestamp { color: #10b981; font-weight: bold; }
    .log-panel { background: #1f2937; border-radius: 8px; padding: 8px; margin-top: 15px; max-height: 150px; overflow-y: auto; font-size: 11px; }
    .log-entry { border-bottom: 1px solid #374151; padding: 4px 0; }
    .log-time { color: #9ca3af; margin-right: 8px; }
    .log-price { color: #4fc3f7; }
    .log-diff { color: #fbbf24; }
    .chart-container { margin-top: 20px; background: #1f2937; border-radius: 8px; padding: 10px; }
    .timeframe-selector { display: flex; justify-content: flex-end; margin-bottom: 10px; gap: 8px; align-items: center; }
    .timeframe-selector select { background: #0d1117; color: #eee; border: 1px solid #4fc3f7; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    canvas { max-height: 350px; width: 100%; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
  <script src="/socket.io/socket.io.js"></script>
</head>
<body>
  <h1>📊 XAU/USD & XAG/USD Live (Termux)</h1>
  <div class="config-bar">
    <div class="setting-group"><label>XAG ms</label><input id="xagRefresh" value="${xagRefresh}" type="number" min="500" step="100"></div>
    <div class="setting-group"><label>XAU ms</label><input id="xauRefresh" value="${xauRefresh}" type="number" min="500" step="100"></div>
    <div class="setting-group"><label>5m</label><input id="fiveMinWindow" value="${fiveMinWindow}" type="number" min="1" max="20" step="1"></div>
    <div class="setting-group"><label>Avg s</label><input id="avgWindow" value="${avgWindow}" type="number" min="1" max="60" step="1"></div>
    <div class="setting-group"><label>Cooldown m</label><input id="cooldown" value="${cooldown}" type="number" min="1" max="120"></div>
    <div class="setting-group"><label>Price windows</label><input id="priceWindows" value="${priceWindows}" class="large"></div>
    <div class="setting-group"><label>Price thresh</label><input id="priceThresholds" value="${priceThresholds}" class="large"></div>
    <div class="setting-group"><label>Diff windows</label><input id="diffWindows" value="${diffWindows}" class="large"></div>
    <div class="setting-group"><label>Diff thresh</label><input id="diffThresholds" value="${diffThresholds}" class="large"></div>
    <button class="btn" id="applySettings">Apply</button>
    <button class="btn sound-toggle" id="soundToggle">🔔 ON</button>
  </div>

  <div class="table-container">
    <table id="data-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>XAU Diff %</th>
          <th>Price (₹)</th>
          <th id="avgHeader">${avgWindow}s Avg</th>
          <th id="avgChangeHeader">${fiveMinWindow}m Δ Avg (%)</th>
          <th id="highLowHeader">H/L (${fiveMinWindow}m)</th>
          <th>% from High</th>
          <th>% from Low</th>
          <th id="priceChangeHeader">${fiveMinWindow}m Price Δ (%)</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <div class="log-panel" id="alertLog">
    <div style="color:#9ca3af; margin-bottom:5px;">📋 Alert Log</div>
    <div id="logEntries"></div>
  </div>

  <div class="chart-container">
    <div class="timeframe-selector">
      <span>Chart Timeframe:</span>
      <select id="timeframeSelect">
        <option value="1">1 min</option>
        <option value="5" selected>5 min</option>
        <option value="15">15 min</option>
        <option value="60">1 hour</option>
      </select>
    </div>
    <canvas id="combinedChart"></canvas>
  </div>

  <script>
    const socket = io();
    let soundOn = true;
    let audioCtx = null;
    let soundReady = false;

    // Chart data – absolute prices (as received from server)
    let xagAbsolute = [];
    let xauAbsolute = [];

    // Normalized data (percentage change from baseline)
    let xagNormalized = [];
    let xauNormalized = [];

    // Baseline prices (first price in the current visible window)
    let xagBaseline = null;
    let xauBaseline = null;

    let combinedChart;

    // Helper: convert absolute points to normalized using baseline
    function normalize(points, baseline) {
      if (baseline === null || points.length === 0) return [];
      return points.map(p => ({ x: p.x, y: ((p.y - baseline) / baseline) * 100 }));
    }

    // Update chart with normalized data
    function updateChart() {
      if (!combinedChart) return;
      combinedChart.data.datasets[0].data = xagNormalized;
      combinedChart.data.datasets[1].data = xauNormalized;
      combinedChart.update();
    }

    // Request history for a given timeframe (minutes)
    function requestHistory(timeframeMinutes) {
      socket.emit('requestHistory', timeframeMinutes);
    }

    // Reset everything when timeframe changes
    function setTimeframe(minutes) {
      xagAbsolute = [];
      xauAbsolute = [];
      xagNormalized = [];
      xauNormalized = [];
      xagBaseline = null;
      xauBaseline = null;
      requestHistory(minutes);
    }

    // Initialize chart (single Y‑axis for % change)
    function initChart() {
      const ctx = document.getElementById('combinedChart').getContext('2d');
      combinedChart = new Chart(ctx, {
        type: 'line',
        data: {
          datasets: [
            {
              label: 'XAG/USD',
              data: xagNormalized,
              borderColor: '#48bb78',
              backgroundColor: 'rgba(72,187,120,0.1)',
              fill: true,
              tension: 0.1,
              pointRadius: 0,
              pointHoverRadius: 4
            },
            {
              label: 'XAU/USD',
              data: xauNormalized,
              borderColor: '#ecc94b',
              backgroundColor: 'rgba(236,201,75,0.1)',
              fill: true,
              tension: 0.1,
              pointRadius: 0,
              pointHoverRadius: 4
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: {
              type: 'time',
              time: { unit: 'minute', displayFormats: { minute: 'HH:mm' } },
              title: { display: true, text: 'Time' }
            },
            y: {
              title: { display: true, text: 'Change (%)' },
              ticks: {
                callback: value => value.toFixed(2) + '%'
              }
            }
          },
          plugins: {
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  let label = ctx.dataset.label || '';
                  if (label) label += ': ';
                  label += ctx.raw.y.toFixed(2) + '%';
                  return label;
                }
              }
            },
            legend: { position: 'top' }
          }
        }
      });
    }

    // Sound handling (unchanged)
    (function initAudioContext() {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) { console.warn("Web Audio API not supported"); }
    })();

    async function enableSound() {
      if (!audioCtx) {
        initAudioContext();
        if (!audioCtx) return;
      }
      if (audioCtx.state === 'suspended') {
        try {
          await audioCtx.resume();
          soundReady = true;
          console.log('Audio context resumed');
        } catch (e) { console.warn('Could not resume audio context', e); }
      } else if (audioCtx.state === 'running') {
        soundReady = true;
      }
    }

    function playBeep() {
      if (!soundOn || !soundReady || !audioCtx || audioCtx.state !== 'running') return;
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      oscillator.frequency.value = 800;
      gainNode.gain.value = 0.2;
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 3);
    }

    socket.on('alert', playBeep);

    document.getElementById('soundToggle').onclick = () => {
      soundOn = !soundOn;
      document.getElementById('soundToggle').innerText = soundOn ? '🔔 ON' : '🔕 OFF';
      if (soundOn) enableSound();
    };

    document.getElementById('applySettings').onclick = () => {
      const priceWindows = document.getElementById('priceWindows').value.split(',').map(s => parseFloat(s.trim()));
      const priceThresholds = document.getElementById('priceThresholds').value.split(',').map(s => parseFloat(s.trim()));
      const diffWindows = document.getElementById('diffWindows').value.split(',').map(s => parseFloat(s.trim()));
      const diffThresholds = document.getElementById('diffThresholds').value.split(',').map(s => parseFloat(s.trim()));

      if (priceWindows.length !== priceThresholds.length) {
        alert('Price windows and thresholds must have the same number of values');
        return;
      }
      if (diffWindows.length !== diffThresholds.length) {
        alert('Diff windows and thresholds must have the same number of values');
        return;
      }

      socket.emit('updateSettings', {
        xagRefresh: parseInt(document.getElementById('xagRefresh').value),
        xauRefresh: parseInt(document.getElementById('xauRefresh').value),
        fiveMinWindow: parseInt(document.getElementById('fiveMinWindow').value),
        avgWindow: parseInt(document.getElementById('avgWindow').value),
        cooldown: parseInt(document.getElementById('cooldown').value),
        priceWindows: priceWindows,
        priceThresholds: priceThresholds,
        diffWindows: diffWindows,
        diffThresholds: diffThresholds
      });

      const avgSec = document.getElementById('avgWindow').value;
      const fiveMin = document.getElementById('fiveMinWindow').value;
      document.getElementById('avgHeader').innerText = avgSec + 's Avg';
      document.getElementById('avgChangeHeader').innerText = fiveMin + 'm Δ Avg (%)';
      document.getElementById('highLowHeader').innerText = 'H/L (' + fiveMin + 'm)';
      document.getElementById('priceChangeHeader').innerText = fiveMin + 'm Price Δ (%)';
    };

    // Timeframe change listener
    document.getElementById('timeframeSelect').addEventListener('change', (e) => {
      const val = parseInt(e.target.value);
      setTimeframe(val);
    });

    // Receive history for the requested timeframe
    socket.on('historyResponse', (data) => {
      // data = { xagHistory: [{time, price}], xauHistory: [{time, price}] }
      // Store absolute points
      xagAbsolute = data.xagHistory.map(p => ({ x: p.time, y: p.price }));
      xauAbsolute = data.xauHistory.map(p => ({ x: p.time, y: p.price }));

      // Set baselines to the first price of each series (oldest timestamp)
      xagBaseline = xagAbsolute.length ? xagAbsolute[0].y : null;
      xauBaseline = xauAbsolute.length ? xauAbsolute[0].y : null;

      // Compute normalized data
      xagNormalized = normalize(xagAbsolute, xagBaseline);
      xauNormalized = normalize(xauAbsolute, xauBaseline);

      updateChart();
    });

    // Receive new price point
    socket.on('pricePoint', (point) => {
      const newPoint = { x: point.timestamp, y: point.price };
      if (point.symbol === 'XAG/USD') {
        xagAbsolute.push(newPoint);
        if (xagBaseline !== null) {
          xagNormalized.push({ x: point.timestamp, y: ((point.price - xagBaseline) / xagBaseline) * 100 });
        }
      } else {
        xauAbsolute.push(newPoint);
        if (xauBaseline !== null) {
          xauNormalized.push({ x: point.timestamp, y: ((point.price - xauBaseline) / xauBaseline) * 100 });
        }
      }
      updateChart();
    });

    // Receive table data and highlight
    socket.on('update', (data) => {
      const tbody = document.querySelector('#data-table tbody');
      tbody.innerHTML = '';

      function createRow(symbol, price, avg, changeAvg, high, low, fiveMinPriceChange, diff, percentFromHigh, percentFromLow, highlight) {
        const tr = document.createElement('tr');
        tr.className = symbol === 'XAG/USD' ? 'xagusd' : 'xauusd';
        if (highlight) tr.classList.add('highlight');
        const highLow = \`H: \${high.toFixed(symbol==='XAG/USD'?4:2)} L: \${low.toFixed(symbol==='XAG/USD'?4:2)}\`;
        const priceFormatted = price.toFixed(symbol==='XAG/USD'?4:2);
        const avgFormatted = avg !== null ? avg.toFixed(symbol==='XAG/USD'?4:2) : '-';
        const changeAvgFormatted = changeAvg !== null ? (changeAvg >= 0 ? '+' : '') + changeAvg.toFixed(2) + '%' : '-';
        const fiveMinChangeFormatted = (fiveMinPriceChange !== undefined && fiveMinPriceChange !== null) 
            ? (fiveMinPriceChange >= 0 ? '+' : '') + fiveMinPriceChange.toFixed(2) + '%' 
            : '-';
        const diffFormatted = diff !== null ? (diff >= 0 ? '+' : '') + diff.toFixed(2) + '%' : '-';
        const fromHighFormatted = percentFromHigh !== null ? (percentFromHigh >= 0 ? '-' : '+') + Math.abs(percentFromHigh).toFixed(2) + '%' : '-';
        const fromLowFormatted = percentFromLow !== null ? (percentFromLow >= 0 ? '+' : '-') + Math.abs(percentFromLow).toFixed(2) + '%' : '-';
        tr.innerHTML = \`
            <td><strong>\${symbol}</strong></td>
            <td class="\${diff >= 0 ? 'positive' : 'negative'}">\${diffFormatted}</td>
            <td>\${priceFormatted}</td>
            <td>\${avgFormatted}</td>
            <td class="\${changeAvg >= 0 ? 'positive' : 'negative'}">\${changeAvgFormatted}</td>
            <td>\${highLow}</td>
            <td class="\${percentFromHigh >= 0 ? 'positive' : 'negative'}">\${fromHighFormatted}</td>
            <td class="\${percentFromLow >= 0 ? 'positive' : 'negative'}">\${fromLowFormatted}</td>
            <td class="\${fiveMinPriceChange >= 0 ? 'positive' : 'negative'}">\${fiveMinChangeFormatted}</td>
        \`;
        return tr;
      }

      const xagAvg5m = data.xagusdAvg5mChange;
      const xauAvg5m = data.xauusdAvg5mChange;
      const xagDiff = (xagAvg5m !== null && xauAvg5m !== null) ? xagAvg5m - xauAvg5m : null;

      const xagHigh = data.xagusdFiveMinData.high5m;
      const xagLow = data.xagusdFiveMinData.low5m;
      const xagCurrent = data.xagusdPrice;
      let xagPercentFromHigh = null, xagPercentFromLow = null;
      if (xagHigh && xagCurrent) {
        xagPercentFromHigh = ((xagCurrent - xagHigh) / xagHigh) * 100;
        xagPercentFromLow = ((xagCurrent - xagLow) / xagLow) * 100;
      }

      const xauHigh = data.xauusdFiveMinData.high5m;
      const xauLow = data.xauusdFiveMinData.low5m;
      const xauCurrent = data.xauusdPrice;
      let xauPercentFromHigh = null, xauPercentFromLow = null;
      if (xauHigh && xauCurrent) {
        xauPercentFromHigh = ((xauCurrent - xauHigh) / xauHigh) * 100;
        xauPercentFromLow = ((xauCurrent - xauLow) / xauLow) * 100;
      }

      const xagHighlight = data.highlight && data.highlight.XAGUSD;
      const xauHighlight = data.highlight && data.highlight.XAUUSD;

      tbody.appendChild(createRow('XAG/USD',
        data.xagusdPrice,
        data.xagusdAvg,
        xagAvg5m,
        xagHigh,
        xagLow,
        data.xagusdFiveMinData.percentChange,
        xagDiff,
        xagPercentFromHigh,
        xagPercentFromLow,
        xagHighlight
      ));
      tbody.appendChild(createRow('XAU/USD',
        data.xauusdPrice,
        data.xauusdAvg,
        xauAvg5m,
        xauHigh,
        xauLow,
        data.xauusdFiveMinData.percentChange,
        null,
        xauPercentFromHigh,
        xauPercentFromLow,
        xauHighlight
      ));
    });

    socket.on('alertLog', (logs) => {
      const logDiv = document.getElementById('logEntries');
      logDiv.innerHTML = logs.map(entry => {
        const time = new Date(entry.time).toLocaleTimeString();
        const cls = entry.type === 'price' ? 'log-price' : 'log-diff';
        return \`<div class="log-entry"><span class="log-time">\${time}</span> <span class="\${cls}">\${entry.message}</span></div>\`;
      }).join('');
    });

    // Initial load: default 5 min timeframe
    initChart();
    setTimeframe(5);
  </script>
</body>
</html>
  `);
});

// ===================== SOCKET HANDLERS =====================
io.on("connection", (socket) => {
    socket.on("updateSettings", (settings) => {
        if (settings.xagRefresh) { XAGUSD_REFRESH_MS = settings.xagRefresh; restartXAGUSDInterval(); }
        if (settings.xauRefresh) { XAUUSD_REFRESH_MS = settings.xauRefresh; restartXAUUSDInterval(); }
        if (settings.fiveMinWindow) {
            FIVE_MIN_WINDOW_MINUTES = settings.fiveMinWindow;
            FIVE_MIN_WINDOW_MS = FIVE_MIN_WINDOW_MINUTES * 60 * 1000;
            calculateXAGUSDFiveMinData();
            calculateXAUUSDFiveMinData();
            console.log(chalk.cyan(`⚙️ 5‑minute window updated to ${FIVE_MIN_WINDOW_MINUTES} minutes`));
        }
        if (settings.avgWindow && settings.avgWindow > 0) {
            AVG_WINDOW_SECONDS = settings.avgWindow;
            AVG_WINDOW_MS = AVG_WINDOW_SECONDS * 1000;
            console.log(chalk.cyan(`⚙️ Average window updated to ${AVG_WINDOW_SECONDS} seconds`));
        }
        if (settings.cooldown) { ALERT_COOLDOWN_MINUTES = settings.cooldown; }

        if (settings.priceWindows && settings.priceThresholds) {
            const windows = settings.priceWindows;
            const thresholds = settings.priceThresholds;
            if (windows.length === thresholds.length) {
                PRICE_ALERT_CONDITIONS = windows.map((w, i) => ({ window: w, threshold: thresholds[i] }));
                console.log(chalk.cyan("⚙️ Price alert conditions updated:"));
                PRICE_ALERT_CONDITIONS.forEach(c => console.log(`   ${c.window}min @ ${c.threshold}%`));
            }
        }

        if (settings.diffWindows && settings.diffThresholds) {
            const windows = settings.diffWindows;
            const thresholds = settings.diffThresholds;
            if (windows.length === thresholds.length) {
                DIFF_ALERT_CONDITIONS = windows.map((w, i) => ({ window: w, threshold: thresholds[i] }));
                console.log(chalk.cyan("⚙️ Diff alert conditions updated:"));
                DIFF_ALERT_CONDITIONS.forEach(c => console.log(`   ${c.window}min @ ${c.threshold}%`));
            }
        }

        console.log(chalk.cyan("⚙️ Settings updated"));
    });

    // Send current alert log to newly connected client
    socket.emit('alertLog', alertLog);

    // Handle history request from client
    socket.on('requestHistory', (timeframeMinutes) => {
        const now = Date.now();
        const cutoff = now - timeframeMinutes * 60 * 1000;

        const filterHistory = (history) => {
            // history items have .time as Date object
            return history.filter(item => item.time >= cutoff).map(item => ({
                time: item.time.getTime(),
                price: item.price
            }));
        };

        const xagHistory = filterHistory(xagusdPriceHistory);
        const xauHistory = filterHistory(xauusdPriceHistory);

        socket.emit('historyResponse', { xagHistory, xauHistory });
    });
});

// ===================== BROADCAST UPDATES =====================
function broadcast() {
    const now = Date.now();

    const xagPriceAlert = checkPriceAlerts('XAG/USD', xagusd15sAvgHistory);
    const xauPriceAlert = checkPriceAlerts('XAU/USD', xauusd15sAvgHistory);
    const diffAlert = checkDiffAlerts();

    if (xagPriceAlert || xauPriceAlert || diffAlert) {
        io.emit('alert');
    }

    const highlight = {
        XAGUSD: alertHighlightHistory['XAG/USD'].some(e => now - e.time < ALERT_HIGHLIGHT_DURATION_MS),
        XAUUSD: alertHighlightHistory['XAU/USD'].some(e => now - e.time < ALERT_HIGHLIGHT_DURATION_MS),
        DIFF: alertHighlightHistory['DIFF'].some(e => now - e.time < ALERT_HIGHLIGHT_DURATION_MS)
    };

    const data = {
        xagusdPrice,
        xagusdChange,
        xagusdHigh,
        xagusdLow,
        xagusdFiveMinData,
        xagusdAvg: getLastAvg('XAG/USD'),
        xagusdAvg5mChange: getAvg5MinChange('XAG/USD'),
        xauusdPrice,
        xauusdChange,
        xauusdHigh,
        xauusdLow,
        xauusdFiveMinData,
        xauusdAvg: getLastAvg('XAU/USD'),
        xauusdAvg5mChange: getAvg5MinChange('XAU/USD'),
        highlight,
        time: new Date().toLocaleTimeString("en-US")
    };
    io.emit("update", data);
    io.emit("alertLog", alertLog);
}

// ===================== INTERVALS =====================
function restartXAGUSDInterval() {
    if (xagusdInterval) clearInterval(xagusdInterval);
    xagusdInterval = setInterval(async () => {
        await fetchXAGUSDPrice();
        broadcast();
    }, XAGUSD_REFRESH_MS);
}
function restartXAUUSDInterval() {
    if (xauusdInterval) clearInterval(xauusdInterval);
    xauusdInterval = setInterval(async () => {
        await fetchXAUUSDPrice();
        broadcast();
    }, XAUUSD_REFRESH_MS);
}

// ===================== START =====================
server.listen(PORT, async () => {
    console.log(chalk.green(`🌐 Dashboard: http://localhost:${PORT}`));
    console.log(chalk.cyan("🔄 Initializing Puppeteer scraper..."));
    await initPuppeteerScraper();
    console.log(chalk.green(`✅ Dashboard ready!`));
    startPerSecondSampling();
    broadcast();
});

process.on("SIGINT", async () => {
    if (xagusdInterval) clearInterval(xagusdInterval);
    if (xauusdInterval) clearInterval(xauusdInterval);
    if (browser) await browser.close();
    server.close(() => process.exit(0));
});