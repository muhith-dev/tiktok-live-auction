// Backend Server untuk TikTok Live Auction
// Install dependencies: npm install ws express tiktok-live-connector

const express = require("express");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const { WebcastPushConnection } = require("tiktok-live-connector");

const PORT = 8081;

// ========================================================
// 1. HTTP SERVER (serve widget.html & control.html)
// ========================================================
const app = express();
const server = http.createServer(app);

// Serve semua file di folder ini
app.use(express.static(__dirname));

console.log(`🌐 HTTP Server ready: http://localhost:${PORT}`);

// ========================================================
// 2. WEBSOCKET SERVER
// ========================================================
const wss = new WebSocket.Server({ server });

console.log(`🔌 WebSocket Server running on port ${PORT}`);

const tiktokConnections = new Map();
const processedGifts = new Map(); // Key: msgId
const userGiftStreaks = new Map(); // Key: uniqueId-giftId

// Auction state
let auctionActive = false;
let auctionTimer = null;

// Cleanup interval
setInterval(() => {
  const now = Date.now();

  // Cleanup processedGifts (>10 detik)
  for (const [msgId, data] of processedGifts.entries()) {
    if (now - data.timestamp > 10000) processedGifts.delete(msgId);
  }

  // Cleanup userGiftStreaks (>5 detik)
  for (const [key, data] of userGiftStreaks.entries()) {
    if (now - data.lastUpdate > 5000) userGiftStreaks.delete(key);
  }
}, 5000);

