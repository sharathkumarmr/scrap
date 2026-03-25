// ===================== IMPORTS =====================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const puppeteer = require("puppeteer-core");

// ===================== CONFIG =====================
const PORT = process.env.PORT || 7000;

// Optimized for Railway FREE
let XAGUSD_REFRESH_MS = 4000;
let XAUUSD_REFRESH_MS = 4000;

let AVG_WINDOW_SECONDS = 15;
let FIVE_MIN_WINDOW_MINUTES = 5;

const AVG_WINDOW_MS = AVG_WINDOW_SECONDS * 1000;
const FIVE_MIN_WINDOW_MS = FIVE_MIN_WINDOW_MINUTES * 60 * 1000;

// ===================== STATE =====================
let xagPrice = 30;
let xauPrice = 2000;

let xagHistory = [];
let xauHistory = [];

let xagPerSec = [];
let xauPerSec = [];

let xagAvgHist = [];
let xauAvgHist = [];

// ===================== EXPRESS =====================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ===================== FRONTEND =====================
app.get("/", (req, res) => {
    res.send(`
    <html>
    <head>
        <title>XAU XAG Dashboard</title>
        <script src="/socket.io/socket.io.js"></script>
    </head>
    <body style="background:#0d1117;color:white;font-family:sans-serif">
        <h2>XAU / XAG Live</h2>
        <div id="data"></div>

        <script>
        const socket = io();

        socket.on("update", data => {
            document.getElementById("data").innerHTML = \`
                XAG: \${data.xag.toFixed(4)} <br>
                XAU: \${data.xau.toFixed(2)} <br>
                XAG 5m: \${data.xag5m?.toFixed(2) || '-'}% <br>
                XAU 5m: \${data.xau5m?.toFixed(2) || '-'}%
            \`;
        });
        </script>
    </body>
    </html>
    `);
});

// ===================== PUPPETEER =====================
let browser, page;

async function initBrowser() {
    browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--no-zygote",
            "--disable-gpu"
        ]
    });

    page = await browser.newPage();
    await page.goto("https://www.investing.com/currencies/xau-usd", {
        waitUntil: "networkidle2"
    });
}

// ===================== FETCH =====================
async function fetchPrices() {
    try {
        const data = await page.evaluate(() => {
            const get = (sel) => {
                const el = document.querySelector(sel);
                return el ? parseFloat(el.innerText.replace(/,/g,'')) : null;
            };

            return {
                xau: get('[data-test="instrument-price-last"]'),
            };
        });

        if (data.xau) xauPrice = data.xau;

        // open second page only when needed
        const newPage = await browser.newPage();
        await newPage.goto("https://www.investing.com/currencies/xag-usd");

        const xag = await newPage.evaluate(() => {
            const el = document.querySelector('[data-test="instrument-price-last"]');
            return el ? parseFloat(el.innerText.replace(/,/g,'')) : null;
        });

        if (xag) xagPrice = xag;

        await newPage.close();

    } catch (e) {
        console.log("Fetch error", e.message);
    }
}

// ===================== LOGIC =====================
function avg(arr) {
    if (!arr.length) return null;
    return arr.reduce((a,b)=>a+b,0)/arr.length;
}

function get5mChange(avgHist) {
    if (avgHist.length < 2) return null;

    const now = Date.now();
    const cutoff = now - FIVE_MIN_WINDOW_MS;

    let old = avgHist.find(p => p.time >= cutoff);
    if (!old) return null;

    const current = avgHist[avgHist.length - 1].avg;

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

    // keep 30 min only
    const cutoff = now - 30 * 60 * 1000;
    xagAvgHist = xagAvgHist.filter(p => p.time >= cutoff);
    xauAvgHist = xauAvgHist.filter(p => p.time >= cutoff);

}, 1000);

// ===================== FETCH LOOP =====================
setInterval(fetchPrices, 4000);

// ===================== BROADCAST =====================
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
    console.log("Server running on port", PORT);
    await initBrowser();
});
