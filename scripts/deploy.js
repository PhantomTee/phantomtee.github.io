const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying Lovelace with:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "MNT");

  const Lovelace = await hre.ethers.getContractFactory("Lovelace");
  const contract = await Lovelace.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("Lovelace deployed to:", address);
  console.log("Explorer:", `https://explorer.sepolia.mantle.xyz/address/${address}`);
  console.log("\nUpdate CONTRACT_ADDRESS in frontend/app.js to:", address);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
