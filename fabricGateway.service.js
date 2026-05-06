import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { promisify } from "util";

import { Gateway, Wallets } from "fabric-network";

import { findNodeById } from "../config/plraNodes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..", "..");
const workspaceRoot = path.resolve(backendRoot, "..");
const execFileAsync = promisify(execFile);

const ORG_CONFIG = {
  Org1: {
    mspId: "Org1MSP",
    identityAlias: "org1-admin",
    certPath:
      "network/crypto-material/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/signcerts/Admin@org1.example.com-cert.pem",
    keyPath:
      "network/crypto-material/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/keystore/priv_sk",
  },
  Org2: {
    mspId: "Org2MSP",
    identityAlias: "org2-admin",
    certPath:
      "network/crypto-material/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp/signcerts/Admin@org2.example.com-cert.pem",
    keyPath:
      "network/crypto-material/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp/keystore/priv_sk",
  },
};

const PEER_TLS_PATHS = {
  "peer0.org1.example.com":
    "network/crypto-material/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt",
  "peer1.org1.example.com":
    "network/crypto-material/peerOrganizations/org1.example.com/peers/peer1.org1.example.com/tls/ca.crt",
  "peer2.org1.example.com":
    "network/crypto-material/peerOrganizations/org1.example.com/peers/peer2.org1.example.com/tls/ca.crt",
  "peer0.org2.example.com":
    "network/crypto-material/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt",
  "peer1.org2.example.com":
    "network/crypto-material/peerOrganizations/org2.example.com/peers/peer1.org2.example.com/tls/ca.crt",
};

const ORDERER_TLS_PATHS = {
  "orderer.example.com":
    "network/crypto-material/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt",
  "orderer2.example.com":
    "network/crypto-material/ordererOrganizations/example.com/orderers/orderer2.example.com/tls/ca.crt",
  "orderer3.example.com":
    "network/crypto-material/ordererOrganizations/example.com/orderers/orderer3.example.com/tls/ca.crt",
};

function resolveWorkspacePath(relativePath) {
  return path.resolve(workspaceRoot, relativePath);
}

