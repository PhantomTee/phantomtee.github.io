// ─────────────────────────────────────────────────────────────────────────────
// Lovelace — Mantle Sepolia Frontend
// Update CONTRACT_ADDRESS after deploying Lovelace.sol
// ─────────────────────────────────────────────────────────────────────────────

const CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000000"; // TODO: replace after deploy

const MANTLE_SEPOLIA = {
  chainId: "0x138B",       // 5003 in hex
  chainName: "Mantle Sepolia Testnet",
  nativeCurrency: { name: "MNT", symbol: "MNT", decimals: 18 },
  rpcUrls: ["https://rpc.sepolia.mantle.xyz"],
  blockExplorerUrls: ["https://explorer.sepolia.mantle.xyz"]
};

const ABI = [
  // View
  "function getAgent(address owner) view returns (tuple(address owner,string name,string description,uint16 capabilities,uint256 priceWei,bool isActive,uint256 ratingSum,uint32 ratingCount,uint32 jobsCompleted,uint256 createdAt,uint256 jobNonce,uint256 stakeAmount,bool exists))",
  "function getJob(uint256 jobId) view returns (tuple(address client,address agent,uint256 escrowAmount,uint8 status,string description,string resultUri,uint256 parentJobId,uint8 activeChildren,uint256 autoReleaseAt,uint256 disputedAt,uint256 createdAt,uint256 completedAt,address tokenMint,address arbiter,uint16 arbiterFeeBps,bool exists))",
  "function jobCounter() view returns (uint256)",
  "function MIN_STAKE() view returns (uint256)",
  // Write
  "function registerAgent(string name,string description,uint16 capabilities,uint256 priceWei) payable",
  "function updateAgent(string name,string description,uint16 capabilities,uint256 priceWei,bool isActive)",
  "function stakeAgent() payable",
  "function unstakeAgent(uint256 amount)",
  "function invokeAgent(address agentOwner,string description,uint256 autoReleaseDelay,address arbiter,uint16 arbiterFeeBps) payable returns (uint256)",
  "function updateJob(uint256 jobId,string resultUri)",
  "function rejectJob(uint256 jobId)",
  "function closeJob(uint256 jobId)",
  "function cancelJob(uint256 jobId)",
  "function releasePayment(uint256 jobId)",
  "function autoRelease(uint256 jobId)",
  "function delegateTask(uint256 parentJobId,address subAgentOwner,string description) payable returns (uint256)",
  "function raiseDispute(uint256 jobId)",
  "function resolveDisputeByTimeout(uint256 jobId)",
  "function rateAgent(uint256 jobId,uint8 score)",
  // Events
  "event AgentRegistered(address indexed owner,string name,uint16 capabilities,uint256 priceWei)",
  "event AgentUpdated(address indexed owner,bool isActive)",
  "event AgentStaked(address indexed owner,uint256 amount,uint256 total)",
  "event AgentUnstaked(address indexed owner,uint256 amount,uint256 remaining)",
  "event JobCreated(uint256 indexed jobId,address indexed client,address indexed agent,uint256 escrow)",
  "event JobUpdated(uint256 indexed jobId,string resultUri)",
  "event JobRejected(uint256 indexed jobId,address agent)",
  "event JobClosed(uint256 indexed jobId)",
  "event JobCancelled(uint256 indexed jobId,address client)",
  "event PaymentReleased(uint256 indexed jobId,address indexed agent,uint256 amount)",
  "event AutoReleased(uint256 indexed jobId,uint256 amount)",
  "event TaskDelegated(uint256 indexed parentJobId,uint256 indexed childJobId,address subAgent)",
  "event DisputeRaised(uint256 indexed jobId,address raisedBy)",
  "event DisputeResolvedByTimeout(uint256 indexed jobId,address client,uint256 refund)",
  "event DisputeResolvedByArbiter(uint256 indexed jobId,address arbiter,uint256 clientShare,uint256 agentShare)",
  "event AgentRated(uint256 indexed jobId,address indexed client,address indexed agent,uint8 score)"
];

