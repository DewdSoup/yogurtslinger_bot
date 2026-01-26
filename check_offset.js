const { Connection, PublicKey } = require('@solana/web3.js');
(async () => {
    const conn = new Connection('https://mainnet.helius-rpc.com/?api-key=2bb675f2-573f-4561-b57f-d351db310e5a');
    const pool = new PublicKey('5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6');
    const info = await conn.getAccountInfo(pool);
    if (!info) { console.log('Pool not found'); return; }
    console.log('Offset 24 (u16):', info.data.readUInt16LE(24));
    console.log('Offset 32 (u16):', info.data.readUInt16LE(32));
})();
