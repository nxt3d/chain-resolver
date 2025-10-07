// Blocksmith test for unified ChainResolver
// Usage: bun run test:blocks -- --chain=sepolia

import 'dotenv/config'
import { Foundry } from '@adraffy/blocksmith'
import { JsonRpcProvider, Wallet, Contract, Interface, dnsEncode, keccak256, toUtf8Bytes, getBytes, hexlify, AbiCoder } from 'ethers'
import { init } from '../deploy/libs/init.ts'
import { CHAIN_MAP } from '../deploy/libs/constants.ts'

async function main() {
  const { chainId, privateKey } = await init();

  const { rpc } = CHAIN_MAP.get(Number(chainId))!;
  const provider = new JsonRpcProvider(rpc);
  const wallet = new Wallet(privateKey, provider);

  const log = (...a: any[]) => console.log('[blocksmith]', ...a);
  const section = (name: string) => console.log(`\n=== ${name} ===`);
  const hex = (b: any) => {
    try { return hexlify(b); } catch { return String(b); }
  };

  section('Launch');
  log('chain', chainId, 'rpc', rpc);
  const smith = await Foundry.launchLive({ provider, forge: 'forge', infoLog: true, wallets: [wallet] });
  try {
    // 1) Deploy ChainResolver(owner)
    const owner = wallet.address;
    section('Deploy');
    log('owner', owner);
    const { target: resolverAddr } = await smith.deploy({
      from: wallet,
      file: 'ChainResolver.sol',
      args: [owner],
      save: false,
    });
    log('resolver', resolverAddr);

    const resolver = new Contract(
      resolverAddr,
      [
        'function register(string,address,bytes) external',
        'function chainId(bytes32) view returns (bytes)',
        'function chainName(bytes) view returns (string)',
        'function setAddr(bytes32,uint256,address) external',
        'function resolve(bytes,bytes) view returns (bytes)',
      ],
      wallet
    );

    // Test data
    const label = 'optimism';
    const LABEL_HASH = keccak256(toUtf8Bytes(label));
    const CHAIN_ID_HEX = '0x000000010001010a00';
    const CHAIN_ID = getBytes(CHAIN_ID_HEX);
    section('Inputs');
    log('label', label);
    log('labelHash', LABEL_HASH);
    log('chainId (hex)', CHAIN_ID_HEX);

    // 2) Register name -> chainId (owner-only)
    section('Register');
    log('tx register(label, owner, chainId)');
    const tx = await resolver.register(label, owner, CHAIN_ID);
    await tx.wait();
    log('tx hash', tx.hash);

    // 3) Set an ETH address record
    section('Set Records');
    const txAddr = await resolver.setAddr(LABEL_HASH, 60, owner);
    await txAddr.wait();

    // Prepare names and interfaces for reverse-only debugging
    const ensName = `${label}.cid.eth`;
    const dnsName = dnsEncode(ensName, 255);
    const IFACE = new Interface(['function text(bytes32,string) view returns (string)']);
    const call = IFACE.encodeFunctionData('text(bytes32,string)', [LABEL_HASH, 'chain-id']);
    section('Forward Resolve');
    log('ensName', ensName);
    const answer: string = await resolver.resolve(dnsName, call);
    const [chainIdHex] = IFACE.decodeFunctionResult('text(bytes32,string)', answer);
    log('resolved chain-id (hex, no 0x)', chainIdHex);
    if (chainIdHex !== CHAIN_ID_HEX.replace(/^0x/, '')) {
      throw new Error(`Unexpected chain-id hex: ${chainIdHex}`);
    }

    // 5a) Reverse via text selector: text(..., 'chain-name:<7930-hex>')
    const TIFACE = new Interface(['function text(bytes32,string) view returns (string)']);
    const RIFACE = new Interface(['function data(bytes32,string) view returns (bytes)']);
    // Build key as 'chain-name:' + raw 7930 bytes (encoded as a JS latin1 string)
    const keyStr = Buffer.concat([
      Buffer.from('chain-name:', 'utf8'),
      Buffer.from(CHAIN_ID)
    ]).toString('latin1');

    section('Reverse Resolve (text)');
    const tcall = TIFACE.encodeFunctionData('text(bytes32,string)', [LABEL_HASH, keyStr]);
    const tanswer: string = await resolver.resolve(dnsName, tcall);
    let textName = '';
    try {
      [textName] = TIFACE.decodeFunctionResult('text(bytes32,string)', tanswer);
    } catch (e) {
      // ignore; keep empty on decode error
    }
    log('text resolved name', textName);

    // 5b) Reverse via data selector: data(..., 'chain-name:<7930-hex>')
    section('Reverse Resolve (data)');
    const rcall = RIFACE.encodeFunctionData('data(bytes32,string)', ['0x' + '0'.repeat(64), keyStr]);
    const ranswer: string = await resolver.resolve(dnsName, rcall);
    const [encoded] = RIFACE.decodeFunctionResult('data(bytes32,string)', ranswer);
    let dataName: string;
    try {
      [dataName] = AbiCoder.defaultAbiCoder().decode(['string'], encoded);
    } catch {
      dataName = Buffer.from((encoded as string).replace(/^0x/, ''), 'hex').toString('utf8');
    }
    log('data resolved name', dataName);

    // 5c) Direct read for comparison
    section('Reverse Resolve (direct)');
    const direct = await resolver.chainName(CHAIN_ID);
    log('chainName(bytes)', direct);

    // Final assertion
    const picked = textName || dataName || direct;
    if (picked !== label) throw new Error(`Unexpected reverse name: ${picked}`);

    // 6) Direct reads
    section('Direct Reads');
    const cid = await resolver.chainId(LABEL_HASH);
    log('chainId(bytes)', hex(cid));
    const cname = await resolver.chainName(cid);
    log('chainName(bytes)', cname);
    if (hexlify(cid) !== CHAIN_ID_HEX) throw new Error('chainId() mismatch');
    if (cname !== label) throw new Error('chainName() mismatch');

    console.log('✓ Blocksmith test passed');
  } catch (e) {
    console.error(e);
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