const JOB_STATUS = ["Pending", "InProgress", "Completed", "Disputed", "Cancelled", "Finalized"];
const CAP_NAMES  = { 1:"General", 2:"Code Review", 4:"Security Audit", 8:"Data Analysis", 16:"Translation", 32:"Research", 64:"Writing", 128:"Design" };

// ─── State ───
let provider, signer, contract, account;
let allAgentAddresses = [];
let allJobs = [];
let selectedAgentForJob = null;
let selectedRating = 5;
let currentJobFilter = "all";

// ─── Init ───
document.addEventListener("DOMContentLoaded", () => {
  if (CONTRACT_ADDRESS !== "0x0000000000000000000000000000000000000000") {
    document.getElementById("contractAddrDisplay").innerHTML =
      `<a class="tx-link" href="${MANTLE_SEPOLIA.blockExplorerUrls[0]}/address/${CONTRACT_ADDRESS}" target="_blank">${CONTRACT_ADDRESS}</a>`;
  }

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", (accounts) => {
      if (accounts.length === 0) disconnectWallet();
      else { account = accounts[0]; onAccountChange(); }
    });
    window.ethereum.on("chainChanged", () => window.location.reload());
  }
});

// ─── Wallet ───
async function connectWallet() {
  if (!window.ethereum) {
    showToast("MetaMask not found. Please install it.", "error");
    return;
  }
  try {
    await window.ethereum.request({ method: "eth_requestAccounts" });

    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId !== MANTLE_SEPOLIA.chainId) {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: MANTLE_SEPOLIA.chainId }]
        });
      } catch (switchErr) {
        if (switchErr.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [MANTLE_SEPOLIA]
          });
        } else throw switchErr;
      }
    }

    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    account = await signer.getAddress();

    if (CONTRACT_ADDRESS !== "0x0000000000000000000000000000000000000000") {
      contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
      subscribeToEvents();
    }

    onAccountChange();
    showToast(`Connected: ${shortAddr(account)}`, "success");
  } catch (e) {
    showToast("Connection failed: " + (e.message || e), "error");
  }
}

function disconnectWallet() {
  provider = signer = contract = account = null;
  document.getElementById("connectBtn").textContent = "Connect Wallet";
  document.getElementById("noWalletJob").style.display = "block";
  document.getElementById("createJobForm").style.display = "none";
  document.getElementById("noWalletJobs").style.display = "block";
  document.getElementById("myJobsContent").style.display = "none";
  document.getElementById("logStatus").textContent = "Not connected";
}

async function onAccountChange() {
  const btn = document.getElementById("connectBtn");
  btn.textContent = shortAddr(account);
  document.getElementById("noWalletJob").style.display = "none";
  document.getElementById("createJobForm").style.display = "block";
  document.getElementById("noWalletJobs").style.display = "none";
  document.getElementById("myJobsContent").style.display = "block";
  document.getElementById("logStatus").textContent = "Listening...";

  await refreshStats();
  await checkRegistrationStatus();
  await loadAgentsForJobSelect();
  await loadMyJobs();
}

// ─── Stats ───
async function refreshStats() {
  if (!provider) return;
  try {
    const block = await provider.getBlockNumber();
    document.getElementById("statBlock").textContent = block.toLocaleString();

    if (contract) {
      const count = await contract.jobCounter();
      document.getElementById("statJobs").textContent = count.toString();
    }
  } catch (_) {}
}

// ─── Registration check ───
async function checkRegistrationStatus() {
  if (!contract || !account) return;
  try {
    const a = await contract.getAgent(account);
    if (a.exists) {
      document.getElementById("alreadyRegistered").style.display = "block";
      document.getElementById("regName").value = a.name;
      document.getElementById("regDesc").value = a.description;
      document.getElementById("regPrice").value = ethers.formatEther(a.priceWei);
    }
  } catch (_) {}
}

