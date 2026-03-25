const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const puppeteer = require("puppeteer");
const chalk = require("chalk");
const path = require("path");

const PORT = process.env.PORT || 3000;
// Increased to 5s to prevent Railway "Out of Memory" crashes
const REFRESH_MS = 5000; 

let prices = {
    "XAG/USD": 0,
    "XAU/USD": 0
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public/index.html"));
});

async function fetchPrice(page, symbol) {
    try {
        // Selector for Investing.com's live price
        const priceText = await page.evaluate(() => {
            const el = document.querySelector('[data-test="instrument-price-last"]');
            return el ? el.innerText : null;
        });

        if (priceText) {
            const price = parseFloat(priceText.replace(/,/g, ""));
            prices[symbol] = price;
            io.emit("pricePoint", { symbol, price, timestamp: Date.now() });
            console.log(`${chalk.blue(symbol)}: ${chalk.green(price)}`);
        }
    } catch (err) {
        console.error(chalk.red(`Error fetching ${symbol}: ${err.message}`));
    }
}

async function initPuppeteer() {
    console.log(chalk.yellow("Launching Browser..."));
    
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage", // Critical for Railway/Docker
            "--single-process",
            "--no-zygote"
        ]
    });

    const xagusdPage = await browser.newPage();
    const xauusdPage = await browser.newPage();

    // Set User-Agent to avoid being blocked as a bot
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
    await xagusdPage.setUserAgent(ua);
    await xauusdPage.setUserAgent(ua);

    console.log(chalk.yellow("Navigating to pages..."));
    await Promise.all([
        xagusdPage.goto("https://www.investing.com/currencies/xag-usd", { waitUntil: "domcontentloaded" }),
        xauusdPage.goto("https://www.investing.com/currencies/xau-usd", { waitUntil: "domcontentloaded" })
    ]);

    // Start Loops
    setInterval(() => fetchPrice(xagusdPage, "XAG/USD"), REFRESH_MS);
    setInterval(() => fetchPrice(xauusdPage, "XAU/USD"), REFRESH_MS);
}

io.on("connection", (socket) => {
    console.log("Client connected");
    socket.emit("pricePoint", { symbol: "XAG/USD", price: prices["XAG/USD"], timestamp: Date.now() });
    socket.emit("pricePoint", { symbol: "XAU/USD", price: prices["XAU/USD"], timestamp: Date.now() });
});

server.listen(PORT, () => {
    console.log(chalk.cyan(`Server running on port ${PORT}`));
    initPuppeteer().catch(err => console.error("Puppeteer Init Failed:", err));
});