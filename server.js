// ===================== IMPORTS =====================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const puppeteer = require("puppeteer");

// ===================== CONFIG =====================
const PORT = process.env.PORT || 8080;

// Railway safe intervals
const FETCH_INTERVAL = 5000;
const AVG_WINDOW_MS = 15000;
const FIVE_MIN_MS = 5 * 60 * 1000;

// ===================== STATE =====================
let xagPrice = 30;
let xauPrice = 2000;

let xagPerSec = [];
let xauPerSec = [];

let xagAvgHist = [];
let xauAvgHist = [];

// ===================== SERVER =====================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ===================== UI =====================
app.get("/", (req, res) => {
    res.send(`
    <html>
    <head>
        <title>XAU XAG Live</title>
        <script src="/socket.io/socket.io.js"></script>
    </head>
    <body style="background:#0d1117;color:white;font-family:sans-serif">
        <h2>📊 XAU / XAG Live</h2>
        <div id="data">Loading...</div>

        <script>
        const socket = io();

        socket.on("update", data => {
            document.getElementById("data").innerHTML = \`
                <b>XAG:</b> \${data.xag.toFixed(4)} <br>
                <b>XAU:</b> \${data.xau.toFixed(2)} <br><br>
                <b>XAG 5m:</b> \${data.xag5m ? data.xag5m.toFixed(2) + '%' : '-'} <br>
                <b>XAU 5m:</b> \${data.xau5m ? data.xau5m.toFixed(2) + '%' : '-'}
            \`;
        });
        </script>
    </body>
    </html>
    `);
});

// ===================== PUPPETEER =====================
let browser;
let pageXAU;
let pageXAG;

async function initBrowser() {
    browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--no-zygote",
            "--disable-gpu"
        ]
    });

    pageXAU = await browser.newPage();
    await pageXAU.goto("https://www.investing.com/currencies/xau-usd", { waitUntil: "networkidle2" });

    pageXAG = await browser.newPage();
    await pageXAG.goto("https://www.investing.com/currencies/xag-usd", { waitUntil: "networkidle2" });

    console.log("✅ Puppeteer ready");
}

// ===================== FETCH =====================
async function fetchPrices() {
    try {
        const xau = await pageXAU.evaluate(() => {
            const el = document.querySelector('[data-test="instrument-price-last"]');
            return el ? parseFloat(el.innerText.replace(/,/g,'')) : null;
        });

        const xag = await pageXAG.evaluate(() => {
            const el = document.querySelector('[data-test="instrument-price-last"]');
            return el ? parseFloat(el.innerText.replace(/,/g,'')) : null;
        });

        if (xau) xauPrice = xau;
        if (xag) xagPrice = xag;

    } catch (err) {
        console.log("Fetch error:", err.message);
    }
}

// ===================== CALCULATIONS =====================
function avg(arr) {
    if (!arr.length) return null;
    return arr.reduce((a,b)=>a+b,0)/arr.length;
}

function get5mChange(hist) {
    if (hist.length < 2) return null;

    const now = Date.now();
    const old = hist.find(p => p.time >= now - FIVE_MIN_MS);
    if (!old) return null;

    const current = hist[hist.length - 1].avg;
    return ((current - old.avg) / old.avg) * 100;
}

// ===================== SAMPLING =====================
setInterval(() => {
    const now = Date.now();

    xagPerSec.push({ time: now, price: xagPrice });
    xauPerSec.push({ time: now, price: xauPrice });

    xagPerSec = xagPerSec.filter(p => p.time >= now - AVG_WINDOW_MS);
    xauPerSec = xauPerSec.filter(p => p.time >= now - AVG_WINDOW_MS);

    const xagAvg = avg(xagPerSec.map(p=>p.price));
    const xauAvg = avg(xauPerSec.map(p=>p.price));

    if (xagAvg) xagAvgHist.push({ time: now, avg: xagAvg });
    if (xauAvg) xauAvgHist.push({ time: now, avg: xauAvg });

    // keep 30 min history
    const cutoff = now - 30 * 60 * 1000;
    xagAvgHist = xagAvgHist.filter(p => p.time >= cutoff);
    xauAvgHist = xauAvgHist.filter(p => p.time >= cutoff);

}, 1000);

// ===================== LOOPS =====================
setInterval(fetchPrices, FETCH_INTERVAL);

setInterval(() => {
    io.emit("update", {
        xag: xagPrice,
        xau: xauPrice,
        xag5m: get5mChange(xagAvgHist),
        xau5m: get5mChange(xauAvgHist)
    });
}, 2000);

// ===================== START =====================
server.listen(PORT, async () => {
    console.log("🚀 Running on port", PORT);
    await initBrowser();
});
