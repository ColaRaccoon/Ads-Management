const url=new URL(process.env.DATABASE_URL);
console.log(JSON.stringify({sslmode:url.searchParams.get('sslmode'),sslaccept:url.searchParams.get('sslaccept'),
  sslrootcertConfigured:url.searchParams.has('sslrootcert'),sslcertConfigured:url.searchParams.has('sslcert'),
  hostname:url.hostname,port:url.port,connectionLimit:process.env.PRISMA_CONNECTION_LIMIT,idleDisconnectMs:process.env.PRISMA_IDLE_DISCONNECT_MS}));
