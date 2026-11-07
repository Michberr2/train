import assert from 'node:assert/strict'
import {publicAddress,resolvePublicTarget} from '../services/browser-host/proxy.mjs'
for(const ip of ['142.251.156.119','2001:4860:482b:7700::','2620:0:861:ed1a::1'])assert.equal(publicAddress(ip),true,ip)
for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001::1','2001:20::1','2001:db8::1','2002:7f00:1::1','3fff::1'])assert.equal(publicAddress(ip),false,ip)
const ipv4={address:'142.251.156.119',family:4},ipv6={address:'2001:4860:482b:7700::',family:6}
assert.deepEqual(await resolvePublicTarget('www.google.com',443,async()=>[ipv6,ipv4]),ipv4)
for(const answers of [[],[ipv4,{address:'127.0.0.1',family:4}],[ipv4,{address:'::1',family:6}]])await assert.rejects(resolvePublicTarget('example.com',443,async()=>answers),/denied/)
for(const [host,port] of [['localhost',443],['service.internal',443],['example.com',22]])await assert.rejects(resolvePublicTarget(host,port,async()=>[ipv4]),/denied/)
console.log('PASS public Google IPv6 accepted, reachable IPv4 preferred, private/mixed DNS and disallowed destinations rejected')
