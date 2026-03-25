const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const puppeteer = require("puppeteer");
const chalk = require("chalk");
const path = require("path");

// ================= CONFIG =================
const PORT = process.env.PORT || 3000;
const XAGUSD_REFRESH_MS = 1000; 
const XAUUSD_REFRESH_MS = 1000;

let xagusdPrice = 30.0;
let xauusdPrice = 2000.0;

// ================= EXPRESS + SOCKET =================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ================= ROUTES =================
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public/index.html"));
});

// ================= PUPPETEER =================
let browser, xagusdPage, xauusdPage;

async function initPuppeteer() {
    browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    xagusdPage = await browser.newPage();
    xauusdPage = await browser.newPage();

    await xagusdPage.goto("https://www.investing.com/currencies/xag-usd", { waitUntil: "networkidle2" });
    await xauusdPage.goto("https://www.investing.com/currencies/xau-usd", { waitUntil: "networkidle2" });

    startFetching();
}

async function fetchPrice(page, pair) {
    try {
        const priceText = await page.evaluate(() => {
            const el = document.querySelector('[data-test="instrument-price-last"]') || document.querySelector("#last_last");
            return el ? el.innerText : null;
        });
        if (!priceText) return null;
        return parseFloat(priceText.replace(/,/g, ""));
    } catch (err) {
        console.error(chalk.red(`Error fetching ${pair}: ${err.message}`));
        return null;
    }
}

function startFetching() {
    setInterval(async () => {
        const price = await fetchPrice(xagusdPage, "XAG/USD");
        if (price) {
            xagusdPrice = price;
            io.emit("pricePoint", { symbol: "XAG/USD", price, timestamp: Date.now() });
            console.log(`XAG/USD: ${price}`);
        }
    }, XAGUSD_REFRESH_MS);

    setInterval(async () => {
        const price = await fetchPrice(xauusdPage, "XAU/USD");
        if (price) {
            xauusdPrice = price;
            io.emit("pricePoint", { symbol: "XAU/USD", price, timestamp: Date.now() });
            console.log(`XAU/USD: ${price}`);
        }
    }, XAUUSD_REFRESH_MS);
}

// ================= SOCKET EVENTS =================
io.on("connection", (socket) => {
    console.log("Client connected");
    socket.emit("pricePoint", { symbol: "XAG/USD", price: xagusdPrice, timestamp: Date.now() });
    socket.emit("pricePoint", { symbol: "XAU/USD", price: xauusdPrice, timestamp: Date.now() });
});

// ================= START SERVER =================
server.listen(PORT, () => {
    console.log(chalk.green(`Server running on port ${PORT}`));
    initPuppeteer();
});