// Force safe local-only unit regressions even if a future test accidentally
// calls a default provider transport instead of its dependency-injected mock.
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
    const host = first.host ?? 'localhost';
    if (first.path || !['localhost','127.0.0.1','::1'].includes(host)) throw Error('PHASE10_EXTERNAL_NETWORK_FORBIDDEN');
  } else if (typeof first === 'string' || (typeof args[1] === 'string' && !['localhost','127.0.0.1','::1'].includes(args[1]))) {
    throw Error('PHASE10_EXTERNAL_NETWORK_FORBIDDEN');
  }
  return originalConnect.apply(this,args);
};
