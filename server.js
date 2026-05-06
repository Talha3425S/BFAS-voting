// =====================================================
// SERVER.JS - Main Backend Server with WebSocket Support
// Location: backend/src/server.js
// MODIFIED: Added Socket.IO for P2P negotiation channels
// =====================================================
import 'dotenv/config';
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });


//
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import http from "http"; // NEW: For WebSocket support
// Import existing routes
import authRoutes from "./routes/auth.js";
import propertyRoutes from "./routes/property.js";
import transferRoutes from "./routes/transfer.js";
import ownershipHistoryRoutes from "./routes/ownershipHistory.js";
import marketAnalyticsRoutes from "./routes/marketAnalytics.js";
import blockchainRoutes from "./routes/blockchain.js";
import officerToolsRoutes from "./routes/officerTools.js";
import landRecordRoutes from "./routes/landRecordRoutes.js";
import transferCompatibilityRoutes from "./routes/transfer_new_routes.js";
import p2pRoutes from "./routes/p2p_routes.js";
import adminBlockchainRoutes from "./routes/adminBlockchain.routes.js";
import successionApprovalRoutes from "./routes/successionApproval.routes.js";
import fabricStatusRoutes from "./routes/fabricStatus.routes.js";
import registrationVotingRoutes from "./routes/registrationVoting.routes.js";
import transferVotingRoutes from "./routes/transferVoting.routes.js";
import marketplaceRoutes from "./routes/marketplace.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import p2pSchemaService from "./services/p2pSchema.service.js";
import auditService from "./services/audit.service.js";
import ownershipHistoryService from "./services/ownershipHistory.service.js";
import opsAutomationService from "./services/opsAutomation.service.js";

// NEW: Import P2P channel routes and WebSocket service
import channelRoutes from "./routes/channel.js";
import websocketService from "./services/websocket.service.js";
import paymentRoutes from './routes/payment.js';
import fabricPLRAService from "./services/fabricPLRA.service.js";
import adminRecoveryRoutes from "./routes/adminRecovery.routes.js";
// Import DB pool
import pool from "./config/db.js";
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



const app = express();

try {
    await auditService.ensureSchema();
    console.log("Audit schema verified");
} catch (error) {
    console.error("Failed to verify audit schema:", error.message);
}

try {
    await p2pSchemaService.ensureSchema();
    console.log("✅ P2P messaging schema verified");
} catch (error) {
    console.error("❌ Failed to verify P2P messaging schema:", error.message);
}

try {
    await ownershipHistoryService.ensureSchema();
    console.log("Ownership history schema verified");
} catch (error) {
    console.error("Failed to verify ownership history schema:", error.message);
}

// =====================================================
// MIDDLEWARE CONFIGURATION
// =====================================================

// ── Static file serving MUST come before helmet ──────────────
// Helmet sets Cross-Origin-Resource-Policy: same-origin which silently
// blocks the React app (port 3000) from loading audio/images from the
// API server (port 5000). Serving uploads before helmet bypasses this.
const uploadsPath = path.join(__dirname, '../uploads');
app.use('/uploads', (req, res, next) => {
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Accept-Ranges', 'bytes');
  if (req.path.endsWith('.webm')) res.set('Content-Type', 'audio/webm; codecs=opus');
  else if (req.path.endsWith('.ogg')) res.set('Content-Type', 'audio/ogg; codecs=opus');
  next();
}, express.static(uploadsPath));

// Security Headers (after /uploads so helmet does not override CORP on media files)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

// CORS Configuration
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
}));

// Body Parsers
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Request Logging (Development)
if (process.env.NODE_ENV !== "production") {
    app.use(morgan("dev"));
}


// =====================================================
// ROOT ROUTE - Health Check
// =====================================================
app.get("/", (req, res) => {
    res.json({ 
        message: "✅ Blockchain Land Records Backend Server",
        status: "Running",
        version: "1.0.0",
        websocket: "enabled", // NEW: Indicate WebSocket is available
        timestamp: new Date().toISOString()
    });
});
app.use('/api/payments', paymentRoutes);