// ─── Agents ───
async function loadAgents() {
  if (!contract) { showToast("Connect wallet first.", "error"); return; }
  const grid = document.getElementById("agentGrid");
  grid.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    const filter = contract.filters.AgentRegistered();
    const events = await contract.queryFilter(filter, 0, "latest");
    allAgentAddresses = [...new Set(events.map(e => e.args[0]))];
    document.getElementById("statAgents").textContent = allAgentAddresses.length;

    if (allAgentAddresses.length === 0) {
      grid.innerHTML = '<div class="empty-state">No agents registered yet. Be the first!</div>';
      return;
    }

    const profiles = await Promise.all(allAgentAddresses.map(addr => contract.getAgent(addr)));
    grid.innerHTML = "";
    profiles.forEach((a, i) => {
      if (!a.exists) return;
      grid.appendChild(agentCard(a, allAgentAddresses[i], false, "agents"));
    });
  } catch (e) {
    grid.innerHTML = `<div class="empty-state">Error: ${e.message}</div>`;
  }
}

async function loadAgentsForJobSelect() {
  if (!contract) return;
  const grid = document.getElementById("agentSelectGrid");
  grid.innerHTML = '<div class="empty-state" style="font-size:0.75rem;">Loading...</div>';

  try {
    const filter = contract.filters.AgentRegistered();
    const events = await contract.queryFilter(filter, 0, "latest");
    const addrs = [...new Set(events.map(e => e.args[0]))].filter(a => a.toLowerCase() !== account.toLowerCase());

    if (addrs.length === 0) {
      grid.innerHTML = '<div class="empty-state" style="font-size:0.75rem;">No other agents found.</div>';
      return;
    }

    const profiles = await Promise.all(addrs.map(addr => contract.getAgent(addr)));
    grid.innerHTML = "";
    profiles.forEach((a, i) => {
      if (!a.exists || !a.isActive) return;
      grid.appendChild(agentCard(a, addrs[i], true, "select"));
    });
  } catch (_) {
    grid.innerHTML = '<div class="empty-state" style="font-size:0.75rem;">Error loading agents.</div>';
  }
}

function agentCard(a, addr, selectable, ctx) {
  const avgRating = a.ratingCount > 0 ? (Number(a.ratingSum) / Number(a.ratingCount)).toFixed(1) : "—";
  const stars = a.ratingCount > 0 ? "★".repeat(Math.round(Number(a.ratingSum) / Number(a.ratingCount))) : "—";
  const caps = capTags(Number(a.capabilities));

  const div = document.createElement("div");
  div.className = "agent-card" + (selectable ? "" : "");
  div.innerHTML = `
    <div class="agent-name">${escHtml(a.name)}</div>
    <div class="agent-desc">${escHtml(a.description)}</div>
    <div style="margin-bottom:8px;">${caps}</div>
    <div class="agent-meta">
      <span class="agent-price">${ethers.formatEther(a.priceWei)} MNT</span>
      <span class="stars">${stars}</span>
      <span style="color:var(--text-dim);font-size:0.68rem;">${Number(a.jobsCompleted)} jobs</span>
    </div>
    <div style="margin-top:8px;font-size:0.65rem;color:var(--text-dim);">${shortAddr(addr)}</div>
    ${!a.isActive ? '<div style="margin-top:6px;color:var(--danger);font-size:0.7rem;">⚠ Inactive</div>' : ''}
  `;

  if (selectable) {
    div.onclick = () => selectAgentForJob(addr, a.name, div);
  }

  return div;
}

function capTags(caps) {
  return Object.entries(CAP_NAMES)
    .filter(([v]) => caps & parseInt(v))
    .map(([,n]) => `<span class="cap-tag">${n}</span>`)
    .join("") || '<span style="font-size:0.7rem;color:var(--text-dim);">No capabilities set</span>';
}

function selectAgentForJob(addr, name, el) {
  document.querySelectorAll("#agentSelectGrid .agent-card").forEach(c => c.classList.remove("selected"));
  el.classList.add("selected");
  selectedAgentForJob = addr;
  document.getElementById("selectedAgent").value = addr;
  document.getElementById("selectedAgentLabel").textContent = `Selected: ${name} (${shortAddr(addr)})`;
}

