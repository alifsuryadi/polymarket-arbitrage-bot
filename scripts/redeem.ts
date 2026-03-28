/**
 * Standalone redemption script — test auto-redeem without the bot running.
 *
 * Usage:
 *   npm run redeem -- --conditionId=0xABC...  [--proxy]
 *
 * Flags:
 *   --conditionId=<hex>   The market condition ID to redeem (required)
 *   --proxy               Route call through ProxyWalletFactory (use when PROXY_WALLET_ADDRESS is set)
 *   --dry                 Only check resolution status, don't submit tx
 *
 * The script reads PRIVATE_KEY, PROXY_WALLET_ADDRESS, SIGNATURE_TYPE from .env
 */
import "dotenv/config";
import { ethers } from "ethers";

const RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const POLYGON_NETWORK = { chainId: 137, name: "matic" };
const CTF_CONTRACT = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PROXY_WALLET_FACTORY = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052";

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
  "function payoutDenominator(bytes32 conditionId) external view returns (uint256)",
  "function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256)",
  "function balanceOf(address account, uint256 id) external view returns (uint256)",
  "function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external view returns (bytes32)",
];

const FACTORY_ABI = [
  "function proxy(tuple(uint8 typeCode, address to, uint256 value, bytes data)[] calls) external payable returns (bytes[] memory)",
];

function parseArgs() {
  const args = process.argv.slice(2);
  let conditionId: string | undefined;
  let useProxy = false;
  let dryRun = false;
  for (const arg of args) {
    if (arg.startsWith("--conditionId=")) conditionId = arg.split("=")[1];
    if (arg === "--proxy") useProxy = true;
    if (arg === "--dry") dryRun = true;
  }
  return { conditionId, useProxy, dryRun };
}

async function main() {
  const { conditionId, useProxy, dryRun } = parseArgs();

  const pk = process.env.PRIVATE_KEY;
  const proxyWalletAddress = process.env.PROXY_WALLET_ADDRESS;

  if (!pk) {
    console.error("❌ PRIVATE_KEY not set in .env");
    process.exit(1);
  }
  if (!conditionId) {
    console.error("❌ --conditionId=<hex> is required");
    console.error("   Example: npm run redeem -- --conditionId=0xabc123...");
    process.exit(1);
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(RPC_URL, POLYGON_NETWORK);
  const wallet = new ethers.Wallet(pk, provider);
  const eoaAddress = await wallet.getAddress();

  const conditionIdBytes32 =
    "0x" +
    (conditionId.startsWith("0x") ? conditionId.slice(2) : conditionId)
      .padStart(64, "0")
      .toLowerCase();
  const parentCollectionId = "0x" + "0".repeat(64);

  const ctfContract = new ethers.Contract(CTF_CONTRACT, CTF_ABI, provider);

  console.log("=== Polymarket Redemption Check ===");
  console.log(`EOA:          ${eoaAddress}`);
  if (proxyWalletAddress) console.log(`Proxy Wallet: ${proxyWalletAddress}`);
  console.log(`Condition ID: ${conditionIdBytes32}`);
  console.log("");

  // 1. Check on-chain resolution
  const denom = await ctfContract.payoutDenominator(conditionIdBytes32);
  console.log(`payoutDenominator: ${denom.toString()}`);
  if (denom.eq(0)) {
    console.log("❌ CTF condition NOT resolved on-chain yet (payoutDenominator = 0)");
    console.log("   Wait for the UMA oracle challenge period to complete (~2h), then retry.");
    process.exit(0);
  }

  // 2. Check payout numerators
  const num0 = await ctfContract.payoutNumerators(conditionIdBytes32, 0);
  const num1 = await ctfContract.payoutNumerators(conditionIdBytes32, 1);
  console.log(`Payout numerators: [${num0.toString()}, ${num1.toString()}]  (denominator: ${denom.toString()})`);
  console.log(`Winner: ${num0.gt(0) ? "Outcome 0 (Down/No)" : "Outcome 1 (Up/Yes)"}`);
  console.log("");

  // 3. Check token balances in EOA and proxy wallet
  async function checkBalance(label: string, address: string) {
    for (const [indexSet, outcomeName] of [[1, "Down/No"], [2, "Up/Yes"]] as const) {
      const collectionId = await ctfContract.getCollectionId(parentCollectionId, conditionIdBytes32, indexSet);
      const positionId = await ctfContract.getPositionId(USDC_ADDRESS, collectionId);
      const bal = await ctfContract.balanceOf(address, positionId);
      console.log(`  ${label} balance [${outcomeName}] tokenId=${positionId.toHexString().slice(0, 10)}...: ${ethers.utils.formatUnits(bal, 6)} tokens`);
    }
  }

  console.log("--- Token balances ---");
  await checkBalance("EOA", eoaAddress);
  if (proxyWalletAddress) {
    await checkBalance("Proxy", proxyWalletAddress);
  }
  console.log("");

  if (dryRun) {
    console.log("--dry mode: skipping transaction");
    process.exit(0);
  }

  // 4. Submit redemption
  const ctfInterface = new ethers.utils.Interface(CTF_ABI);
  const callData = ctfInterface.encodeFunctionData("redeemPositions", [
    USDC_ADDRESS,
    parentCollectionId,
    conditionIdBytes32,
    [1, 2],
  ]);

  const txOptions = {
    gasLimit: 300000,
    maxPriorityFeePerGas: ethers.utils.parseUnits("30", "gwei"),
    maxFeePerGas: ethers.utils.parseUnits("200", "gwei"),
  };

  if (useProxy && proxyWalletAddress) {
    console.log("Submitting via ProxyWalletFactory...");
    const factory = new ethers.Contract(PROXY_WALLET_FACTORY, FACTORY_ABI, wallet);
    const tx = await factory.proxy(
      [{ typeCode: 1, to: CTF_CONTRACT, value: 0, data: callData }],
      txOptions
    );
    console.log(`Tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(receipt.status ? "✅ SUCCESS" : "❌ FAILED");
  } else {
    console.log("Submitting via EOA direct...");
    const tx = await wallet.sendTransaction({ to: CTF_CONTRACT, data: callData, value: 0, ...txOptions });
    console.log(`Tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(receipt.status ? "✅ SUCCESS" : "❌ FAILED");
  }

  console.log("Check Polygonscan for PayoutRedemption event and payout amount.");
}

main().catch((e) => {
  console.error("Error:", e.message ?? e);
  process.exit(1);
});
