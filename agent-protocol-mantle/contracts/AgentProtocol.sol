// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title AgentProtocol
 * @notice Trustless AI agent payment protocol on Mantle Network.
 *         Port of marchantdev/agent-protocol (Solana) to EVM.
 *
 * Flow:
 *   1. Agent calls registerAgent() with MNT stake
 *   2. Client calls invokeAgent() with MNT escrow
 *   3. Agent calls updateJob() then closeJob()
 *   4. Client calls releasePayment() — or auto-release after timeout
 *   5. Client calls rateAgent() after finalization
 */
contract AgentProtocol is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────

    uint256 public constant MIN_STAKE = 0.01 ether;
    uint256 public constant DISPUTE_TIMEOUT = 7 days;
    uint256 public constant AUTO_RELEASE_MAX = 30 days;
    uint8 public constant MAX_ACTIVE_CHILDREN = 8;
    uint16 public constant MAX_ARBITER_FEE_BPS = 2500; // 25%

    // ─────────────────────────────────────────────────────────────
    // Data Structures
    // ─────────────────────────────────────────────────────────────

    struct AgentProfile {
        address owner;
        string name;
        string description;
        uint16 capabilities;  // bitmask: each bit = a capability type
        uint256 priceWei;
        bool isActive;
        uint256 ratingSum;
        uint32 ratingCount;
        uint32 jobsCompleted;
        uint256 createdAt;
        uint256 jobNonce;
        uint256 stakeAmount;
        bool exists;
    }

    enum JobStatus { Pending, InProgress, Completed, Disputed, Cancelled, Finalized }

    struct Job {
        address client;
        address agent;
        uint256 escrowAmount;
        JobStatus status;
        string description;
        string resultUri;
        uint256 parentJobId;   // 0 = no parent
        uint8 activeChildren;
        uint256 autoReleaseAt; // 0 = not set
        uint256 disputedAt;    // 0 = not disputed
        uint256 createdAt;
        uint256 completedAt;   // 0 = not yet
        address tokenMint;     // address(0) = native MNT
        address arbiter;       // address(0) = none
        uint16 arbiterFeeBps;
        bool exists;
    }

    struct Rating {
        address rater;
        uint8 score;        // 1–5
        uint256 jobId;
        bool exists;
    }

    // ─────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────

    mapping(address => AgentProfile) public agents;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => Rating) public ratings;
    uint256 public jobCounter;

    // ─────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────

    event AgentRegistered(address indexed owner, string name, uint16 capabilities, uint256 priceWei);
    event AgentUpdated(address indexed owner, bool isActive);
    event AgentStaked(address indexed owner, uint256 amount, uint256 total);
    event AgentUnstaked(address indexed owner, uint256 amount, uint256 remaining);

    event JobCreated(uint256 indexed jobId, address indexed client, address indexed agent, uint256 escrow);
    event JobUpdated(uint256 indexed jobId, string resultUri);
    event JobRejected(uint256 indexed jobId, address agent);
    event JobClosed(uint256 indexed jobId);
    event JobCancelled(uint256 indexed jobId, address client);
    event PaymentReleased(uint256 indexed jobId, address indexed agent, uint256 amount);
    event AutoReleased(uint256 indexed jobId, uint256 amount);
    event TaskDelegated(uint256 indexed parentJobId, uint256 indexed childJobId, address subAgent);

    event DisputeRaised(uint256 indexed jobId, address raisedBy);
    event DisputeResolvedByTimeout(uint256 indexed jobId, address client, uint256 refund);
    event DisputeResolvedByArbiter(uint256 indexed jobId, address arbiter, uint256 clientShare, uint256 agentShare);

    event AgentRated(uint256 indexed jobId, address indexed client, address indexed agent, uint8 score);

    // ─────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────

    modifier agentExists(address owner) {
        require(agents[owner].exists, "Agent not registered");
        _;
    }

    modifier jobExists(uint256 jobId) {
        require(jobs[jobId].exists, "Job not found");
        _;
    }

    // ─────────────────────────────────────────────────────────────
    // 1. Register Agent
    // ─────────────────────────────────────────────────────────────

    function registerAgent(
        string calldata name,
        string calldata description,
        uint16 capabilities,
        uint256 priceWei
    ) external payable nonReentrant {
        require(!agents[msg.sender].exists, "Already registered");
        require(msg.value >= MIN_STAKE, "Stake below minimum");
        require(bytes(name).length > 0 && bytes(name).length <= 32, "Name: 1-32 chars");
        require(bytes(description).length <= 128, "Description: max 128 chars");

        agents[msg.sender] = AgentProfile({
            owner: msg.sender,
            name: name,
            description: description,
            capabilities: capabilities,
            priceWei: priceWei,
            isActive: true,
            ratingSum: 0,
            ratingCount: 0,
            jobsCompleted: 0,
            createdAt: block.timestamp,
            jobNonce: 0,
            stakeAmount: msg.value,
            exists: true
        });

        emit AgentRegistered(msg.sender, name, capabilities, priceWei);
        emit AgentStaked(msg.sender, msg.value, msg.value);
    }

    // ─────────────────────────────────────────────────────────────
    // 2. Update Agent
    // ─────────────────────────────────────────────────────────────

    function updateAgent(
        string calldata name,
        string calldata description,
        uint16 capabilities,
        uint256 priceWei,
        bool isActive
    ) external agentExists(msg.sender) {
        require(bytes(name).length > 0 && bytes(name).length <= 32, "Name: 1-32 chars");
        require(bytes(description).length <= 128, "Description: max 128 chars");

        AgentProfile storage agent = agents[msg.sender];
        agent.name = name;
        agent.description = description;
        agent.capabilities = capabilities;
        agent.priceWei = priceWei;
        agent.isActive = isActive;

        emit AgentUpdated(msg.sender, isActive);
    }

    // ─────────────────────────────────────────────────────────────
    // 3. Stake Agent
    // ─────────────────────────────────────────────────────────────

    function stakeAgent() external payable agentExists(msg.sender) {
        require(msg.value > 0, "Must stake > 0");
        agents[msg.sender].stakeAmount += msg.value;
        emit AgentStaked(msg.sender, msg.value, agents[msg.sender].stakeAmount);
    }

    // ─────────────────────────────────────────────────────────────
    // 4. Unstake Agent
    // ─────────────────────────────────────────────────────────────

    function unstakeAgent(uint256 amount) external nonReentrant agentExists(msg.sender) {
        AgentProfile storage agent = agents[msg.sender];
        require(amount > 0, "Must unstake > 0");
        require(agent.stakeAmount >= amount, "Insufficient stake");
        require(agent.stakeAmount - amount >= MIN_STAKE, "Must keep minimum stake");

        agent.stakeAmount -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "Transfer failed");

        emit AgentUnstaked(msg.sender, amount, agent.stakeAmount);
    }

    // ─────────────────────────────────────────────────────────────
    // 5. Invoke Agent (create job with escrow)
    // ─────────────────────────────────────────────────────────────

    function invokeAgent(
        address agentOwner,
        string calldata description,
        uint256 autoReleaseDelay,
        address arbiter,
        uint16 arbiterFeeBps
    ) external payable nonReentrant agentExists(agentOwner) returns (uint256 jobId) {
        require(agentOwner != msg.sender, "Cannot hire yourself");
        require(agents[agentOwner].isActive, "Agent not active");
        require(msg.value > 0, "Escrow must be > 0");
        require(bytes(description).length > 0 && bytes(description).length <= 256, "Desc: 1-256 chars");
        require(autoReleaseDelay == 0 || autoReleaseDelay <= AUTO_RELEASE_MAX, "Auto-release too long");
        require(arbiterFeeBps <= MAX_ARBITER_FEE_BPS, "Arbiter fee > 25%");
        if (arbiter != address(0)) {
            require(arbiter != msg.sender && arbiter != agentOwner, "Invalid arbiter");
        }

        jobId = ++jobCounter;
        agents[agentOwner].jobNonce++;

        jobs[jobId] = Job({
            client: msg.sender,
            agent: agentOwner,
            escrowAmount: msg.value,
            status: JobStatus.Pending,
            description: description,
            resultUri: "",
            parentJobId: 0,
            activeChildren: 0,
            autoReleaseAt: autoReleaseDelay > 0 ? block.timestamp + autoReleaseDelay : 0,
            disputedAt: 0,
            createdAt: block.timestamp,
            completedAt: 0,
            tokenMint: address(0),
            arbiter: arbiter,
            arbiterFeeBps: arbiterFeeBps,
            exists: true
        });

        emit JobCreated(jobId, msg.sender, agentOwner, msg.value);
    }

    // ─────────────────────────────────────────────────────────────
    // 6. Update Job (agent submits result)
    // ─────────────────────────────────────────────────────────────

    function updateJob(uint256 jobId, string calldata resultUri)
        external jobExists(jobId)
    {
        Job storage job = jobs[jobId];
        require(job.agent == msg.sender, "Not the agent");
        require(
            job.status == JobStatus.Pending || job.status == JobStatus.InProgress,
            "Job not active"
        );
        require(bytes(resultUri).length > 0 && bytes(resultUri).length <= 128, "ResultUri: 1-128 chars");

        job.status = JobStatus.InProgress;
        job.resultUri = resultUri;

        emit JobUpdated(jobId, resultUri);
    }

    // ─────────────────────────────────────────────────────────────
    // 7. Reject Job (agent refuses, refunds client)
    // ─────────────────────────────────────────────────────────────

    function rejectJob(uint256 jobId) external nonReentrant jobExists(jobId) {
        Job storage job = jobs[jobId];
        require(job.agent == msg.sender, "Not the agent");
        require(job.status == JobStatus.Pending, "Can only reject Pending jobs");

        uint256 refund = job.escrowAmount;
        job.status = JobStatus.Cancelled;
        job.escrowAmount = 0;

        (bool ok,) = job.client.call{value: refund}("");
        require(ok, "Refund failed");

        emit JobRejected(jobId, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────
    // 8. Close Job (agent marks as completed)
    // ─────────────────────────────────────────────────────────────

    function closeJob(uint256 jobId) external jobExists(jobId) {
        Job storage job = jobs[jobId];
        require(job.agent == msg.sender, "Not the agent");
        require(job.status == JobStatus.InProgress, "Job not InProgress");
        require(bytes(job.resultUri).length > 0, "No result submitted");

        job.status = JobStatus.Completed;
        job.completedAt = block.timestamp;

        emit JobClosed(jobId);
    }

    // ─────────────────────────────────────────────────────────────
    // 9. Cancel Job (client cancels while Pending)
    // ─────────────────────────────────────────────────────────────

    function cancelJob(uint256 jobId) external nonReentrant jobExists(jobId) {
        Job storage job = jobs[jobId];
        require(job.client == msg.sender, "Not the client");
        require(job.status == JobStatus.Pending, "Can only cancel Pending jobs");

        uint256 refund = job.escrowAmount;
        job.status = JobStatus.Cancelled;
        job.escrowAmount = 0;

        (bool ok,) = msg.sender.call{value: refund}("");
        require(ok, "Refund failed");

        emit JobCancelled(jobId, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────
    // 10. Release Payment (client approves completed job)
    // ─────────────────────────────────────────────────────────────

    function releasePayment(uint256 jobId) external nonReentrant jobExists(jobId) {
        Job storage job = jobs[jobId];
        require(job.client == msg.sender, "Not the client");
        require(job.status == JobStatus.Completed, "Job not Completed");

        uint256 amount = job.escrowAmount;
        job.status = JobStatus.Finalized;
        job.escrowAmount = 0;
        agents[job.agent].jobsCompleted++;

        (bool ok,) = job.agent.call{value: amount}("");
        require(ok, "Payment failed");

        emit PaymentReleased(jobId, job.agent, amount);
    }

    // ─────────────────────────────────────────────────────────────
    // 11. Auto Release (permissionless after timeout)
    // ─────────────────────────────────────────────────────────────

    function autoRelease(uint256 jobId) external nonReentrant jobExists(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Completed, "Job not Completed");
        require(job.autoReleaseAt > 0, "No auto-release set");
        require(block.timestamp >= job.autoReleaseAt, "Auto-release not yet due");

        uint256 amount = job.escrowAmount;
        job.status = JobStatus.Finalized;
        job.escrowAmount = 0;
        agents[job.agent].jobsCompleted++;

        (bool ok,) = job.agent.call{value: amount}("");
        require(ok, "Payment failed");

        emit AutoReleased(jobId, amount);
    }

    // ─────────────────────────────────────────────────────────────
    // 12. Delegate Task (agent hires sub-agent, splits escrow)
    // ─────────────────────────────────────────────────────────────

    function delegateTask(
        uint256 parentJobId,
        address subAgentOwner,
        string calldata description
    ) external payable nonReentrant jobExists(parentJobId) agentExists(subAgentOwner) returns (uint256 childJobId) {
        Job storage parent = jobs[parentJobId];
        require(parent.agent == msg.sender, "Not the parent agent");
        require(
            parent.status == JobStatus.Pending || parent.status == JobStatus.InProgress,
            "Parent job not active"
        );
        require(parent.activeChildren < MAX_ACTIVE_CHILDREN, "Max children reached");
        require(subAgentOwner != msg.sender, "Cannot delegate to yourself");
        require(agents[subAgentOwner].isActive, "Sub-agent not active");
        require(msg.value > 0, "Must fund sub-job");

        parent.activeChildren++;
        parent.status = JobStatus.InProgress;

        childJobId = ++jobCounter;

        jobs[childJobId] = Job({
            client: msg.sender,
            agent: subAgentOwner,
            escrowAmount: msg.value,
            status: JobStatus.Pending,
            description: description,
            resultUri: "",
            parentJobId: parentJobId,
            activeChildren: 0,
            autoReleaseAt: 0,
            disputedAt: 0,
            createdAt: block.timestamp,
            completedAt: 0,
            tokenMint: address(0),
            arbiter: address(0),
            arbiterFeeBps: 0,
            exists: true
        });

        emit TaskDelegated(parentJobId, childJobId, subAgentOwner);
        emit JobCreated(childJobId, msg.sender, subAgentOwner, msg.value);
    }

    // ─────────────────────────────────────────────────────────────
    // 13. Raise Dispute
    // ─────────────────────────────────────────────────────────────

    function raiseDispute(uint256 jobId) external jobExists(jobId) {
        Job storage job = jobs[jobId];
        require(
            job.client == msg.sender || job.agent == msg.sender,
            "Not a party to this job"
        );
        require(job.status == JobStatus.Completed, "Can only dispute Completed jobs");

        job.status = JobStatus.Disputed;
        job.disputedAt = block.timestamp;

        emit DisputeRaised(jobId, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────
    // 14. Resolve Dispute by Timeout (7 days, refund client)
    // ─────────────────────────────────────────────────────────────

    function resolveDisputeByTimeout(uint256 jobId) external nonReentrant jobExists(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Disputed, "Not disputed");
        require(block.timestamp >= job.disputedAt + DISPUTE_TIMEOUT, "Timeout not reached");
        require(job.arbiter == address(0), "Use arbiter resolution");

        uint256 refund = job.escrowAmount;
        job.status = JobStatus.Cancelled;
        job.escrowAmount = 0;

        (bool ok,) = job.client.call{value: refund}("");
        require(ok, "Refund failed");

        emit DisputeResolvedByTimeout(jobId, job.client, refund);
    }

    // ─────────────────────────────────────────────────────────────
    // 15. Resolve Dispute by Arbiter
    // ─────────────────────────────────────────────────────────────

    function resolveDisputeByArbiter(
        uint256 jobId,
        uint256 clientShare,
        uint256 agentShare
    ) external nonReentrant jobExists(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Disputed, "Not disputed");
        require(job.arbiter == msg.sender, "Not the arbiter");

        uint256 total = job.escrowAmount;
        uint256 arbiterFee = (total * job.arbiterFeeBps) / 10_000;
        require(clientShare + agentShare + arbiterFee <= total, "Shares exceed escrow");

        job.status = JobStatus.Finalized;
        job.escrowAmount = 0;

        if (agentShare > 0) {
            agents[job.agent].jobsCompleted++;
        }

        if (clientShare > 0) {
            (bool ok1,) = job.client.call{value: clientShare}("");
            require(ok1, "Client transfer failed");
        }
        if (agentShare > 0) {
            (bool ok2,) = job.agent.call{value: agentShare}("");
            require(ok2, "Agent transfer failed");
        }
        if (arbiterFee > 0) {
            (bool ok3,) = msg.sender.call{value: arbiterFee}("");
            require(ok3, "Arbiter fee failed");
        }

        emit DisputeResolvedByArbiter(jobId, msg.sender, clientShare, agentShare);
    }

    // ─────────────────────────────────────────────────────────────
    // 16. Rate Agent (client rates 1-5 after Finalized)
    // ─────────────────────────────────────────────────────────────

    function rateAgent(uint256 jobId, uint8 score) external jobExists(jobId) {
        Job storage job = jobs[jobId];
        require(job.client == msg.sender, "Only client can rate");
        require(job.status == JobStatus.Finalized, "Job not Finalized");
        require(score >= 1 && score <= 5, "Score must be 1-5");
        require(!ratings[jobId].exists, "Already rated");

        ratings[jobId] = Rating({
            rater: msg.sender,
            score: score,
            jobId: jobId,
            exists: true
        });

        agents[job.agent].ratingSum += score;
        agents[job.agent].ratingCount++;

        emit AgentRated(jobId, msg.sender, job.agent, score);
    }

    // ─────────────────────────────────────────────────────────────
    // View Helpers
    // ─────────────────────────────────────────────────────────────

    function getAgentRating(address agentOwner) external view returns (uint256 sum, uint32 count) {
        AgentProfile storage a = agents[agentOwner];
        return (a.ratingSum, a.ratingCount);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    function getAgent(address owner) external view returns (AgentProfile memory) {
        return agents[owner];
    }

    receive() external payable {}
}