// ─── Register Agent ───
async function registerAgent() {
  if (!contract) { showToast("Connect wallet first.", "error"); return; }
  const name = document.getElementById("regName").value.trim();
  const desc = document.getElementById("regDesc").value.trim();
  const price = document.getElementById("regPrice").value;
  const stake = document.getElementById("regStake").value;

  if (!name || !price || !stake) { showToast("Fill all required fields.", "error"); return; }

  const caps = getCaps();
  const priceWei = ethers.parseEther(price);
  const stakeWei = ethers.parseEther(stake);

  try {
    showToast("Sending transaction...");
    const tx = await contract.registerAgent(name, desc, caps, priceWei, { value: stakeWei });
    showToast("Waiting for confirmation...");
    await tx.wait();
    showToast(`Agent registered! Tx: ${shortAddr(tx.hash)}`, "success");
    checkRegistrationStatus();
  } catch (e) {
    showToast(parseErr(e), "error");
  }
}

async function updateAgent() {
  if (!contract) { showToast("Connect wallet first.", "error"); return; }
  const name = document.getElementById("regName").value.trim();
  const desc = document.getElementById("regDesc").value.trim();
  const price = document.getElementById("regPrice").value;
  const caps = getCaps();

  try {
    showToast("Sending update...");
    const tx = await contract.updateAgent(name, desc, caps, ethers.parseEther(price || "0"), true);
    await tx.wait();
    showToast("Agent updated!", "success");
  } catch (e) {
    showToast(parseErr(e), "error");
  }
}

async function stakeMore() {
  if (!contract) { showToast("Connect wallet first.", "error"); return; }
  const amt = document.getElementById("addStakeAmt").value;
  if (!amt) { showToast("Enter stake amount.", "error"); return; }
  try {
    const tx = await contract.stakeAgent({ value: ethers.parseEther(amt) });
    await tx.wait();
    showToast("Stake added!", "success");
  } catch (e) {
    showToast(parseErr(e), "error");
  }
}

async function unstake() {
  if (!contract) { showToast("Connect wallet first.", "error"); return; }
  const amt = document.getElementById("removeStakeAmt").value;
  if (!amt) { showToast("Enter amount to withdraw.", "error"); return; }
  try {
    const tx = await contract.unstakeAgent(ethers.parseEther(amt));
    await tx.wait();
    showToast("Stake withdrawn!", "success");
  } catch (e) {
    showToast(parseErr(e), "error");
  }
}

function getCaps() {
  let caps = 0;
  document.querySelectorAll(".cap-check:checked").forEach(cb => { caps |= parseInt(cb.value); });
  return caps;
}

// ─── Create Job ───
async function createJob() {
  if (!contract) { showToast("Connect wallet first.", "error"); return; }
  const agentAddr = document.getElementById("selectedAgent").value;
  if (!agentAddr) { showToast("Select an agent first.", "error"); return; }

  const desc    = document.getElementById("jobDesc").value.trim();
  const escrow  = document.getElementById("jobEscrow").value;
  const arHours = parseInt(document.getElementById("jobAutoRelease").value) || 0;
  const arbiter = document.getElementById("jobArbiter").value.trim() || ethers.ZeroAddress;
  const arbFee  = parseInt(document.getElementById("jobArbiterFee").value) || 0;

  if (!desc || !escrow) { showToast("Fill description and escrow amount.", "error"); return; }

  const autoReleaseDelay = arHours * 3600;
  const arbiterFeeBps = arbFee * 100;

  try {
    showToast("Creating job...");
    const tx = await contract.invokeAgent(
      agentAddr, desc, autoReleaseDelay, arbiter, arbiterFeeBps,
      { value: ethers.parseEther(escrow) }
    );
    showToast("Waiting for confirmation...");
    const receipt = await tx.wait();
    showToast(`Job created! Tx: ${shortAddr(tx.hash)}`, "success");
    loadMyJobs();
  } catch (e) {
    showToast(parseErr(e), "error");
  }
}

