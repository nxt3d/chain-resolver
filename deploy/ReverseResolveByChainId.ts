// Reverse-resolve a chainId to a chain name

import 'dotenv/config'
import { init } from "./libs/init.ts";
import { initSmith, shutdownSmith, loadDeployment, askQuestion } from "./libs/utils.ts";
import { Contract, Interface, AbiCoder, dnsEncode, getBytes, hexlify, isHexString } from "ethers";

const { chainId, privateKey } = await init();
const { deployerWallet, smith, rl } = await initSmith(
  typeof chainId === "number" ? chainId : Number(chainId),
  privateKey
);

try {
  // Locate ChainResolver
  let resolverAddress: string | undefined;
  try {
    const res = await loadDeployment(chainId, "ChainResolver");
    const found = res.target as string;
    const code = await deployerWallet.provider.getCode(found);
    if (code && code !== '0x') {
      resolverAddress = found;
    }
  } catch {}
  if (!resolverAddress) resolverAddress = process.env.CHAIN_RESOLVER_ADDRESS || process.env.RESOLVER_ADDRESS || "";
  if (!resolverAddress) resolverAddress = (await askQuestion(rl, "ChainResolver address: ")).trim();
  if (!resolverAddress) {
    console.error("ChainResolver address is required.");
    process.exit(1);
  }

  const resolver = new Contract(
    resolverAddress!,
    [
      "function resolve(bytes name, bytes data) view returns (bytes)",
      "function chainName(bytes) view returns (string)",
    ],
    deployerWallet
  );

  // Input chainId
  let cidIn = (await askQuestion(rl, "Chain ID (0x.. hex or decimal): ")).trim();
  if (!isHexString(cidIn)) {
    const n = BigInt(cidIn);
    // minimal bytes; hexlify will include 0x prefix
    cidIn = hexlify(n);
  }
  const chainIdBytes = getBytes(cidIn);

  // Build key for ChainResolver reverse path: 'chain-name:' + <7930 hex suffix>
  const IFACE = new Interface([
    "function text(bytes32,string) view returns (string)",
    "function data(bytes32,string) view returns (bytes)",
  ]);
  const key = 'chain-name:' + Buffer.from(chainIdBytes).toString('hex');
  const dnsName = dnsEncode("x.cid.eth", 255); // any label works; reverse uses key
  const ZERO_NODE = "0x" + "0".repeat(64);
  

  try {
    // Try hex-suffix service key only
    let textName = '';
    try {
      const tcall = IFACE.encodeFunctionData("text(bytes32,string)", [ZERO_NODE, key]);
      const tanswer: string = await resolver.resolve(dnsName, tcall);
      [textName] = IFACE.decodeFunctionResult("text(bytes32,string)", tanswer) as [string];
    } catch {}

    let dataName = '';
    try {
      const dcall = IFACE.encodeFunctionData("data(bytes32,string)", [ZERO_NODE, key]);
      const danswer: string = await resolver.resolve(dnsName, dcall);
      const [encoded] = IFACE.decodeFunctionResult("data(bytes32,string)", danswer) as [`0x${string}`];
      try { [dataName] = AbiCoder.defaultAbiCoder().decode(["string"], encoded) as [string]; }
      catch { dataName = Buffer.from((encoded as string).replace(/^0x/, ''), 'hex').toString('utf8'); }
    } catch {}

    console.log('Chain name (text):', textName);
    console.log('Chain name (data):', dataName);

    // 3) Also show the direct read path
    try {
      const direct = await resolver.chainName(chainIdBytes);
      console.log('Direct read (chainName):', direct);
    } catch {}
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} finally {
  await shutdownSmith(rl, smith);
}
