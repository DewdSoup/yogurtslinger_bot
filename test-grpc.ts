import * as YellowstoneGrpc from "@triton-one/yellowstone-grpc";

async function main() {
  console.log("Yellowstone exports:", Object.keys(YellowstoneGrpc));
  console.log("Default type:", typeof YellowstoneGrpc.default);
  console.log("Default keys:", Object.keys(YellowstoneGrpc.default));
  
  // The Client is likely inside default
  const mod = YellowstoneGrpc.default as any;
  console.log("Looking for Client...");
  
  // Try different paths
  const Client = mod.Client || mod.default || mod;
  console.log("Client candidate:", typeof Client, Client?.name);
  
  if (typeof Client === 'function') {
    try {
      const client = new Client("http://127.0.0.1:10000", undefined, undefined);
      console.log("Client created successfully!");
      
      const stream = await client.subscribe();
      console.log("Stream opened!");
      
      stream.on("data", (data: any) => {
        const keys = Object.keys(data).filter(k => data[k]);
        console.log("Received:", keys);
      });
      
      stream.on("error", (err: any) => {
        console.log("Stream error:", err.message);
      });
      
      console.log("Waiting 10s for data...");
      await new Promise(r => setTimeout(r, 10000));
      stream.end();
    } catch (e: any) {
      console.log("Error:", e.message);
    }
  }
  
  process.exit(0);
}

main();