// ─── My Jobs ───
async function loadMyJobs() {
  if (!contract || !account) return;
  const list = document.getElementById("jobsList");
  list.innerHTML = '<div class="empty-state">Loading jobs...</div>';

  try {
    const total = Number(await contract.jobCounter());
    allJobs = [];

    const batchSize = 20;
    for (let i = 1; i <= total; i += batchSize) {
      const batch = Array.from({ length: Math.min(batchSize, total - i + 1) }, (_, k) => i + k);
      const jobs = await Promise.all(batch.map(id => contract.getJob(id).then(j => ({ id, ...j }))));
      jobs.forEach(j => {
        if (!j.exists) return;
        const addr = account.toLowerCase();
        if (j.client.toLowerCase() === addr || j.agent.toLowerCase() === addr) {
          allJobs.push(j);
        }
      });
    }

    renderJobs();
  } catch (e) {
    list.innerHTML = `<div class="empty-state">Error: ${e.message}</div>`;
  }
}

function renderJobs() {
  const list = document.getElementById("jobsList");
  let filtered = allJobs;
  if (currentJobFilter === "client") filtered = allJobs.filter(j => j.client.toLowerCase() === account.toLowerCase());
  if (currentJobFilter === "agent")  filtered = allJobs.filter(j => j.agent.toLowerCase() === account.toLowerCase());

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">No jobs found.</div>';
    return;
  }

  list.innerHTML = "";
  [...filtered].reverse().forEach(job => list.appendChild(buildJobCard(job)));
}

function filterJobs(f) {
  currentJobFilter = f;
  ["all","client","agent"].forEach(x => {
    document.getElementById("filter" + x.charAt(0).toUpperCase() + x.slice(1))
      .classList.toggle("btn-primary", x === f);
  });
  renderJobs();
}

function buildJobCard(job) {
  const isClient = job.client.toLowerCase() === account.toLowerCase();
  const isAgent  = job.agent.toLowerCase() === account.toLowerCase();
  const status = JOB_STATUS[job.status];

  const div = document.createElement("div");
  div.className = "job-card";
  div.innerHTML = `
    <div class="job-header">
      <span class="job-id">Job #${job.id} • ${isClient ? "You are Client" : "You are Agent"}</span>
      <span class="status-badge status-${status}">${status}</span>
    </div>
    <div class="job-desc">${escHtml(job.description)}</div>
    ${job.resultUri ? `<div style="font-size:0.75rem;color:var(--mantle);margin-bottom:6px;">Result: <a class="tx-link" href="${escHtml(job.resultUri)}" target="_blank">${escHtml(job.resultUri)}</a></div>` : ''}
    <div class="job-meta">
      <div><div class="meta-item">Escrow</div><div class="meta-value">${ethers.formatEther(job.escrowAmount)} MNT</div></div>
      <div><div class="meta-item">Agent</div><div class="meta-value">${shortAddr(job.agent)}</div></div>
      <div><div class="meta-item">Client</div><div class="meta-value">${shortAddr(job.client)}</div></div>
    </div>
    <div class="job-actions" id="actions-${job.id}"></div>
  `;

  const actions = div.querySelector(`#actions-${job.id}`);
  buildJobActions(actions, job, isClient, isAgent, status);
  return div;
}

