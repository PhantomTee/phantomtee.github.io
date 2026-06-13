const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentProtocol — Full E2E", function () {
  let contract, owner, agent1, agent2, client, arbiter;
  const MIN_STAKE = ethers.parseEther("0.01");
  const JOB_PRICE = ethers.parseEther("0.05");

  beforeEach(async () => {
    [owner, agent1, agent2, client, arbiter] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("AgentProtocol");
    contract = await Factory.deploy();
  });

  // ── 1. Register Agent ──────────────────────────────────────
  it("registers an agent with stake", async () => {
    await contract.connect(agent1).registerAgent(
      "CodeBot", "Does code reviews", 6, ethers.parseEther("0.01"),
      { value: MIN_STAKE }
    );
    const a = await contract.getAgent(agent1.address);
    expect(a.name).to.equal("CodeBot");
    expect(a.isActive).to.be.true;
    expect(a.stakeAmount).to.equal(MIN_STAKE);
  });

  it("rejects duplicate registration", async () => {
    await contract.connect(agent1).registerAgent("A","B",1,0,{ value: MIN_STAKE });
    await expect(
      contract.connect(agent1).registerAgent("A","B",1,0,{ value: MIN_STAKE })
    ).to.be.revertedWith("Already registered");
  });

  it("rejects stake below minimum", async () => {
    await expect(
      contract.connect(agent1).registerAgent("A","B",1,0,{ value: ethers.parseEther("0.001") })
    ).to.be.revertedWith("Stake below minimum");
  });

  // ── 2. Stake / Unstake ────────────────────────────────────
  it("allows staking more and unstaking", async () => {
    await contract.connect(agent1).registerAgent("A","B",1,0,{ value: MIN_STAKE });
    await contract.connect(agent1).stakeAgent({ value: ethers.parseEther("0.05") });

    let a = await contract.getAgent(agent1.address);
    expect(a.stakeAmount).to.equal(ethers.parseEther("0.06"));

    await contract.connect(agent1).unstakeAgent(ethers.parseEther("0.04"));
    a = await contract.getAgent(agent1.address);
    expect(a.stakeAmount).to.equal(ethers.parseEther("0.02"));
  });

  // ── 3. Full happy path: invoke → update → close → release → rate ──
  it("happy path: job created, completed, paid, rated", async () => {
    await contract.connect(agent1).registerAgent("A","B",1,0,{ value: MIN_STAKE });

    // Create job
    const tx = await contract.connect(client).invokeAgent(
      agent1.address, "Fix my bug", 0, ethers.ZeroAddress, 0,
      { value: JOB_PRICE }
    );
    const receipt = await tx.wait();
    const jobId = 1n;

    let job = await contract.getJob(jobId);
    expect(job.status).to.equal(0n); // Pending
    expect(job.escrowAmount).to.equal(JOB_PRICE);

    // Agent submits result
    await contract.connect(agent1).updateJob(jobId, "ipfs://result-hash");
    job = await contract.getJob(jobId);
    expect(job.status).to.equal(1n); // InProgress

    // Agent closes job
    await contract.connect(agent1).closeJob(jobId);
    job = await contract.getJob(jobId);
    expect(job.status).to.equal(2n); // Completed

    // Client releases payment
    const agentBalBefore = await ethers.provider.getBalance(agent1.address);
    await contract.connect(client).releasePayment(jobId);
    const agentBalAfter = await ethers.provider.getBalance(agent1.address);
    expect(agentBalAfter - agentBalBefore).to.equal(JOB_PRICE);

    job = await contract.getJob(jobId);
    expect(job.status).to.equal(5n); // Finalized

    // Client rates agent
    await contract.connect(client).rateAgent(jobId, 5);
    const [sum, count] = await contract.getAgentRating(agent1.address);
    expect(sum).to.equal(5n);
    expect(count).to.equal(1n);
  });

  // ── 4. Cancel while pending ───────────────────────────────
  it("client can cancel a pending job and get refund", async () => {
    await contract.connect(agent1).registerAgent("A","B",1,0,{ value: MIN_STAKE });
    await contract.connect(client).invokeAgent(
      agent1.address,"task",0,ethers.ZeroAddress,0,{ value: JOB_PRICE }
    );

    const balBefore = await ethers.provider.getBalance(client.address);
    const cancelTx = await contract.connect(client).cancelJob(1n);
    const cancelReceipt = await cancelTx.wait();
    const gasUsed = cancelReceipt.gasUsed * cancelTx.gasPrice;
    const balAfter = await ethers.provider.getBalance(client.address);

    expect(balAfter + gasUsed - balBefore).to.equal(JOB_PRICE);

    const job = await contract.getJob(1n);
    expect(job.status).to.equal(4n); // Cancelled
  });

  // ── 5. Agent rejects job ─────────────────────────────────
  it("agent can reject a pending job", async () => {
    await contract.connect(agent1).registerAgent("A","B",1,0,{ value: MIN_STAKE });
    await contract.connect(client).invokeAgent(
      agent1.address,"task",0,ethers.ZeroAddress,0,{ value: JOB_PRICE }
    );
    await contract.connect(agent1).rejectJob(1n);
    const job = await contract.getJob(1n);
    expect(job.status).to.equal(4n); // Cancelled
  });

  // ── 6. Auto-release ──────────────────────────────────────
  it("auto-release works after timeout", async () => {
    await contract.connect(agent1).registerAgent("A","B",1,0,{ value: MIN_STAKE });
    await contract.connect(client).invokeAgent(
      agent1.address,"task",1,ethers.ZeroAddress,0,{ value: JOB_PRICE }
    ); // 1 second auto-release
    await contract.connect(agent1).updateJob(1n,"ipfs://x");
    await contract.connect(agent1).closeJob(1n);

    await ethers.provider.send("evm_increaseTime",[2]);
    await ethers.provider.send("evm_mine",[]);

    const balBefore = await ethers.provider.getBalance(agent1.address);
    const tx = await contract.autoRelease(1n);
    await tx.wait();
    const balAfter = await ethers.provider.getBalance(agent1.address);
    expect(balAfter).to.be.gt(balBefore);
  });

  // ── 7. Dispute → arbiter resolution ─────────────────────
  it("arbiter resolves dispute and takes fee", async () => {
    await contract.connect(agent1).registerAgent("A","B",1,0,{ value: MIN_STAKE });
    await contract.connect(client).invokeAgent(
      agent1.address,"task",0,arbiter.address,1000,{ value: JOB_PRICE }
    ); // 10% arbiter fee
    await contract.connect(agent1).updateJob(1n,"ipfs://x");
    await contract.connect(agent1).closeJob(1n);
    await contract.connect(client).raiseDispute(1n);

    const fee = JOB_PRICE * 1000n / 10000n;            // 10%
    const half = (JOB_PRICE - fee) / 2n;

    const arbBalBefore = await ethers.provider.getBalance(arbiter.address);
    await contract.connect(arbiter).resolveDisputeByArbiter(1n, half, half);
    const arbBalAfter = await ethers.provider.getBalance(arbiter.address);

    expect(arbBalAfter).to.be.gt(arbBalBefore);

    const job = await contract.getJob(1n);
    expect(job.status).to.equal(5n); // Finalized
  });

  // ── 8. Task delegation ───────────────────────────────────
  it("agent delegates sub-task to another agent", async () => {
    await contract.connect(agent1).registerAgent("A","B",1,0,{ value: MIN_STAKE });
    await contract.connect(agent2).registerAgent("C","D",2,0,{ value: MIN_STAKE });

    await contract.connect(client).invokeAgent(
      agent1.address,"parent task",0,ethers.ZeroAddress,0,{ value: JOB_PRICE }
    );

    await contract.connect(agent1).delegateTask(
      1n, agent2.address, "sub task",
      { value: ethers.parseEther("0.02") }
    );

    const childJob = await contract.getJob(2n);
    expect(childJob.agent).to.equal(agent2.address);
    expect(childJob.parentJobId).to.equal(1n);

    const parent = await contract.getJob(1n);
    expect(parent.activeChildren).to.equal(1);
  });

  // ── 9. Cannot hire yourself ──────────────────────────────
  it("blocks self-invocation", async () => {
    await contract.connect(agent1).registerAgent("A","B",1,0,{ value: MIN_STAKE });
    await expect(
      contract.connect(agent1).invokeAgent(
        agent1.address,"self task",0,ethers.ZeroAddress,0,{ value: JOB_PRICE }
      )
    ).to.be.revertedWith("Cannot hire yourself");
  });

  // ── 10. Dispute timeout ──────────────────────────────────
  it("dispute resolves by timeout after 7 days", async () => {
    await contract.connect(agent1).registerAgent("A","B",1,0,{ value: MIN_STAKE });
    await contract.connect(client).invokeAgent(
      agent1.address,"task",0,ethers.ZeroAddress,0,{ value: JOB_PRICE }
    );
    await contract.connect(agent1).updateJob(1n,"ipfs://x");
    await contract.connect(agent1).closeJob(1n);
    await contract.connect(client).raiseDispute(1n);

    await ethers.provider.send("evm_increaseTime",[7*24*3600+1]);
    await ethers.provider.send("evm_mine",[]);

    const balBefore = await ethers.provider.getBalance(client.address);
    const tx = await contract.connect(client).resolveDisputeByTimeout(1n);
    await tx.wait();
    const balAfter = await ethers.provider.getBalance(client.address);
    expect(balAfter).to.be.gt(balBefore);
  });
});