// Test Database Connection
app.get("/api/health", async (req, res) => {
    try {
        const [result, fabricProof] = await Promise.all([
            pool.query("SELECT NOW()"),
            fabricPLRAService.getConnectivityProof().catch((error) => ({
                connected: false,
                sameVotingNodesForRegistryAndTransfer: true,
                topology: fabricPLRAService.buildVotingTopology(),
                network: null,
                probes: {
                    registrationQuery: { ok: false, error: error.message, result: null },
                    transferQuery: { ok: false, error: error.message, result: null },
                    successionQuery: { ok: false, error: error.message, result: null }
                }
            }))
        ]);
        res.json({
            status: "OK",
            database: "Connected",
            websocket: "enabled",
            fabric: {
                connected: Boolean(fabricProof.connected),
                nodeCount: fabricProof?.topology?.nodeCount || 5,
                voteThreshold: fabricProof?.topology?.voteThreshold || 3,
                sameVotingNodesForRegistryAndTransfer: Boolean(
                    fabricProof?.sameVotingNodesForRegistryAndTransfer
                ),
                registrationChaincode: fabricProof?.topology?.registrationVoting?.chaincode || "voting",
                transferChaincode: fabricProof?.topology?.transferVoting?.chaincode || "land-agreement",
                registrationQueryOk: Boolean(fabricProof?.probes?.registrationQuery?.ok),
                transferQueryOk: Boolean(fabricProof?.probes?.transferQuery?.ok),
                proofEndpoint: "/api/fabric-status/public"
            },
            timestamp: result.rows[0].now
        });
    } catch (err) {
        res.status(500).json({
            status: "ERROR",
            database: "Disconnected",
            error: err.message
        });
    }
});

