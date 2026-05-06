import pool from "../config/db.js";
import fabricClient from "./fabricClient.js";
import fabricGatewayService from "./fabricGateway.service.js";
import propertyRegistryIntegrityService from "./propertyRegistryIntegrity.service.js";
import crypto from "crypto";
import PLRA_NODES from "../config/plraNodes.js";

class FabricPLRAService {
  async getNetworkStatus() {
    const [reachability, gateway] = await Promise.all([
      fabricClient.getStatus("plra-ha"),
      fabricGatewayService.getStatus(),
    ]);

    return {
      ...reachability,
      gateway,
    };
  }

  async listNodes() {
    const status = await this.getNetworkStatus();
    return status.peers || [];
  }

  buildVotingTopology() {
    const nodes = PLRA_NODES.map((node) => ({
      nodeId: node.nodeId,
      userId: node.userId,
      email: node.email,
      city: node.city,
      organization: node.organization,
      peerName: node.peerName,
      peerUrl: node.peerUrl,
    }));

    return {
      nodeCount: nodes.length,
      voteThreshold: 3,
      nodes,
      registrationVoting: {
        chaincode: process.env.FABRIC_VOTING_CHAINCODE || "voting",
        routeBase: "/api/registration-voting",
        sameNodes: nodes.map((node) => node.nodeId),
      },
      transferVoting: {
        chaincode: process.env.FABRIC_AGREEMENT_CHAINCODE || "land-agreement",
        routeBase: "/api/transfer-voting",
        sameNodes: nodes.map((node) => node.nodeId),
      },
    };
  }

  async getConnectivityProof() {
    const networkStatus = await this.getNetworkStatus();

    const proof = {
      connected: false,
      sameVotingNodesForRegistryAndTransfer: true,
      topology: this.buildVotingTopology(),
      network: networkStatus,
      probes: {
        registrationQuery: { ok: false, error: null, result: null },
        transferQuery: { ok: false, error: null, result: null },
        successionQuery: { ok: false, error: null, result: null },
      },
    };

    try {
      const result = await fabricGatewayService.queryLandRecord("__fabric_probe_property__", "LRO_NODE_1");
      proof.probes.registrationQuery = {
        ok: true,
        error: null,
        result,
      };
    } catch (error) {
      proof.probes.registrationQuery = {
        ok: false,
        error: error.message,
        result: null,
      };
    }

    try {
      const result = await fabricGatewayService.queryAgreement("__fabric_probe_channel__", "LRO_NODE_1");
      proof.probes.transferQuery = {
        ok: true,
        error: null,
        result,
      };
    } catch (error) {
      proof.probes.transferQuery = {
        ok: false,
        error: error.message,
        result: null,
      };
    }

    try {
      const result = await fabricGatewayService.querySuccessionCase("__fabric_probe_succession__", "LRO_NODE_1");
      proof.probes.successionQuery = {
        ok: true,
        error: null,
        result,
      };
    } catch (error) {
      proof.probes.successionQuery = {
        ok: false,
        error: error.message,
        result: null,
      };
    }

    proof.connected =
      Boolean(networkStatus?.anyPeerReachable) &&
      Boolean(networkStatus?.anyOrdererReachable) &&
      Boolean(proof.probes.registrationQuery.ok) &&
      Boolean(proof.probes.transferQuery.ok);

    return proof;
  }

  async queryLandRecord(propertyId) {
    return propertyRegistryIntegrityService.verifyProperty(propertyId);
  }

  async getRegistrationCase(propertyId) {
    const result = await pool.query(
      "SELECT * FROM reg_blockchain_cases WHERE property_id = $1 LIMIT 1",
      [propertyId]
    );
    return result.rows[0] || null;
  }

  async getRegistrationVotes(propertyId) {
    const result = await pool.query(
      `SELECT property_id, lro_node_id, lro_name, lro_user_id, vote, reason, tx_id, voted_at
       FROM reg_blockchain_votes
       WHERE property_id = $1
       ORDER BY voted_at DESC`,
      [propertyId]
    );
    return result.rows;
  }

  async getVotingStatus(propertyId) {
    const [regCase, votes, integrity] = await Promise.all([
      this.getRegistrationCase(propertyId),
      this.getRegistrationVotes(propertyId),
      propertyRegistryIntegrityService.verifyProperty(propertyId),
    ]);

    const approvals = votes.filter((vote) => String(vote.vote).toUpperCase() === "APPROVE").length;
    const rejections = votes.filter((vote) => String(vote.vote).toUpperCase() === "REJECT").length;

    return {
      propertyId,
      regCase,
      votes,
      integrity,
      approvals,
      rejections,
      thresholdReached: approvals >= 3,
    };
  }

  async verifyIntegrity(propertyId) {
    return propertyRegistryIntegrityService.verifyProperty(propertyId);
  }

  async getSuccessionCase(successionRequestId) {
    const [request, heirs, events, votes, onChainCase] = await Promise.all([
      pool.query(
        "SELECT * FROM succession_requests WHERE succession_request_id = $1 LIMIT 1",
        [successionRequestId]
      ),
      pool.query(
        `SELECT *
         FROM succession_heirs
         WHERE succession_request_id = $1
         ORDER BY created_at ASC`,
        [successionRequestId]
      ),
      pool.query(
        `SELECT *
         FROM succession_events
         WHERE succession_request_id = $1
         ORDER BY created_at DESC`,
        [successionRequestId]
      ),
      pool.query(
        `SELECT *
         FROM succession_votes
         WHERE succession_request_id = $1
         ORDER BY created_at DESC`,
        [successionRequestId]
      ),
      fabricGatewayService.querySuccessionCase(successionRequestId).catch(() => null),
    ]);

    const row = request.rows[0] || null;
    if (!row) return null;

    return {
      request: row,
      heirs: heirs.rows,
      events: events.rows,
      votes: votes.rows,
      onChainCase,
    };
  }

  async getAgreement(channelId, nodeId = "LRO_NODE_1") {
    return fabricGatewayService.queryAgreement(channelId, nodeId);
  }

  createSyntheticTxId(seed) {
    return crypto.createHash("sha256").update(String(seed)).digest("hex");
  }
}

export default new FabricPLRAService();
