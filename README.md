# fibjs-nats
nats-client nats客户端实现  

 * 暂不支持ssl&jwt&wss&nkey    
 * msgpack需要fibjsv0.30+    
 * bug->https://github.com/lhkzh/fibjs-nats   
 * fibjs->https://fibjs.org    
 使用  
<pre>
<code>
 const Nats = require("fibjs-nats").Nats;  
 //无授权认证方式
 var nc = Nats.make({json:true,url:"nats://127.0.0.1:4222"});  
 //通过-username:password认证
 var nc_auth_userpassword = Nats.make({json:true,url:"nats://myusername:mypassword@127.0.0.1:4222"});  
 //通过-authtoken认证
 var nc_auth_token = Nats.make({json:true,url:"nats://mytoken@127.0.0.1:4222"});  
 //通过websockt接入  
 var nc_by_ws = Nats.make({json:true,url:"ws://127.0.0.1:8022"});    
 //多cluster接入    
 var nc = Nats.make({json:true,servers:["nats://127.0.0.1:4222","nats://127.0.0.1:4223","ws://127.0.0.1:8022"]});     
  
 nc.subscribe("svr.sum",function (data,meta) {  
     meta.reply(data.a+data.b);  
 });      
 console.log(nc.request("svr.sum",{a:2,b:3})==5)      
 
 nc.subscribe("svr.log",function (data,meta) {  
     console.log("svr.log",data);
 });  
 nc.publish("svr.log", "on xxx");    
 console.log(nc.ping())
</code>
</pre> 

 
 