// =====================================================
// API ROUTES
// =====================================================
app.use("/api/auth", authRoutes);
app.use("/api/properties", propertyRoutes);
app.use("/api/transfers", transferRoutes);
app.use("/api/ownership-history", ownershipHistoryRoutes);
app.use("/api/market", marketAnalyticsRoutes);
app.use("/api/marketplace", marketplaceRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/blockchain", blockchainRoutes);
app.use("/api/officer", officerToolsRoutes);
app.use("/api/land-records", landRecordRoutes);
app.use("/api/transfers", transferCompatibilityRoutes);
app.use("/api/p2p", p2pRoutes);
app.use("/api/admin/blockchain", adminBlockchainRoutes);
app.use("/api/admin/recovery", adminRecoveryRoutes);
app.use("/api/succession", successionApprovalRoutes);
app.use("/api/fabric-status", fabricStatusRoutes);
app.use("/api/registration-voting", registrationVotingRoutes);
app.use("/api/transfer-voting", transferVotingRoutes);

// NEW: P2P Negotiation Channel Routes
app.use("/api/channels", channelRoutes);

console.log("✅ Routes registered:");
console.log("   - /api/auth");
console.log("   - /api/properties");
console.log("   - /api/transfers");
console.log("   - /api/ownership-history");
console.log("   - /api/blockchain");
console.log("   - /api/officer");
console.log("   - /api/land-records");
console.log("   - /api/market");
console.log("   - /api/marketplace");
console.log("   - /api/notifications");
console.log("   - /api/admin/blockchain");
console.log("   - /api/admin/recovery");
console.log("   - /api/succession");
console.log("   - /api/fabric-status");
console.log("   - /api/registration-voting");
console.log("   - /api/transfer-voting");
console.log("   - /api/channels          [NEW - P2P Negotiation]");
console.log("   - /api/p2p               [RECOVERED - P2P Compatibility]");

// =====================================================
// ERROR HANDLING
// =====================================================
app.use((req, res) => {
    res.status(404).json({ 
        error: "Route not found",
        path: req.originalUrl,
        method: req.method
    });
});

app.use((err, req, res, next) => {
    console.error("❌ Server Error:", err);
    res.status(err.status || 500).json({
        error: err.message || "Internal Server Error",
        ...(process.env.NODE_ENV !== "production" && { stack: err.stack })
    });
});

// =====================================================
// CREATE HTTP SERVER & INITIALIZE WEBSOCKET
// =====================================================

// NEW: Create HTTP server instead of directly using app.listen
const httpServer = http.createServer(app);

// NEW: Initialize Socket.IO for real-time communication
try {
    websocketService.initializeSocketIO(httpServer);
    console.log("✅ WebSocket (Socket.IO) initialized successfully");
} catch (error) {
    console.error("❌ Failed to initialize WebSocket:", error.message);
    // Server can still run without WebSocket if needed
}

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 5000;

async function logFabricStartupStatus() {
    try {
        const proof = await fabricPLRAService.getConnectivityProof();

        console.log("-----------------------------------------------------");
        console.log("Fabric Connectivity Proof");
        console.log("-----------------------------------------------------");
        console.log(`Connection profile: ${process.env.FABRIC_CONNECTION_PROFILE || "./connection-plra.json"}`);
        console.log(`Channel: ${process.env.FABRIC_CHANNEL_NAME || "landregistry"}`);
        console.log(`Registration chaincode: ${proof?.topology?.registrationVoting?.chaincode || "voting"}`);
        console.log(`Transfer chaincode: ${proof?.topology?.transferVoting?.chaincode || "land-agreement"}`);
        console.log(`Voting nodes in backend: ${proof?.topology?.nodeCount || 5}`);
        console.log(`Vote threshold: ${proof?.topology?.voteThreshold || 3}/5`);
        console.log(`Same nodes for registry and transfer: ${proof.sameVotingNodesForRegistryAndTransfer ? "YES" : "NO"}`);
        console.log(`Registration query probe: ${proof?.probes?.registrationQuery?.ok ? "OK" : `FAILED (${proof?.probes?.registrationQuery?.error || "unknown"})`}`);
        console.log(`Transfer query probe: ${proof?.probes?.transferQuery?.ok ? "OK" : `FAILED (${proof?.probes?.transferQuery?.error || "unknown"})`}`);
        console.log(`Succession query probe: ${proof?.probes?.successionQuery?.ok ? "OK" : `FAILED (${proof?.probes?.successionQuery?.error || "unknown"})`}`);
        console.log(`Proof API: http://localhost:${PORT}/api/fabric-status/public`);

        if (proof.connected) {
            console.log("FABRIC STATUS: CONNECTED");
        } else {
            console.log("FABRIC STATUS: NOT CONNECTED");
            console.log("Required before backend voting works:");
            console.log("  cd /mnt/c/Users/Dell/pioneer-blockchain-framework/network");
            console.log("  bash setup_fabric_network_ha.sh landregistry voting 1.0 1");
            console.log("  bash scripts/deployChaincode.sh landregistry land-agreement");
        }

        console.log("-----------------------------------------------------");
    } catch (error) {
        console.log("-----------------------------------------------------");
        console.log("FABRIC STATUS: NOT CONNECTED");
        console.log(`Startup proof failed: ${error.message}`);
        console.log(`Proof API: http://localhost:${PORT}/api/fabric-status/public`);
        console.log("-----------------------------------------------------");
    }
}

httpServer.listen(PORT, () => {
    console.log("\n=====================================================");
    console.log("🚀 Blockchain Land Records Backend Server");
    console.log("=====================================================");
    console.log(`✅ Server running on: http://localhost:${PORT}`);
    console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🔐 Auth API: http://localhost:${PORT}/api/auth`);
    console.log(`🏠 Property API: http://localhost:${PORT}/api/properties`);
    console.log(`📄 Transfer API: http://localhost:${PORT}/api/transfers`);
    console.log(`📊 Market API: http://localhost:${PORT}/api/market`);
    console.log(`⛓️  Blockchain API: http://localhost:${PORT}/api/blockchain`);
    console.log(`💬 Channel API: http://localhost:${PORT}/api/channels [NEW]`);
    console.log(`🔌 WebSocket: ws://localhost:${PORT} [NEW]`);
    console.log(`📅 Started at: ${new Date().toLocaleString()}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log("=====================================================\n");
    console.log(`Fabric proof API: http://localhost:${PORT}/api/fabric-status/public`);
    opsAutomationService.start();
    void logFabricStartupStatus();
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (err) => {
    console.error("❌ Unhandled Rejection:", err);
    // Don't exit immediately in production
    if (process.env.NODE_ENV === "production") {
        console.error("Server will continue running...");
    } else {
        process.exit(1);
    }
});

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught Exception:", err);
    // Don't exit immediately in production
    if (process.env.NODE_ENV === "production") {
        console.error("Server will continue running...");
    } else {
        process.exit(1);
    }
});

// Graceful shutdown
process.on("SIGTERM", () => {
    console.log("SIGTERM received, closing server gracefully...");
    opsAutomationService.stop();
    httpServer.close(() => {
        console.log("✅ Server closed successfully");
        pool.end(); // Close database connections
        process.exit(0);
    });
});

process.on("SIGINT", () => {
    console.log("\nSIGINT received, closing server gracefully...");
    opsAutomationService.stop();
    httpServer.close(() => {
        console.log("✅ Server closed successfully");
        pool.end(); // Close database connections
        process.exit(0);
    });
});

// Export app for testing
export default app;