// ========================================================
// 3. WEBSOCKET CONNECTION HANDLER
// ========================================================
wss.on("connection", (ws) => {
  console.log("✅ New client connected");

  let tiktokLive = null;
  let currentUsername = null;

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      // ========================================================
      // CONNECT TO TIKTOK LIVE
      // ========================================================
      if (data.type === "connect") {
        const username = data.username;
        currentUsername = username;

        console.log(`🔌 Connecting to @${username}...`);

        processedGifts.clear();
        userGiftStreaks.clear();

        tiktokLive = new WebcastPushConnection(username, {
          processInitialData: false,
          enableExtendedGiftInfo: true,
          enableWebsocketUpgrade: true,
          requestPollingIntervalMs: 1000,
        });

        // Connected
        tiktokLive.on("connected", () => {
          console.log(`✅ Connected to TikTok Live @${username}`);

          broadcastToAll({
            type: "connected",
            username,
            message: "Connected to TikTok Live",
          });
        });

        // ========================================================
        // GIFT HANDLER (Advanced Dedup Logic)
        // ========================================================
        tiktokLive.on("gift", (data) => {
          const now = Date.now();

          // Log streak status
          if (data.giftType === 1 && !data.repeatEnd) {
            console.log(
              `⏳ Streak in progress: ${data.nickname} sending ${data.giftName} x${data.repeatCount}`
            );
          }

          // Create unique key per user-gift combination
          const streakKey = `${data.uniqueId}-${data.giftId}`;
          const existingStreak = userGiftStreaks.get(streakKey);

          // Check if this is a duplicate msgId
          if (data.msgId && processedGifts.has(data.msgId)) {
            console.log(`⏭️ Duplicate msgId skipped: ${data.msgId}`);
            return;
          }

          // Store msgId immediately
          if (data.msgId) {
            processedGifts.set(data.msgId, {
              timestamp: now,
              repeatCount: data.repeatCount
            });
          }

          let shouldBroadcast = false;
          let broadcastCount = data.repeatCount;

          // If there's an existing streak for this user-gift
          if (existingStreak && now - existingStreak.lastUpdate < 5000) {
            // Same gift within 5 seconds - this is a continuation
            
            if (data.repeatCount > existingStreak.totalCount) {
              // Streak increased - broadcast the DIFFERENCE
              broadcastCount = data.repeatCount - existingStreak.totalCount;
              shouldBroadcast = true;
              
              console.log(
                `🔄 Streak update: ${data.nickname} ${data.giftName} ${existingStreak.totalCount} → ${data.repeatCount} (+${broadcastCount})`
              );
              
              // Update streak tracking
              userGiftStreaks.set(streakKey, {
                totalCount: data.repeatCount,
                lastUpdate: now,
                alreadyBroadcasted: true
              });
            } else if (data.repeatCount === existingStreak.totalCount) {
              // Same count - this is likely a repeatEnd event for already broadcasted gift
              if (existingStreak.alreadyBroadcasted) {
                console.log(`⏭️ Duplicate repeatEnd skipped: ${data.nickname} ${data.giftName} x${data.repeatCount}`);
                userGiftStreaks.delete(streakKey); // Clear streak
                return; // Don't broadcast again
              }
            } else {
              // Count lower than before - definitely duplicate
              console.log(`⏭️ Duplicate streak count skipped`);
              return;
            }
          } else {
            // New gift or new streak session
            shouldBroadcast = true;
            
            userGiftStreaks.set(streakKey, {
              totalCount: data.repeatCount,
              lastUpdate: now,
              alreadyBroadcasted: true
            });
            
            console.log(`📦 New gift: ${data.nickname} sent ${data.giftName} x${data.repeatCount}`);
          }

          // Clean up streak if it ended
          if (data.repeatEnd) {
            userGiftStreaks.delete(streakKey);
          }

          // Broadcast if needed
          if (shouldBroadcast) {
            broadcastToAll({
              type: "gift",
              username: data.uniqueId,
              nickname: data.nickname,
              giftName: data.giftName,
              giftId: data.giftId,
              diamondCount: data.diamondCount,
              repeatCount: broadcastCount,
              msgId: data.msgId,
              timestamp: now,
              auctionActive,
            });

            console.log(
              `🎁 ${data.nickname} sent ${data.giftName} x${broadcastCount} (${data.diamondCount}💎 each)`
            );
          }
        });

        // Other events
        tiktokLive.on("follow", (d) =>
          console.log(`👤 @${d.nickname} followed`)
        );

        tiktokLive.on("disconnected", () => {
          broadcastToAll({ type: "disconnected" });
        });

        tiktokLive.on("error", (err) => {
          console.log("❌ TikTok error:", err.message);
          broadcastToAll({ type: "error", message: err.message });
        });

        // Connect
        try {
          await tiktokLive.connect();
          tiktokConnections.set(ws, tiktokLive);
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: `Failed to connect: ${err.message}`,
            })
          );
        }
      }

      // ========================================================
      // DISCONNECT HANDLER
      // ========================================================
      if (data.type === "disconnect") {
        if (tiktokLive) {
          tiktokLive.disconnect();
          processedGifts.clear();
          userGiftStreaks.clear();
          console.log(`🔌 Disconnected from @${currentUsername}`);
        }
      }

      // ========================================================
      // AUCTION CONTROL
      // ========================================================
      if (data.type === "auction_start") {
        auctionActive = true;
        console.log(`🎯 Auction started: ${data.itemName}`);

        if (auctionTimer) clearTimeout(auctionTimer);

        if (data.duration) {
          auctionTimer = setTimeout(() => {
            auctionActive = false;
            broadcastToAll({
              type: "auction_end",
              autoEnd: true,
            });
            console.log("⏱️ Auction ended (timeout)");
          }, data.duration * 1000);
        }

        broadcastToAll({
          type: "auction_start",
          itemName: data.itemName,
          currentItem: data.currentItem,
          totalItems: data.totalItems,
          startingBid: data.startingBid,
          duration: data.duration,
        });
      }

      if (data.type === "auction_stop" || data.type === "auction_end") {
        auctionActive = false;

        if (auctionTimer) clearTimeout(auctionTimer);

        console.log("⏹️ Auction stopped");

        broadcastToAll({
          type: "auction_end",
          winner: data.winner,
          winningBid: data.winningBid,
        });
      }

      if (data.type === "auction_reset") {
        auctionActive = false;

        if (auctionTimer) clearTimeout(auctionTimer);

        console.log("🔄 Auction reset");

        broadcastToAll({ type: "auction_reset" });
      }
    } catch (err) {
      console.error("Error processing message:", err);
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Error processing data",
        })
      );
    }
  });

  ws.on("close", () => {
    console.log("❌ Client disconnected");

    if (tiktokLive) {
      tiktokLive.disconnect();
      tiktokConnections.delete(ws);
    }
  });
});

// ========================================================
// BROADCAST FUNCTION
// ========================================================
function broadcastToAll(data) {
  const message = JSON.stringify(data);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ========================================================
// 4. START SERVER
// ========================================================
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║   🚀 TIKTOK LIVE AUCTION SERVER READY                 ║
║                                                        ║
║   📺 OBS Widget:      http://localhost:${PORT}/widget.html    ║
║   🎛️  Control Panel:   http://localhost:${PORT}/control.html  ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
  `);
});