import fs from "fs/promises";
import net from "net";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { promisify } from "util";

import PLRA_NODES from "../config/plraNodes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..", "..");
const execFileAsync = promisify(execFile);

function parseEndpoint(urlString = "") {
  try {
    const parsed = new URL(urlString);
    return {
      protocol: parsed.protocol.replace(":", ""),
      host: parsed.hostname,
      port: Number(parsed.port),
      url: urlString,
    };
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
    const endpoint = parseEndpoint(urlString);
    return endpoint ? isLoopbackHost(endpoint.host) : false;
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

function checkSocket(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (!host || !port) {
      resolve(false);
      return;
    }

    const socket = new net.Socket();
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

class FabricClientCompatibility {
  constructor() {
    this.profileCandidates = [
      { name: "plra-ha", path: path.join(backendRoot, "connection-plra.json") },
      { name: "default", path: path.join(backendRoot, "connection.json") },
    ];
    this.cachedHostOverride = undefined;
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

  async loadProfile(preferredName = null) {
    const candidate =
      this.profileCandidates.find((item) => item.name === preferredName) ||
      this.profileCandidates[0];

    for (const profile of [
      candidate,
      ...this.profileCandidates.filter((item) => item.path !== candidate.path),
    ]) {
      try {
        const raw = await fs.readFile(profile.path, "utf8");
        const parsed = JSON.parse(raw);
        const explicitHostOverride = this.getConfiguredHostOverride();
        const resolvedHostOverride = explicitHostOverride || await this.resolveHostOverride();
        const profileHasLoopback = profileUsesLoopback(parsed);
        const effectiveHostOverride =
          explicitHostOverride || profileHasLoopback
            ? resolvedHostOverride
            : null;

        if (effectiveHostOverride) {
          for (const details of Object.values(parsed.peers || {})) {
            details.url = replaceUrlHost(details.url, effectiveHostOverride);
          }

          for (const details of Object.values(parsed.orderers || {})) {
            details.url = replaceUrlHost(details.url, effectiveHostOverride);
          }
        }

        return {
          name: profile.name,
          path: profile.path,
          profile: parsed,
          hostOverride: effectiveHostOverride,
        };
      } catch (error) {
        continue;
      }
    }

    return null;
  }

  extractPeers(profile = {}) {
    return Object.entries(profile.peers || {}).map(([peerName, details]) => ({
      peerName,
      ...parseEndpoint(details.url),
      metadata: details.metadata || {},
    }));
  }

  extractOrderers(profile = {}) {
    return Object.entries(profile.orderers || {}).map(([ordererName, details]) => ({
      ordererName,
      ...parseEndpoint(details.url),
      metadata: details.metadata || {},
    }));
  }

  async getReachability(preferredName = null) {
    const loaded = await this.loadProfile(preferredName);

    if (!loaded) {
      return {
        available: false,
        profileName: null,
        profilePath: null,
        hostOverride: await this.resolveHostOverride(),
        peers: [],
        orderers: [],
        anyPeerReachable: false,
        anyOrdererReachable: false,
      };
    }

    const peers = await Promise.all(
      this.extractPeers(loaded.profile).map(async (peer) => ({
        ...peer,
        reachable: await checkSocket(peer.host, peer.port),
      }))
    );

    const orderers = await Promise.all(
      this.extractOrderers(loaded.profile).map(async (orderer) => ({
        ...orderer,
        reachable: await checkSocket(orderer.host, orderer.port),
      }))
    );

    return {
      available: true,
      profileName: loaded.name,
      profilePath: loaded.path,
      hostOverride: loaded.hostOverride || null,
      peers,
      orderers,
      anyPeerReachable: peers.some((peer) => peer.reachable),
      anyOrdererReachable: orderers.some((orderer) => orderer.reachable),
    };
  }

  async getStatus(preferredName = null) {
    const reachability = await this.getReachability(preferredName);

    return {
      ...reachability,
      mode: reachability.anyPeerReachable ? "fabric-network" : "offline",
      knownNodes: PLRA_NODES,
    };
  }
}

export default new FabricClientCompatibility();