function buildJobActions(el, job, isClient, isAgent, status) {
  const btn = (label, cls, fn) => {
    const b = document.createElement("button");
    b.className = `btn ${cls} btn-sm`;
    b.textContent = label;
    b.onclick = fn;
    el.appendChild(b);
  };

  if (isAgent && status === "Pending") {
    btn("Submit Result", "btn-accent", () => openSubmitResult(job.id));
    btn("Reject Job", "btn-danger", () => rejectJob(job.id));
  }
  if (isAgent && status === "InProgress") {
    btn("Submit Result", "btn-accent", () => openSubmitResult(job.id));
    btn("Close Job", "btn-primary", () => closeJob(job.id));
    btn("Delegate Sub-Task", "btn-secondary", () => openDelegate(job.id));
  }
  if (isClient && status === "Pending") {
    btn("Cancel Job", "btn-danger", () => cancelJob(job.id));
  }
  if (isClient && status === "Completed") {
    btn("Release Payment", "btn-primary", () => releasePayment(job.id));
    btn("Raise Dispute", "btn-danger", () => raiseDispute(job.id));
  }
  if (status === "Completed" && job.autoReleaseAt > 0 && Date.now() / 1000 >= Number(job.autoReleaseAt)) {
    btn("Auto-Release", "btn-secondary", () => autoRelease(job.id));
  }
  if (status === "Disputed" && job.arbiter === ethers.ZeroAddress &&
      Date.now() / 1000 >= Number(job.disputedAt) + 7 * 86400) {
    btn("Resolve by Timeout", "btn-secondary", () => resolveDisputeByTimeout(job.id));
  }
  if (isClient && status === "Finalized") {
    btn("Rate Agent", "btn-accent", () => openRate(job.id));
  }
}

// ─── Job Actions ───
async function rejectJob(jobId) {
  await contractCall(() => contract.rejectJob(jobId), `Job #${jobId} rejected.`);
}
async function closeJob(jobId) {
  await contractCall(() => contract.closeJob(jobId), `Job #${jobId} closed as completed.`);
}
async function cancelJob(jobId) {
  await contractCall(() => contract.cancelJob(jobId), `Job #${jobId} cancelled. Escrow refunded.`);
}
async function releasePayment(jobId) {
  await contractCall(() => contract.releasePayment(jobId), `Payment released for job #${jobId}.`);
}
async function autoRelease(jobId) {
  await contractCall(() => contract.autoRelease(jobId), `Auto-released job #${jobId}.`);
}
async function raiseDispute(jobId) {
  await contractCall(() => contract.raiseDispute(jobId), `Dispute raised for job #${jobId}.`);
}
async function resolveDisputeByTimeout(jobId) {
  await contractCall(() => contract.resolveDisputeByTimeout(jobId), `Dispute resolved by timeout for job #${jobId}.`);
}

async function contractCall(fn, successMsg) {
  try {
    showToast("Sending transaction...");
    const tx = await fn();
    await tx.wait();
    showToast(successMsg, "success");
    loadMyJobs();
  } catch (e) {
    showToast(parseErr(e), "error");
  }
}

// ─── Submit Result Modal ───
function openSubmitResult(jobId) {
  document.getElementById("resultJobId").value = jobId;
  document.getElementById("resultUriInput").value = "";
  openModal("submitResultModal");
}

async function submitResult() {
  const jobId = document.getElementById("resultJobId").value;
  const uri   = document.getElementById("resultUriInput").value.trim();
  if (!uri) { showToast("Enter a result URI.", "error"); return; }
  closeModal("submitResultModal");
  await contractCall(() => contract.updateJob(jobId, uri), `Result submitted for job #${jobId}.`);
}

// ─── Delegate Modal ───
function openDelegate(jobId) {
  document.getElementById("delegateParentId").value = jobId;
  document.getElementById("delegateSubAgent").value = "";
  document.getElementById("delegateDesc").value = "";
  document.getElementById("delegateEscrow").value = "";
  openModal("delegateModal");
}

async function delegateTask() {
  const parentId  = document.getElementById("delegateParentId").value;
  const subAgent  = document.getElementById("delegateSubAgent").value.trim();
  const desc      = document.getElementById("delegateDesc").value.trim();
  const escrow    = document.getElementById("delegateEscrow").value;
  if (!subAgent || !desc || !escrow) { showToast("Fill all fields.", "error"); return; }
  closeModal("delegateModal");
  try {
    showToast("Delegating task...");
    const tx = await contract.delegateTask(parentId, subAgent, desc, { value: ethers.parseEther(escrow) });
    await tx.wait();
    showToast(`Task delegated! Sub-job created.`, "success");
    loadMyJobs();
  } catch (e) {
    showToast(parseErr(e), "error");
  }
}

// ─── Rate Modal ───
function openRate(jobId) {
  document.getElementById("rateJobId").value = jobId;
  selectStar(5);
  openModal("rateModal");
}