function resolveBackendPath(relativePath) {
  return path.resolve(backendRoot, relativePath);
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function isLoopbackHost(host = "") {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function profileUsesLoopback(profile = {}) {
  const urls = [
    ...Object.values(profile.peers || {}).map((details) => details?.url),
    ...Object.values(profile.orderers || {}).map((details) => details?.url),
  ];

  return urls.some((urlString) => {
    try {
      const parsed = new URL(urlString);
      return isLoopbackHost(parsed.hostname);
    } catch (error) {
      return false;
    }
  });
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseFirstIpv4Address(text = "") {
  const matches = String(text).match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [];
  return matches.find((candidate) => candidate !== "127.0.0.1") || matches[0] || null;
}

function replaceUrlHost(urlString, hostOverride) {
  if (!urlString || !hostOverride) return urlString;

  try {
    const parsed = new URL(urlString);
    parsed.hostname = hostOverride;
    return parsed.toString();
  } catch (error) {
    return urlString;
  }
}

class FabricGatewayService {
  constructor() {
    this.cachedHostOverride = undefined;
    this.txParamCountHints = new Map();
  }

  getConnectionProfilePath() {
    const configured = process.env.FABRIC_CONNECTION_PROFILE || "./connection-plra.json";
    return path.isAbsolute(configured)
      ? configured
      : resolveBackendPath(configured);
  }

  getWalletPath() {
    const configured = process.env.FABRIC_WALLET_PATH || "./wallet";
    return path.isAbsolute(configured)
      ? configured
      : resolveBackendPath(configured);
  }

  getChannelName() {
    return process.env.FABRIC_CHANNEL_NAME || "landregistry";
  }

  getVotingChaincodeName() {
    return process.env.FABRIC_VOTING_CHAINCODE || "voting";
  }

  getAgreementChaincodeName() {
    return process.env.FABRIC_AGREEMENT_CHAINCODE || "land-agreement";
  }

  getConfiguredHostOverride() {
    return (
      process.env.FABRIC_HOST_OVERRIDE ||
      process.env.FABRIC_NETWORK_HOST ||
      process.env.FABRIC_WSL_HOST ||
      ""
    ).trim();
  }

  async detectWslHostOverride() {
    if (process.platform !== "win32") return null;
    if (!normalizeBoolean(process.env.FABRIC_AUTO_DETECT_WSL_HOST, true)) return null;

    try {
      const { stdout } = await execFileAsync("wsl.exe", ["hostname", "-I"], {
        timeout: 2500,
        windowsHide: true,
      });
      return parseFirstIpv4Address(stdout);
    } catch (error) {
      return null;
    }
  }

  async resolveHostOverride() {
    if (this.cachedHostOverride !== undefined) {
      return this.cachedHostOverride;
    }

    const explicit = this.getConfiguredHostOverride();
    if (explicit) {
      this.cachedHostOverride = explicit;
      return explicit;
    }

    const detected = await this.detectWslHostOverride();
    this.cachedHostOverride = detected || null;
    return this.cachedHostOverride;
  }

  getDiscoveryOptions() {
    return {
      enabled: normalizeBoolean(process.env.FABRIC_DISCOVERY_ENABLED, true),
      asLocalhost: normalizeBoolean(process.env.FABRIC_DISCOVERY_AS_LOCALHOST, true),
    };
  }

  getNodeContext(nodeId) {
    const node = findNodeById(nodeId) || findNodeById("LRO_NODE_1");
    const orgName = node?.organization === "Org2MSP" ? "Org2" : "Org1";
    const orgConfig = ORG_CONFIG[orgName];

    return {
      node,
      orgName,
      orgConfig,
    };
  }

  async ensureWallet() {
    const walletPath = this.getWalletPath();
    await fs.mkdir(walletPath, { recursive: true });

    const wallet = await Wallets.newFileSystemWallet(walletPath);
    const imported = [];

    for (const [orgName, config] of Object.entries(ORG_CONFIG)) {
      const [certificate, privateKey] = await Promise.all([
        fs.readFile(resolveWorkspacePath(config.certPath), "utf8"),
        fs.readFile(resolveWorkspacePath(config.keyPath), "utf8"),
      ]);

      // The Fabric network is rebuilt frequently in this project, which regenerates
      // admin certificates. Always refresh wallet identities so the backend never
      // signs proposals with stale MSP material from a previous network run.
      await wallet.put(config.identityAlias, {
        credentials: {
          certificate,
          privateKey,
        },
        mspId: config.mspId,
        type: "X.509",
      });

      imported.push({
        orgName,
        identityAlias: config.identityAlias,
        mspId: config.mspId,
      });
    }

    await fs.writeFile(
      path.join(walletPath, "admin.id"),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          channelName: this.getChannelName(),
          connectionProfile: this.getConnectionProfilePath(),
          imported,
        },
        null,
        2
      ),
      "utf8"
    );

    return wallet;
  }

  async loadConnectionProfile(orgName = "Org1", preferredPeerNames = []) {
    const raw = await fs.readFile(this.getConnectionProfilePath(), "utf8");
    const profile = JSON.parse(raw);
    const explicitHostOverride = this.getConfiguredHostOverride();
    const resolvedHostOverride = explicitHostOverride || await this.resolveHostOverride();
    const profileHasLoopback = profileUsesLoopback(profile);
    const hostOverride =
      explicitHostOverride || profileHasLoopback
        ? resolvedHostOverride
        : null;

    profile.client = profile.client || {};
    profile.client.organization = orgName;

    const primaryOrderer = "orderer.example.com";
    profile.orderers = profile.orderers?.[primaryOrderer]
      ? { [primaryOrderer]: profile.orderers[primaryOrderer] }
      : (profile.orderers || {});

    for (const [peerName, peer] of Object.entries(profile.peers || {})) {
      if (hostOverride) {
        peer.url = replaceUrlHost(peer.url, hostOverride);
      }

      const tlsPath = PEER_TLS_PATHS[peerName];
      if (tlsPath) {
        peer.tlsCACerts = {
          pem: await fs.readFile(resolveWorkspacePath(tlsPath), "utf8"),
        };
      }

      peer.grpcOptions = {
        ...(peer.grpcOptions || {}),
        "ssl-target-name-override": peerName,
        hostnameOverride: peerName,
      };
    }

    for (const [ordererName, orderer] of Object.entries(profile.orderers || {})) {
      if (hostOverride) {
        orderer.url = replaceUrlHost(orderer.url, hostOverride);
      }

      const tlsPath = ORDERER_TLS_PATHS[ordererName];
      if (tlsPath) {
        orderer.tlsCACerts = {
          pem: await fs.readFile(resolveWorkspacePath(tlsPath), "utf8"),
        };
      }

      orderer.grpcOptions = {
        ...(orderer.grpcOptions || {}),
        "ssl-target-name-override": ordererName,
        hostnameOverride: ordererName,
      };
    }

    if (preferredPeerNames.length > 0 && profile.peers) {
      const preferred = [];
      const remaining = [];

      for (const entry of Object.entries(profile.peers)) {
        if (preferredPeerNames.includes(entry[0])) {
          preferred.push(entry);
        } else {
          remaining.push(entry);
        }
      }

      profile.peers = Object.fromEntries([...preferred, ...remaining]);
    }

    for (const organization of Object.values(profile.organizations || {})) {
      if (organization.peers) {
        const knownPeers = organization.peers.filter((peerName) =>
          Object.prototype.hasOwnProperty.call(profile.peers || {}, peerName)
        );

        if (preferredPeerNames.length > 0) {
          const prioritized = [
            ...knownPeers.filter((peerName) => preferredPeerNames.includes(peerName)),
            ...knownPeers.filter((peerName) => !preferredPeerNames.includes(peerName)),
          ];
          organization.peers = prioritized;
        } else {
          organization.peers = knownPeers;
        }
      }

      if (organization.orderers) {
        organization.orderers = organization.orderers.filter((ordererName) =>
          Object.prototype.hasOwnProperty.call(profile.orderers || {}, ordererName)
        );
      }
    }

    Object.defineProperty(profile, "__hostOverride", {
      value: hostOverride,
      enumerable: false,
      configurable: true,
    });

    return profile;
  }

  async withContract(chaincodeName, nodeId, operation) {
    const { node, orgName, orgConfig } = this.getNodeContext(nodeId);
    const [wallet, profile] = await Promise.all([
      this.ensureWallet(),
      this.loadConnectionProfile(orgName, node?.peerName ? [node.peerName] : []),
    ]);

    const gateway = new Gateway();

    try {
      await gateway.connect(profile, {
        wallet,
        identity: orgConfig.identityAlias,
        discovery: this.getDiscoveryOptions(),
      });

      const network = await gateway.getNetwork(this.getChannelName());
      const contract = network.getContract(chaincodeName);
      return await operation(contract);
    } finally {
      gateway.disconnect();
    }
  }

  async probeConnection(nodeId = "LRO_NODE_1") {
    return this.withContract(this.getVotingChaincodeName(), nodeId, async () => true);
  }

  parseResponse(buffer) {
    if (!buffer) return null;
    const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
    const json = safeParseJson(text);
    return json ?? text;
  }

  async evaluate(chaincodeName, transactionName, args = [], nodeId = "LRO_NODE_1") {
    return this.withContract(chaincodeName, nodeId, async (contract) => {
      const payload = await contract.evaluateTransaction(transactionName, ...args.map(String));
      return this.parseResponse(payload);
    });
  }

  async submit(chaincodeName, transactionName, args = [], nodeId = "LRO_NODE_1") {
    return this.withContract(chaincodeName, nodeId, async (contract) => {
      const payload = await contract.submitTransaction(transactionName, ...args.map(String));
      return this.parseResponse(payload);
    });
  }

  getSuppliedParamCount(errorMessage = "") {
    const match = String(errorMessage).match(
      /Expected\s+(\d+)\s+parameters?,\s+but\s+(\d+)\s+have\s+been\s+supplied/i
    );

    if (!match) return null;

    return {
      expected: Number(match[1]),
      supplied: Number(match[2]),
    };
  }

  getCompatibilityKey(chaincodeName, transactionName) {
    return `${chaincodeName}:${transactionName}`;
  }

  prioritizeCandidates(candidateArgsList, preferredLength = null) {
    if (!preferredLength) return candidateArgsList;

    const exact = [];
    const other = [];

    for (const args of candidateArgsList) {
      if (args.length === preferredLength) {
        exact.push(args);
      } else {
        other.push(args);
      }
    }

    return [...exact, ...other];
  }

  shouldContinueCompatibilityFallback(errorMessage = "") {
    const message = String(errorMessage || "");

    return (
      /vote must be approve or reject/i.test(message) ||
      /land record not found:\s*(approve|reject|lro_node_\d+)/i.test(message) ||
      /node\s+(approve|reject)\s+already voted/i.test(message)
    );
  }

  async submitWithCompatibility(chaincodeName, transactionName, candidateArgsList, nodeId = "LRO_NODE_1") {
    const compatibilityKey = this.getCompatibilityKey(chaincodeName, transactionName);
    let preferredLength = this.txParamCountHints.get(compatibilityKey) || null;
    const candidates = this.prioritizeCandidates(candidateArgsList, preferredLength);
    let lastError = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const args = candidates[index];

      if (preferredLength && args.length !== preferredLength) {
        continue;
      }

      try {
        const result = await this.submit(chaincodeName, transactionName, args, nodeId);
        this.txParamCountHints.set(compatibilityKey, args.length);
        return result;
      } catch (error) {
        lastError = error;
        const mismatch = this.getSuppliedParamCount(error?.message);
        const hasFallback = index < candidates.length - 1;

        if (mismatch && hasFallback) {
          preferredLength = mismatch.expected;
          this.txParamCountHints.set(compatibilityKey, mismatch.expected);
          continue;
        }

        if (this.shouldContinueCompatibilityFallback(error?.message) && hasFallback) {
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }

  async queryLandRecord(propertyId, nodeId = "LRO_NODE_1") {
    return this.evaluate(this.getVotingChaincodeName(), "queryLandRecord", [propertyId], nodeId);
  }

  async submitLandRecord(
    propertyId,
    propertyHash,
    payload = {},
    submittedByNode = "",
    submittedByUserId = "",
    nodeId = "LRO_NODE_1"
  ) {
    return this.submit(
      this.getVotingChaincodeName(),
      "submitLandRecord",
      [propertyId, propertyHash],
      nodeId
    );
  }

  async castLandRecordVote(
    propertyId,
    voteNodeId,
    vote,
    reason = "",
    voterUserId = "",
    nodeId = "LRO_NODE_1"
  ) {
    return this.submit(
      this.getVotingChaincodeName(),
      "castVote",
      [propertyId, voteNodeId, vote],
      nodeId
    );
  }

  async finalizeLandRecord(propertyId, dcUserId = "", finalHash = "", nodeId = "LRO_NODE_1") {
    return this.submit(
      this.getVotingChaincodeName(),
      "finalizeLandRecord",
      [propertyId],
      nodeId
    );
  }

  async queryAgreement(channelId, nodeId = "LRO_NODE_1") {
    return this.evaluate(this.getAgreementChaincodeName(), "getAgreement", [channelId], nodeId);
  }

  async upsertAgreement(channelId, payload = {}, nodeId = "LRO_NODE_1") {
    return this.submitWithCompatibility(
      this.getAgreementChaincodeName(),
      "upsertAgreement",
      [
        [channelId, JSON.stringify(payload || {})],
        [channelId],
      ],
      nodeId
    );
  }

  async castAgreementVote(
    channelId,
    voteNodeId,
    vote,
    reason = "",
    voterUserId = "",
    nodeId = "LRO_NODE_1"
  ) {
    return this.submit(
      this.getAgreementChaincodeName(),
      "castAgreementVote",
      [channelId, voteNodeId, vote],
      nodeId
    );
  }

  async finalizeAgreement(channelId, dcUserId = "", nodeId = "LRO_NODE_1") {
    return this.submit(
      this.getAgreementChaincodeName(),
      "finalizeAgreement",
      [channelId],
      nodeId
    );
  }

  async querySuccessionCase(successionRequestId, nodeId = "LRO_NODE_1") {
    return this.evaluate(
      this.getAgreementChaincodeName(),
      "getSuccessionCase",
      [successionRequestId],
      nodeId
    );
  }

  async submitSuccessionCase(successionRequestId, payload = {}, nodeId = "LRO_NODE_1") {
    return this.submitWithCompatibility(
      this.getAgreementChaincodeName(),
      "submitSuccessionCase",
      [
        [successionRequestId, JSON.stringify(payload || {})],
        [successionRequestId],
      ],
      nodeId
    );
  }

  async castSuccessionVote(
    successionRequestId,
    voteNodeId,
    vote,
    reason = "",
    voterUserId = "",
    nodeId = "LRO_NODE_1"
  ) {
    return this.submit(
      this.getAgreementChaincodeName(),
      "castSuccessionVote",
      [successionRequestId, voteNodeId, vote],
      nodeId
    );
  }

  async finalizeSuccessionCase(successionRequestId, dcUserId = "", nodeId = "LRO_NODE_1") {
    return this.submit(
      this.getAgreementChaincodeName(),
      "finalizeSuccessionCase",
      [successionRequestId],
      nodeId
    );
  }

  isRecordFound(payload) {
    if (!payload) return false;

    if (typeof payload === "string") {
      const normalized = payload.trim().toLowerCase();
      return normalized !== "" && normalized !== "null" && normalized !== "{}";
    }

    if (typeof payload.found === "boolean") return payload.found;
    if (typeof payload.exists === "boolean") return payload.exists;
    if (typeof payload.success === "boolean" && payload.success === false) return false;

    return Object.keys(payload).length > 0;
  }

  extractRecordHash(payload) {
    if (!payload || typeof payload !== "object") return null;

    const candidates = [
      "propertyHash",
      "property_hash",
      "currentHash",
      "current_hash",
      "recordHash",
      "record_hash",
      "hash",
      "blockHash",
      "block_hash",
    ];

    for (const key of candidates) {
      if (payload[key]) return String(payload[key]);
    }

    for (const value of Object.values(payload)) {
      if (value && typeof value === "object") {
        const nested = this.extractRecordHash(value);
        if (nested) return nested;
      }
    }

    return null;
  }

  async getStatus() {
    let profileLoaded = false;
    let walletReady = false;
    let error = null;
    let effectiveHostOverride = null;

    try {
      const profile = await this.loadConnectionProfile("Org1");
      profileLoaded = true;
      effectiveHostOverride = profile?.__hostOverride || null;
      await this.ensureWallet();
      walletReady = true;
    } catch (gatewayError) {
      error = gatewayError.message;
    }

    return {
      channelName: this.getChannelName(),
      votingChaincode: this.getVotingChaincodeName(),
      agreementChaincode: this.getAgreementChaincodeName(),
      connectionProfile: this.getConnectionProfilePath(),
      walletPath: this.getWalletPath(),
      hostOverride: effectiveHostOverride,
      detectedHostOverride: await this.resolveHostOverride(),
      discovery: this.getDiscoveryOptions(),
      profileLoaded,
      walletReady,
      error,
    };
  }
}

export default new FabricGatewayService();
