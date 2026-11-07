import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns/promises'
export function publicAddress(ip) {
  if (net.isIP(ip) === 4) {
    const [a,b,c] = ip.split('.').map(Number)
    return !(a===0 || a===10 || a===127 || a>=224 || a===169&&b===254 || a===172&&b>=16&&b<=31 || a===192&&(b===168 || b===0 || b===2) || a===100&&b>=64&&b<=127 || a===198&&(b===18||b===19||b===51&&c===100) || a===203&&b===0&&c===113)
  }
  // Only global unicast IPv6. IPv4-mapped, loopback, link-local, ULA and
  // transition/documentation ranges are denied rather than normalized.
  if (net.isIP(ip)!==6 || !/^[23][0-9a-f]{3}:/i.test(ip)) return false
  const [prefix, subnet] = ip.split(':').map(part => parseInt(part || '0',16))
  // 2001::/23 contains special-purpose allocations; 2001:db8::/32 is
  // documentation. Ordinary public 2001 addresses (including Google) are valid.
  return !(prefix===0x2001 && (subnet<0x200 || subnet===0xdb8) || prefix===0x2002 || prefix===0x3fff)
}
export async function resolvePublicTarget(host, port, lookup=dns.lookup) {
  if (![80,443].includes(port) || !host || /localhost|\.local$|\.internal$/i.test(host)) throw Error('Destination denied')
  const answers=await lookup(host,{all:true})
  if (!answers.length || answers.some(a=>!publicAddress(a.address))) throw Error('Destination denied')
  // Hosted machines currently have IPv4 egress, but no IPv6 route.
  return answers.find(answer=>answer.family===4) || answers[0]
}
export function startProxy(port=8878) {
  const proxy=http.createServer(async(req,res)=>{
    try {
      const u=new URL(req.url);if(u.protocol!=='http:' || u.username || u.password)throw Error('Denied')
      const found=await resolvePublicTarget(u.hostname,Number(u.port)||80)
      const headers={...req.headers,host:u.host};delete headers['proxy-authorization'];delete headers['proxy-connection']
      const upstream=http.request({hostname:found.address,family:found.family,port:Number(u.port)||80,path:u.pathname+u.search,method:req.method,headers,timeout:25000},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)})
      upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()});req.pipe(upstream)
    }catch{res.writeHead(403);res.end('Destination unavailable')}
  })
  proxy.on('connect',async(req,socket,head)=>{
    // Clients can disconnect while DNS is pending, before an upstream exists.
    socket.on('error',()=>socket.destroy())
    try {
      const u=new URL('http://'+req.url);const port=Number(u.port)||443;const found=await resolvePublicTarget(u.hostname.replace(/^\[|\]$/g,''),port)
      const upstream=net.connect({host:found.address,port,family:found.family},()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket)})
      upstream.setTimeout(120000,()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy())
    }catch{socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')}
  })
  return new Promise(resolve=>proxy.listen(port,'127.0.0.1',()=>resolve(proxy)))
}
