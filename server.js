// Backend Server untuk TikTok Live Auction
// Install dependencies: npm install ws express tiktok-live-connector

const express = require("express");
const path = require("path");
const http = require("http");

const WebSocket = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');

const PORT = 8081;

// ========================================================
// 1. HTTP SERVER UNTUK SERVE widget.html & control.html
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
const processedGifts = new Map();

// Auction state
let auctionActive = false;
let auctionTimer = null;

// cleanup setiap 10 detik
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of processedGifts.entries()) {
    if (now - timestamp > 10000) processedGifts.delete(key);
  }
}, 10000);


wss.on('connection', (ws) => {
  console.log('✅ New client connected');
  
  let tiktokLive = null;
  let currentUsername = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // ========================================================
      // CONNECT TO TIKTOK LIVE
      // ========================================================
      if (data.type === 'connect') {
        const username = data.username;
        currentUsername = username;

        console.log(`🔌 Connecting to @${username}...`);
        
        processedGifts.clear();

        tiktokLive = new WebcastPushConnection(username, {
          processInitialData: false,
          enableExtendedGiftInfo: true,
          enableWebsocketUpgrade: true,
          requestPollingIntervalMs: 1000
        });

        // Connected
        tiktokLive.on('connected', () => {
          console.log(`✅ Connected to TikTok Live @${username}`);
          
          // Broadcast to all clients
          broadcastToAll({
            type: 'connected',
            username,
            message: 'Connected to TikTok Live'
          });
        });

        // ========================================================
        // GIFT HANDLER
        // ========================================================
        tiktokLive.on('gift', (data) => {
          const signature = `${data.uniqueId}_${data.giftId}_${data.repeatCount}`;

          if (processedGifts.has(signature)) return;

          processedGifts.set(signature, Date.now());

          const totalDiamonds = data.diamondCount;

          // Broadcast gift to all clients
          broadcastToAll({
            type: 'gift',
            username: data.uniqueId,
            nickname: data.nickname,
            giftName: data.giftName,
            giftId: data.giftId,
            diamondCount: totalDiamonds,
            repeatCount: data.repeatCount,
            signature: signature,
            msgId: data.msgId,
            timestamp: Date.now(),
            auctionActive: auctionActive
          });

          console.log(`🎁 ${data.nickname} sent ${data.giftName} x${data.repeatCount} (${totalDiamonds} 💎)`);
        });

        // Chat
        tiktokLive.on('chat', (data) => {
          const msgId = data.msgId || `${data.uniqueId}_${data.comment}_${Date.now()}`;

          if (!processedGifts.has(msgId)) {
            processedGifts.set(msgId, Date.now());

            broadcastToAll({
              type: 'chat',
              username: data.uniqueId,
              nickname: data.nickname,
              message: data.comment,
              msgId
            });
          }
        });

        // Other events
        tiktokLive.on('follow', d => console.log(`👤 @${d.nickname} followed`));
        tiktokLive.on('share', d => console.log(`🔗 @${d.nickname} share live`));

        tiktokLive.on('disconnected', () => {
          broadcastToAll({ type: 'disconnected' });
        });

        tiktokLive.on('error', (err) => {
          console.log("❌ TikTok error:", err.message);
          broadcastToAll({ type: 'error', message: err.message });
        });

        // Connect
        try {
          await tiktokLive.connect();
          tiktokConnections.set(ws, tiktokLive);
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'error',
            message: `Failed to connect: ${err.message}`
          }));
        }
      }

      // ========================================================
      // DISCONNECT HANDLER
      // ========================================================
      if (data.type === 'disconnect') {
        if (tiktokLive) {
          tiktokLive.disconnect();
          processedGifts.clear();
          console.log(`🔌 Disconnected from @${currentUsername}`);
        }
      }

      // ========================================================
      // AUCTION CONTROL HANDLERS
      // ========================================================
      if (data.type === 'auction_start') {
        auctionActive = true;
        console.log(`🎯 Auction started: ${data.itemName}`);
        
        // Clear auction timer if exists
        if (auctionTimer) {
          clearTimeout(auctionTimer);
        }

        // Set auto-end timer
        if (data.duration) {
          auctionTimer = setTimeout(() => {
            auctionActive = false;
            broadcastToAll({
              type: 'auction_end',
              autoEnd: true
            });
            console.log('⏱️ Auction ended (timeout)');
          }, data.duration * 1000);
        }

        // Broadcast to all clients (including widgets)
        broadcastToAll({
          type: 'auction_start',
          itemName: data.itemName,
          currentItem: data.currentItem,
          totalItems: data.totalItems,
          startingBid: data.startingBid,
          duration: data.duration
        });
      }

      if (data.type === 'auction_stop' || data.type === 'auction_end') {
        auctionActive = false;
        
        if (auctionTimer) {
          clearTimeout(auctionTimer);
          auctionTimer = null;
        }

        console.log('⏹️ Auction stopped');
        
        broadcastToAll({
          type: 'auction_end',
          winner: data.winner,
          winningBid: data.winningBid
        });
      }

      if (data.type === 'auction_reset') {
        auctionActive = false;
        
        if (auctionTimer) {
          clearTimeout(auctionTimer);
          auctionTimer = null;
        }

        console.log('🔄 Auction reset');
        
        broadcastToAll({
          type: 'auction_reset'
        });
      }

    } catch (err) {
      console.error('Error processing message:', err);
      ws.send(JSON.stringify({
        type: 'error',
        message: "Error processing data"
      }));
    }
  });

  ws.on('close', () => {
    console.log('❌ Client disconnected');

    if (tiktokLive) {
      tiktokLive.disconnect();
      tiktokConnections.delete(ws);
    }
  });
});

// ========================================================
// BROADCAST TO ALL CONNECTED CLIENTS
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
// 3. START HTTP + WEBSOCKET SERVER
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