function selectStar(val) {
  selectedRating = val;
  document.getElementById("rateScore").value = val;
  document.querySelectorAll(".star-btn").forEach(b => {
    b.classList.toggle("btn-primary", parseInt(b.dataset.val) === val);
    b.classList.toggle("btn-secondary", parseInt(b.dataset.val) !== val);
  });
}

async function submitRating() {
  const jobId = document.getElementById("rateJobId").value;
  const score = selectedRating;
  closeModal("rateModal");
  await contractCall(() => contract.rateAgent(jobId, score), `Agent rated ${score}/5 for job #${jobId}!`);
}

// ─── Event Subscriptions ───
function subscribeToEvents() {
  if (!contract) return;
  const log = document.getElementById("eventLog");

  const addLog = (eventName, detail) => {
    const entry = document.createElement("div");
    entry.className = "log-entry";
    const now = new Date().toTimeString().slice(0, 8);
    entry.innerHTML = `
      <span class="log-time">${now}</span>
      <span class="log-event">${eventName}</span>
      <span class="log-detail">${detail}</span>
    `;
    log.insertBefore(entry, log.firstChild);
    if (log.children.length > 100) log.removeChild(log.lastChild);
  };

  contract.on("AgentRegistered", (owner, name, caps, price) => {
    addLog("AgentRegistered", `${shortAddr(owner)} — ${name}`);
    refreshStats();
  });
  contract.on("JobCreated", (jobId, client, agent, escrow) => {
    addLog("JobCreated", `#${jobId} Client:${shortAddr(client)} Agent:${shortAddr(agent)} ${ethers.formatEther(escrow)} MNT`);
    refreshStats();
  });
  contract.on("PaymentReleased", (jobId, agent, amount) => {
    addLog("PaymentReleased", `#${jobId} → ${shortAddr(agent)}: ${ethers.formatEther(amount)} MNT`);
  });
  contract.on("JobClosed", (jobId) => {
    addLog("JobClosed", `#${jobId} marked Completed`);
  });
  contract.on("DisputeRaised", (jobId, by) => {
    addLog("DisputeRaised", `#${jobId} by ${shortAddr(by)}`);
  });
  contract.on("TaskDelegated", (parent, child, subAgent) => {
    addLog("TaskDelegated", `Parent #${parent} → Child #${child} → ${shortAddr(subAgent)}`);
  });
  contract.on("AgentRated", (jobId, client, agent, score) => {
    addLog("AgentRated", `#${jobId}: ${shortAddr(agent)} rated ${score}/5 by ${shortAddr(client)}`);
  });
  contract.on("AutoReleased", (jobId, amount) => {
    addLog("AutoReleased", `#${jobId}: ${ethers.formatEther(amount)} MNT auto-released`);
  });
}

function clearLog() {
  document.getElementById("eventLog").innerHTML =
    '<div class="log-entry"><span class="log-time">--:--:--</span><span class="log-event">SYSTEM</span><span class="log-detail">Log cleared.</span></div>';
}

// ─── Tabs ───
function showTab(name) {
  document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  event.target.classList.add("active");

  if (name === "agents") loadAgents();
  if (name === "my-jobs") loadMyJobs();
  if (name === "create-job") loadAgentsForJobSelect();
}

// ─── Modals ───
function openModal(id) { document.getElementById(id).classList.add("open"); }
function closeModal(id) { document.getElementById(id).classList.remove("open"); }

document.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal-overlay")) e.target.classList.remove("open");
});

// ─── Toast ───
let toastTimer;
function showToast(msg, type = "info") {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  clearTimeout(toastTimer);
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  toastTimer = setTimeout(() => t.remove(), 4000);
}

// ─── Helpers ───
function shortAddr(addr) {
  if (!addr) return "—";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function escHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseErr(e) {
  const msg = e?.reason || e?.data?.message || e?.message || "Unknown error";
  if (msg.includes("user rejected")) return "Transaction rejected.";
  return msg.length > 120 ? msg.slice(0, 120) + "..." : msg;
}
